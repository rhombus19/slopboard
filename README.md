# Paperboard

A small personal kanban board built with React, Vite, shadcn-style UI components, and Cloudflare Workers. The complete board is persisted as one `board.json` object in Cloudflare R2.

## Run locally

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. Cloudflare's Vite plugin runs both the React app and Worker API, and keeps local R2 state under `.wrangler/state`.

## Deploy to Cloudflare

Authenticate once, then deploy:

```bash
npx wrangler login
npm run deploy
```

The R2 binding is declared in `wrangler.jsonc` and points to the private `paperboard-kanban-data` bucket. The deploy script builds first, then lets Wrangler automatically use the generated Worker manifest under `dist/35fd3217_4c90_463e_9568_c104ac56f83a`. That manifest includes the Worker entrypoint, R2 binding, and client assets.

If you use Cloudflare Workers Builds, configure:

- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

Deploy this as a Worker, not as a Pages project and not by uploading `dist/client` alone. A static-only deployment can render the HTML while returning `404` for `/api/board` because it omits `worker/index.ts` and the R2 binding.

## Inspect the board JSON

In the Cloudflare dashboard, open **R2 object storage**, select the `paperboard-kanban-data` bucket, then download `board.json`. The bucket is private; the Worker reads and writes it through the `BOARD_DATA` binding.

## Data model

The Worker exposes `GET /api/board` and `PUT /api/board`. A board is a small JSON document:

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
