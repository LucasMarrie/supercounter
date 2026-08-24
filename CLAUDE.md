# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install dependencies: `npm install`
- Run the server: `npm start` (or `node server.js`) — serves on `http://localhost:3000` (override with `PORT` env var)
- Requires `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` env vars (a free Upstash Redis database) — set them in a local `.env` file for development, loaded via `dotenv`.
- No build step, no test suite, no linter configured.

## Architecture

This is a global counter app: the count lives only on the server, and every client sees updates in real time over a single shared WebSocket connection (no polling, no per-client state).

- **`server.js`** — Express serves the static `public/` folder; a `ws` `WebSocketServer` is attached to the same HTTP server. The counter value is persisted in an Upstash Redis database under the key `supercounter:count` (via `@upstash/redis`'s REST client, `Redis.fromEnv()`), cached in a module-level `count` variable for fast reads on new connections. `redis.incr()` is the source of truth on increment — atomic, so it's safe even with multiple server instances. There is no REST API — the increment action and the broadcast both go through WebSocket messages.
- **WebSocket protocol** (JSON messages):
  - Server → client on connect: `{type: 'init', count}`
  - Client → server on button click: `{type: 'increment'}`
  - Server → all clients after handling an increment: `{type: 'update', count}` (via `broadcast()`, which iterates `wss.clients`)
- **`public/client.js`** — owns the WebSocket lifecycle: connects, reconnects with increasing backoff (capped at 10s) on close/error, and disables the increment button while disconnected. Distinguishes `init` (set count silently) from `update` (set count + retrigger the glow animation). Derives `ws:`/`wss:` from `location.protocol`, so it works unmodified behind TLS in production.
- **`public/style.css`** — the counter number's "lava" glow on update is a CSS `@keyframes` animation (`lavaPulse`) applied via a `.lava` class. Because re-adding the same class doesn't restart a CSS animation, `client.js` removes the class, forces a reflow (`void counterEl.offsetWidth`), then re-adds it — this is required for consecutive rapid increments to each retrigger the glow.

## Deployment

Deploys to [Render](https://render.com) via `render.yaml` (a Blueprint: free web service, no persistent disk needed since state lives in Upstash Redis). Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` as secret env vars in the Render dashboard (they're marked `sync: false` in the blueprint, so Render prompts for them rather than storing values in git).
