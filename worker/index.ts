import { DurableObject } from "cloudflare:workers";
import type { BoardData, ColumnId, KanbanCard } from "../shared/board";

const STORE_KEY = "board";
const BOARD_OBJECT_KEY = "board.json";
const MAX_BOARD_BYTES = 250_000;
const ALLOWED_COLUMNS = new Set<ColumnId>(["backlog", "doing", "done"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CloudflareSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
};

function defaultBoard(): BoardData {
  const now = new Date().toISOString();

  return {
    cards: [
      {
        id: crypto.randomUUID(),
        title: "Shape the next idea",
        description: "Capture the outcome, then break it into a small first step.",
        tags: ["Idea"],
        column: "backlog",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        title: "Make the board yours",
        description: "Open any card to edit its notes, tags, and column.",
        tags: ["High", "Setup"],
        column: "doing",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        title: "Create a simple workflow",
        description: "Drag cards between columns as work moves forward.",
        tags: ["Done"],
        column: "done",
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function sanitizeCard(value: unknown): KanbanCard | null {
  if (!value || typeof value !== "object") return null;

  const candidate = value as Partial<KanbanCard>;
  const title = cleanText(candidate.title, 120);
  const column = candidate.column;

  if (!title || !column || !ALLOWED_COLUMNS.has(column)) return null;

  const now = new Date().toISOString();
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags
        .map((tag) => cleanText(tag, 24))
        .filter(Boolean)
        .filter((tag, index, all) => all.indexOf(tag) === index)
        .slice(0, 8)
    : [];

  return {
    id: cleanText(candidate.id, 64) || crypto.randomUUID(),
    title,
    description: cleanText(candidate.description, 5000),
    tags,
    column,
    createdAt: cleanText(candidate.createdAt, 32) || now,
    updatedAt: cleanText(candidate.updatedAt, 32) || now,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

function notFound(): Response {
  return new Response("Not found.", {
    status: 404,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

async function secretsMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  // TypeScript's DOM library omits this Cloudflare runtime extension.
  const subtle = crypto.subtle as CloudflareSubtleCrypto;
  const [providedHash, expectedHash] = await Promise.all([
    subtle.digest("SHA-256", encoder.encode(provided)),
    subtle.digest("SHA-256", encoder.encode(expected)),
  ]);

  return subtle.timingSafeEqual(providedHash, expectedHash);
}

function withPrivateAppHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isLocalViteRequest(url: URL): boolean {
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!localHosts.has(url.hostname)) return false;

  return ["/@vite/", "/@id/", "/node_modules/", "/src/", "/shared/"].some((prefix) =>
    url.pathname.startsWith(prefix),
  ) || url.pathname === "/@react-refresh";
}

function serializeBoard(board: BoardData): string {
  return `${JSON.stringify(board, null, 2)}\n`;
}

async function storeBoard(bucket: R2Bucket, board: BoardData): Promise<void> {
  await bucket.put(BOARD_OBJECT_KEY, serializeBoard(board), {
    httpMetadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "no-store",
    },
    customMetadata: {
      updatedAt: new Date().toISOString(),
    },
  });
}

async function handleBoardRequest(request: Request, bucket: R2Bucket): Promise<Response> {
  if (request.method === "GET") {
    const object = await bucket.get(BOARD_OBJECT_KEY);

    if (!object) {
      const board = defaultBoard();
      await storeBoard(bucket, board);
      return json(board);
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    headers.set("etag", object.httpEtag);
    return new Response(object.body, { headers });
  }

  if (request.method === "PUT") {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BOARD_BYTES) {
      return json({ error: "Board data is too large." }, { status: 413 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON." }, { status: 400 });
    }

    const cards =
      payload && typeof payload === "object" && Array.isArray((payload as BoardData).cards)
        ? (payload as BoardData).cards.map(sanitizeCard)
        : null;

    if (!cards || cards.some((card) => card === null) || cards.length > 500) {
      return json({ error: "Invalid board data." }, { status: 400 });
    }

    const board: BoardData = { cards: cards as KanbanCard[] };
    if (new TextEncoder().encode(serializeBoard(board)).byteLength > MAX_BOARD_BYTES) {
      return json({ error: "Board data is too large." }, { status: 413 });
    }

    await storeBoard(bucket, board);
    return json(board);
  }

  return json({ error: "Method not allowed." }, { status: 405, headers: { allow: "GET, PUT" } });
}

// Kept temporarily so the previous Durable Object data remains available for rollback.
export class KanbanBoard extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      let board = await this.ctx.storage.get<BoardData>(STORE_KEY);

      if (!board) {
        board = defaultBoard();
        await this.ctx.storage.put(STORE_KEY, board);
      }

      return json(board);
    }

    if (request.method === "PUT") {
      const contentLength = Number(request.headers.get("content-length") || 0);
      if (contentLength > 250_000) {
        return json({ error: "Board data is too large." }, { status: 413 });
      }

      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "Invalid JSON." }, { status: 400 });
      }

      const cards =
        payload && typeof payload === "object" && Array.isArray((payload as BoardData).cards)
          ? (payload as BoardData).cards.map(sanitizeCard)
          : null;

      if (!cards || cards.some((card) => card === null) || cards.length > 500) {
        return json({ error: "Invalid board data." }, { status: 400 });
      }

      const board: BoardData = { cards: cards as KanbanCard[] };
      await this.ctx.storage.put(STORE_KEY, board);
      return json(board);
    }

    return json({ error: "Method not allowed." }, { status: 405, headers: { allow: "GET, PUT" } });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // Vite emits root-relative module URLs in development even with a relative production base.
    if (isLocalViteRequest(url)) {
      return env.ASSETS.fetch(request);
    }

    const boardUuid = typeof env.BOARD_UUID === "string" ? env.BOARD_UUID.trim() : "";

    if (!UUID_PATTERN.test(boardUuid)) {
      return json({ error: "Server configuration error." }, { status: 500 });
    }

    const [, providedUuid = "", ...pathParts] = url.pathname.split("/");
    if (!(await secretsMatch(providedUuid, boardUuid))) {
      return notFound();
    }

    const appPath = `/${pathParts.join("/")}`;

    if (appPath === "/" && !url.pathname.endsWith("/")) {
      url.pathname = `/${providedUuid}/`;
      return Response.redirect(url.toString(), 308);
    }

    if (appPath === "/api/board") {
      return handleBoardRequest(request, env.BOARD_DATA);
    }

    if (appPath.startsWith("/api/")) {
      return json({ error: "Not found." }, { status: 404 });
    }

    const assetUrl = new URL(request.url);
    assetUrl.pathname = appPath;
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    return withPrivateAppHeaders(response);
  },
} satisfies ExportedHandler<Env>;
