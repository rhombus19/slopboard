# Slopboard

A small personal kanban board built with React, Vite, shadcn-style UI components, and Cloudflare Workers. The complete board is persisted as one `board.json` object in Cloudflare R2.

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

Behind the secret URL prefix, the Worker exposes `GET /api/board` and `PUT /api/board`. A board is a small JSON document:

```json
{
  "cards": [
    {
      "id": "...",
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

This intentionally targets a single personal board. Add authentication and separate Durable Object names before using it for multiple users.
