import { DurableObject } from "cloudflare:workers";
import {
  COLUMNS,
  COMPLETED_COLUMN,
  placeCardInColumn,
  type BoardColumnId,
  type BoardData,
  type BoardOperation,
  type BoardUpdatedEvent,
  type CardFields,
  type ColumnId,
  type KanbanCard,
} from "../shared/board";

const BOARD_OBJECT_KEY = "board.json";
const MAX_BOARD_BYTES = 250_000;
const MAX_CARDS = 500;
const MAX_WRITE_ATTEMPTS = 5;
const ALLOWED_COLUMNS = new Set<unknown>([...COLUMNS, COMPLETED_COLUMN]);
const BOARD_COLUMNS = new Set<unknown>(COLUMNS);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CloudflareSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
};

interface StoredBoardResult {
  board: BoardData;
  needsMigration: boolean;
}

interface InternalBoardSnapshot {
  board: BoardData;
  etag: string;
  httpEtag: string;
}

export interface BoardSnapshotResult {
  board: BoardData;
  etag: string;
}

export type ApplyOperationResult =
  | {
      status: "applied" | "unchanged";
      board: BoardData;
      etag: string;
    }
  | {
      status: "conflict" | "too-large";
      board: BoardData;
      etag: string;
      error: string;
    };

type OperationApplication =
  | { status: "changed"; board: BoardData }
  | { status: "unchanged"; board: BoardData }
  | { status: "conflict"; error: string };

