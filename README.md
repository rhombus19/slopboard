# Slopboard

A small collaborative kanban board built with React, Vite, shadcn-style UI components, and Cloudflare Workers. The complete board is persisted as one inspectable `board.json` object in Cloudflare R2. A Durable Object coordinates card-level operations and broadcasts committed changes over hibernating WebSockets; it does not keep a second copy of the board in Durable Object storage.

The board is protected by a secret UUID in its URL. The Worker name is deliberately non-secret; every request must begin with `/<BOARD_UUID>/`, and requests without the correct UUID return `404`.

## Configure the secret URL

Copy `.env.example` to `.env`, generate a new UUID with `uuidgen`, and paste it as the `BOARD_UUID` value. `.env` is ignored by Git and must never be committed.

The UUID that was previously used as the Worker name is already present in Git history and must be considered compromised. Do not reuse it.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Cloudflare's Vite plugin runs both the React app and Worker API, and keeps local R2 state under `.wrangler/state`.

Append the secret UUID and a trailing slash to the local origin, for example:

```text
http://localhost:5173/<BOARD_UUID>/
```

## Deploy to Cloudflare

Authenticate once, then deploy:

```bash
npx wrangler login
npm run deploy
```

The R2 binding is declared in `wrangler.jsonc` and points to the private `paperboard-kanban-data` bucket. The deploy script builds first, then lets Wrangler automatically use the generated Worker manifest under `dist/slopboard`. That manifest includes the Worker entrypoint, R2 binding, and client assets.

`npm run deploy` uploads `BOARD_UUID` from the ignored `.env` file as an encrypted Cloudflare Worker secret. The deployed board URL is:

```text
https://slopboard.<your-workers-subdomain>.workers.dev/<BOARD_UUID>/
```

To rotate access, replace the value in `.env` with a fresh UUID and deploy again.

If you use Cloudflare Workers Builds, configure:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

Before using a Git-based Cloudflare build, add `BOARD_UUID` as an encrypted Worker secret in Cloudflare. Do not add it as a plain-text build variable.

Deploy this as a Worker, not as a Pages project and not by uploading `dist/client` alone. A static-only deployment can render the HTML while returning `404` for `/api/board` because it omits `worker/index.ts` and the R2 binding.

## Inspect the board JSON

In the Cloudflare dashboard, open **R2 object storage**, select the `paperboard-kanban-data` bucket, then download `board.json`. The bucket is private; the Worker reads and writes it through the `BOARD_DATA` binding.

## Data model

Behind the secret URL prefix, the Worker exposes:

- `GET /api/board` for the latest snapshot
- `POST /api/board` for card-level operations
- `GET /api/board/events` for the live WebSocket connection

The old full-board `PUT` API is deliberately rejected so a stale browser cannot replace newer work. A board remains a small JSON document:

```json
{
  "revision": 12,
  "cards": [
    {
      "id": "...",
      "version": 3,
      "title": "Ship the feature",
      "description": "Keep the scope small.",
      "tags": ["High", "Feature"],
      "column": "doing",
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

`revision` changes whenever the board changes, and each card has its own `version`. Content edits and deletes include the version the user started from, so simultaneous edits to the same card return a conflict instead of silently overwriting one another. Creates, moves, completion changes, and deletes are idempotent and can safely be retried after a network failure.

All reads and operations are routed to one `KanbanBoard` Durable Object for this board. The object queues R2 read-modify-write cycles, uses the current R2 ETag as a conditional-write guard, and only broadcasts a board after R2 confirms the write. Operations on different cards are therefore preserved even when they arrive together. If two users edit the same card, one succeeds and the other browser reopens its draft against the latest card version.

`column` is `backlog`, `ready`, `doing`, `done`, or `completed`. The four active columns represent captured work, the next sprint candidates, work in progress, and work finished in the current sprint. Completed cards may also include `completedFrom` so unchecking them returns them to their previous board column.

Everyone with the secret URL collaborates on the same board. The secret URL is still the only access control; add individual authentication if you need user identity, attribution, or access revocation per person. If the app later supports multiple boards, route each board ID to its own Durable Object name.