function defaultBoard(): BoardData {
  const now = new Date().toISOString();

  return {
    revision: 1,
    cards: [
      {
        id: crypto.randomUUID(),
        version: 1,
        title: "Shape the next idea",
        description: "Capture the outcome, then break it into a small first step.",
        tags: ["Idea"],
        column: "backlog",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        version: 1,
        title: "Make the board yours",
        description: "Open any card to edit its notes, tags, and column.",
        tags: ["High", "Setup"],
        column: "doing",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: crypto.randomUUID(),
        version: 1,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function isColumn(value: unknown): value is ColumnId {
  return ALLOWED_COLUMNS.has(value);
}

function isBoardColumn(value: unknown): value is BoardColumnId {
  return BOARD_COLUMNS.has(value);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function sanitizeTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;

  return value
    .map((tag) => cleanText(tag, 24))
    .filter(Boolean)
    .filter((tag, index, all) => all.indexOf(tag) === index)
    .slice(0, 8);
}

function sanitizeFields(value: unknown): CardFields | null {
  if (!isRecord(value)) return null;

  const title = cleanText(value.title, 120);
  const description = cleanText(value.description, 5000);
  const tags = sanitizeTags(value.tags);
  const column = value.column;

  if (!title || !tags || !isColumn(column)) return null;

  return { title, description, tags, column };
}

function sanitizeStoredCard(value: unknown): KanbanCard | null {
  if (!isRecord(value)) return null;

  const id = cleanText(value.id, 64);
  const fields = sanitizeFields(value);
  const version = positiveInteger(value.version) ?? 1;
  const createdAt = cleanText(value.createdAt, 32);
  const updatedAt = cleanText(value.updatedAt, 32);
  const completedFrom = isBoardColumn(value.completedFrom) ? value.completedFrom : undefined;

  if (!id || !fields) return null;

  const now = new Date().toISOString();
  return {
    id,
    version,
    ...fields,
    ...(fields.column === COMPLETED_COLUMN && completedFrom ? { completedFrom } : {}),
    createdAt: createdAt || now,
    updatedAt: updatedAt || now,
  };
}

function sanitizeStoredBoard(value: unknown): StoredBoardResult | null {
  if (!isRecord(value) || !Array.isArray(value.cards) || value.cards.length > MAX_CARDS) return null;

  const sanitizedCards: KanbanCard[] = [];
  for (const valueCard of value.cards) {
    const card = sanitizeStoredCard(valueCard);
    if (!card) return null;
    sanitizedCards.push(card);
  }

  if (new Set(sanitizedCards.map((card) => card.id)).size !== sanitizedCards.length) return null;

  const revision = positiveInteger(value.revision) ?? 1;
  const needsMigration = positiveInteger(value.revision) === null
    || value.cards.some((card) => !isRecord(card) || positiveInteger(card.version) === null);

  return {
    board: { revision, cards: sanitizedCards },
    needsMigration,
  };
}

function parseOperation(value: unknown): BoardOperation | null {
  if (!isRecord(value)) return null;

  const operationId = cleanText(value.operationId, 64);
  const cardId = cleanText(value.cardId, 64);
  if (!operationId || !cardId) return null;

  switch (value.type) {
    case "create-card": {
      const fields = sanitizeFields(value.fields);
      return fields ? { type: value.type, operationId, cardId, fields } : null;
    }
    case "update-card": {
      const fields = sanitizeFields(value.fields);
      const expectedVersion = positiveInteger(value.expectedVersion);
      return fields && expectedVersion
        ? { type: value.type, operationId, cardId, expectedVersion, fields }
        : null;
    }
    case "delete-card": {
      const expectedVersion = positiveInteger(value.expectedVersion);
      return expectedVersion ? { type: value.type, operationId, cardId, expectedVersion } : null;
    }
    case "move-card":
      return isColumn(value.column)
        ? { type: value.type, operationId, cardId, column: value.column }
        : null;
    case "reorder-card": {
      if (!isColumn(value.column) || (value.beforeCardId !== null && typeof value.beforeCardId !== "string")) {
        return null;
      }
      const beforeCardId = value.beforeCardId === null ? null : cleanText(value.beforeCardId, 64);
      return beforeCardId !== "" && beforeCardId !== cardId
        ? { type: value.type, operationId, cardId, column: value.column, beforeCardId }
        : null;
    }
    case "set-card-completed":
      return typeof value.completed === "boolean"
        ? { type: value.type, operationId, cardId, completed: value.completed }
        : null;
    default:
      return null;
  }
}

function fieldsMatch(card: KanbanCard, fields: CardFields): boolean {
  return card.title === fields.title
    && card.description === fields.description
    && card.column === fields.column
    && card.tags.length === fields.tags.length
    && card.tags.every((tag, index) => tag === fields.tags[index]);
}

function nextCardVersion(card: KanbanCard): number {
  if (card.version === Number.MAX_SAFE_INTEGER) throw new Error("Card version limit reached.");
  return card.version + 1;
}

function nextBoardRevision(board: BoardData): number {
  if (board.revision === Number.MAX_SAFE_INTEGER) throw new Error("Board revision limit reached.");
  return board.revision + 1;
}

function moveCardToColumn(card: KanbanCard, column: ColumnId, now: string): KanbanCard {
  if (card.column === column) return card;

  if (column === COMPLETED_COLUMN) {
    return {
      ...card,
      version: nextCardVersion(card),
      column,
      completedFrom: card.column === COMPLETED_COLUMN ? card.completedFrom ?? "done" : card.column,
      updatedAt: now,
    };
  }

  return {
    ...card,
    version: nextCardVersion(card),
    column,
    completedFrom: undefined,
    updatedAt: now,
  };
}

function withChangedCard(board: BoardData, card: KanbanCard): BoardData {
  return {
    revision: nextBoardRevision(board),
    cards: board.cards.map((current) => (current.id === card.id ? card : current)),
  };
}

function applyOperation(board: BoardData, operation: BoardOperation): OperationApplication {
  const current = board.cards.find((card) => card.id === operation.cardId);
  const now = new Date().toISOString();

  switch (operation.type) {
    case "create-card": {
      if (current) {
        return fieldsMatch(current, operation.fields)
          ? { status: "unchanged", board }
          : { status: "conflict", error: "A different card already uses this ID." };
      }

      if (board.cards.length >= MAX_CARDS) {
        return { status: "conflict", error: "The board cannot contain more than 500 cards." };
      }

      const card: KanbanCard = {
        id: operation.cardId,
        version: 1,
        ...operation.fields,
        ...(operation.fields.column === COMPLETED_COLUMN ? { completedFrom: "backlog" as const } : {}),
        createdAt: now,
        updatedAt: now,
      };

      return {
        status: "changed",
        board: {
          revision: nextBoardRevision(board),
          cards: placeCardInColumn(
            board.cards,
            card,
            board.cards.find((currentCard) => currentCard.column === card.column)?.id ?? null,
          ) ?? board.cards,
        },
      };
    }

    case "update-card": {
      if (!current) {
        return { status: "conflict", error: "This card was deleted by someone else." };
      }

      if (fieldsMatch(current, operation.fields)) return { status: "unchanged", board };
      if (current.version !== operation.expectedVersion) {
        return { status: "conflict", error: "This card changed while you were editing it." };
      }

      const moved = moveCardToColumn(current, operation.fields.column, now);
      const updated: KanbanCard = {
        ...moved,
        title: operation.fields.title,
        description: operation.fields.description,
        tags: operation.fields.tags,
        version: nextCardVersion(current),
        updatedAt: now,
      };

      return { status: "changed", board: withChangedCard(board, updated) };
    }

    case "delete-card":
      if (!current) return { status: "unchanged", board };
      if (current.version !== operation.expectedVersion) {
        return { status: "conflict", error: "This card changed before it could be deleted." };
      }
      return {
        status: "changed",
        board: {
          revision: nextBoardRevision(board),
          cards: board.cards.filter((card) => card.id !== operation.cardId),
        },
      };

    case "move-card": {
      if (!current) {
        return { status: "conflict", error: "This card was deleted by someone else." };
      }
      const moved = moveCardToColumn(current, operation.column, now);
      return moved === current
        ? { status: "unchanged", board }
        : { status: "changed", board: withChangedCard(board, moved) };
    }

    case "reorder-card": {
      if (!current) {
        return { status: "conflict", error: "This card was deleted by someone else." };
      }

      if (operation.beforeCardId) {
        const beforeCard = board.cards.find((card) => card.id === operation.beforeCardId);
        if (!beforeCard || beforeCard.column !== operation.column) {
          return { status: "conflict", error: "The card order changed before your move could be saved." };
        }
      }

      const moved = moveCardToColumn(current, operation.column, now);
      const cards = placeCardInColumn(board.cards, moved, operation.beforeCardId);
      if (!cards) {
        return { status: "conflict", error: "The card order changed before your move could be saved." };
      }

      const orderChanged = cards.some((card, index) => card.id !== board.cards[index]?.id);
      if (moved === current && !orderChanged) return { status: "unchanged", board };

      return {
        status: "changed",
        board: {
          revision: nextBoardRevision(board),
          cards,
        },
      };
    }

    case "set-card-completed": {
      if (!current) {
        return { status: "conflict", error: "This card was deleted by someone else." };
      }

      const target = operation.completed
        ? COMPLETED_COLUMN
        : current.column === COMPLETED_COLUMN
          ? current.completedFrom ?? "done"
          : current.column;
      const moved = moveCardToColumn(current, target, now);
      return moved === current
        ? { status: "unchanged", board }
        : { status: "changed", board: withChangedCard(board, moved) };
    }
  }
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
    webSocket: response.webSocket,
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

function boardByteLength(board: BoardData): number {
  return new TextEncoder().encode(serializeBoard(board)).byteLength;
}

function structuredError(message: string, error: unknown, data: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    message,
    error: error instanceof Error ? error.message : String(error),
    ...data,
  }));
}

export class KanbanBoard extends DurableObject<Env> {
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(task);
    this.requestQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async storeBoard(board: BoardData, etag: string | null): Promise<R2Object | null> {
    if (boardByteLength(board) > MAX_BOARD_BYTES) throw new Error("Board data is too large.");

    const onlyIf: R2Conditional | Headers = etag
      ? { etagMatches: etag }
      : new Headers({ "if-none-match": "*" });

    return this.env.BOARD_DATA.put(BOARD_OBJECT_KEY, serializeBoard(board), {
      onlyIf,
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
        cacheControl: "no-store",
      },
      customMetadata: {
        updatedAt: new Date().toISOString(),
      },
    });
  }

  private async readBoard(): Promise<InternalBoardSnapshot> {
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const object = await this.env.BOARD_DATA.get(BOARD_OBJECT_KEY);

      if (!object) {
        const board = defaultBoard();
        const stored = await this.storeBoard(board, null);
        if (stored) return { board, etag: stored.etag, httpEtag: stored.httpEtag };
        continue;
      }

      const payload = await object.json<unknown>();
      const sanitized = sanitizeStoredBoard(payload);
      if (!sanitized) throw new Error("Stored board data is invalid.");

      if (sanitized.needsMigration) {
        const migrated = await this.storeBoard(sanitized.board, object.etag);
        if (migrated) {
          return { board: sanitized.board, etag: migrated.etag, httpEtag: migrated.httpEtag };
        }
        continue;
      }

      return { board: sanitized.board, etag: object.etag, httpEtag: object.httpEtag };
    }

    throw new Error("The board changed too many times. Please retry.");
  }

  private broadcast(board: BoardData, operationId?: string): void {
    const event: BoardUpdatedEvent = { type: "board-updated", operationId, board };
    const message = JSON.stringify(event);

    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch (error) {
        structuredError("WebSocket broadcast failed", error);
        try {
          socket.close(1011, "Board update could not be delivered.");
        } catch {
          // The socket is already closed.
        }
      }
    }
  }

  async getBoard(): Promise<BoardSnapshotResult> {
    return this.enqueue(async () => {
      const snapshot = await this.readBoard();
      return { board: snapshot.board, etag: snapshot.httpEtag };
    });
  }

  async applyOperation(operation: BoardOperation): Promise<ApplyOperationResult> {
    return this.enqueue(async () => {
      for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
        const snapshot = await this.readBoard();
        const application = applyOperation(snapshot.board, operation);

        if (application.status === "conflict") {
          return {
            status: "conflict",
            board: snapshot.board,
            etag: snapshot.httpEtag,
            error: application.error,
          };
        }

        if (application.status === "unchanged") {
          return { status: "unchanged", board: snapshot.board, etag: snapshot.httpEtag };
        }

        if (boardByteLength(application.board) > MAX_BOARD_BYTES) {
          return {
            status: "too-large",
            board: snapshot.board,
            etag: snapshot.httpEtag,
            error: "Board data is too large.",
          };
        }

        const stored = await this.storeBoard(application.board, snapshot.etag);
        if (!stored) continue;

        this.broadcast(application.board, operation.operationId);
        return { status: "applied", board: application.board, etag: stored.httpEtag };
      }

      throw new Error("The board changed too many times. Please retry.");
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocket upgrade required." }, { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    try {
      const snapshot = await this.getBoard();
      const event: BoardUpdatedEvent = { type: "board-updated", board: snapshot.board };
      server.send(JSON.stringify(event));
    } catch (error) {
      structuredError("Initial WebSocket board load failed", error);
      server.close(1011, "Board state could not be loaded.");
      return json({ error: "Board state could not be loaded." }, { status: 503 });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") return;
    socket.send(JSON.stringify({ type: "error", error: "This connection only delivers board updates." }));
  }

  webSocketError(socket: WebSocket, error: unknown): void {
    structuredError("Board WebSocket error", error);
    try {
      socket.close(1011, "WebSocket error.");
    } catch {
      // The socket is already closed.
    }
  }
}

async function handleBoardRequest(request: Request, stub: DurableObjectStub<KanbanBoard>): Promise<Response> {
  if (request.method === "GET") {
    const snapshot = await stub.getBoard();
    const headers = new Headers({ etag: snapshot.etag });

    if (request.headers.get("if-none-match") === snapshot.etag) {
      headers.set("cache-control", "no-store");
      return new Response(null, { status: 304, headers });
    }

    return json(snapshot.board, { headers });
  }

  if (request.method === "POST") {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BOARD_BYTES) {
      return json({ error: "Board operation is too large." }, { status: 413 });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON." }, { status: 400 });
    }

    const operation = parseOperation(payload);
    if (!operation) return json({ error: "Invalid board operation." }, { status: 400 });

    const result = await stub.applyOperation(operation);
    const headers = new Headers({ etag: result.etag });

    if (result.status === "conflict") {
      return json({ error: result.error, board: result.board }, { status: 409, headers });
    }
    if (result.status === "too-large") {
      return json({ error: result.error, board: result.board }, { status: 413, headers });
    }

    return json(result.board, { headers });
  }

  if (request.method === "PUT") {
    return json(
      { error: "This client is out of date. Reload before making more changes." },
      { status: 409, headers: { allow: "GET, POST" } },
    );
  }

  return json({ error: "Method not allowed." }, { status: 405, headers: { allow: "GET, POST" } });
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

    const boardStub = env.KANBAN_BOARD.getByName(boardUuid);

    try {
      if (appPath === "/api/board/events") {
        if (request.method !== "GET") {
          return json({ error: "Method not allowed." }, { status: 405, headers: { allow: "GET" } });
        }
        return boardStub.fetch(request);
      }

      if (appPath === "/api/board") {
        return await handleBoardRequest(request, boardStub);
      }
    } catch (error) {
      structuredError("Board request failed", error, { method: request.method, path: appPath });
      return json({ error: "The board is temporarily unavailable." }, { status: 503 });
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
