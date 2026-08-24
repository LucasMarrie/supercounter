# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install dependencies: `npm install`
- Run the server: `npm start` (or `node server.js`) — serves on `http://localhost:3000` (override with `PORT` env var)
- Requires `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` env vars (a free Upstash Redis database) — set them in a local `.env` file for development, loaded via `dotenv`.
- `RESET_PASSWORD` env var (optional) enables the corner reset control described below. If unset, reset requests are always denied.
- No build step, no test suite, no linter configured.

## Architecture

This is a global counter app: the count lives only on the server, and every client sees updates in real time over a single shared WebSocket connection (no polling, no per-client state).

- **`server.js`** — Express serves the static `public/` folder; a `ws` `WebSocketServer` is attached to the same HTTP server. The counter value is persisted in an Upstash Redis database under the key `supercounter:count` (via `@upstash/redis`'s REST client, `Redis.fromEnv()`), cached in a module-level `count` variable for fast reads on new connections. `redis.incr()` is the source of truth on increment — atomic, so it's safe even with multiple server instances. There is no REST API — the increment action and the broadcast both go through WebSocket messages.
- **WebSocket protocol** (JSON messages):
  - Server → client on connect: `{type: 'init', count}`
  - Client → server on button click: `{type: 'increment'}`
  - Server → all clients after handling an increment: `{type: 'update', count}` (via `broadcast()`, which iterates `wss.clients`)
- **`public/client.js`** — owns the WebSocket lifecycle: connects, reconnects with increasing backoff (capped at 10s) on close/error, and disables the increment button while disconnected. `init` and `update` both retrigger the glow animation via `setCount`. Derives `ws:`/`wss:` from `location.protocol`, so it works unmodified behind TLS in production.
- **Initial load placeholder** — the counter markup starts as an invisible (`opacity: 0`) `&nbsp;`, not empty and not `0` (which would misleadingly imply the real count is zero). The `&nbsp;` reserves the real line-box height immediately, so the box doesn't jump in height once real digits replace it — a genuinely empty element generates no line box at all. `setCount()` removes the `.placeholder` class on the first real value it receives, fading and width-animating it in.
- **`public/style.css`** — the counter number's "lava" glow on update is a CSS `@keyframes` animation (`lavaPulse`) applied via a `.lava` class. Because re-adding the same class doesn't restart a CSS animation, `client.js` removes the class, forces a reflow (`void counterEl.offsetWidth`), then re-adds it — this is required for consecutive rapid increments to each retrigger the glow. `animation-timing-function` is `linear`, not eased — an eased curve applies separately to *each* keyframe segment (0%→35%→70%→100%), so a strong ease-out there looks like discrete jump-then-freeze steps rather than one continuous motion.
- **Counter width animation** — `setCount()` in `client.js` measures the counter's pixel width before and after a value change (a FLIP-style transition) and animates the element's explicit `width` CSS property, rather than relying on `ch`-unit estimates (which undercount once `letter-spacing` is factored in). Widths are measured with `offsetWidth`, not `getBoundingClientRect()` — the latter reports the glow animation's `transform: scale()` if one is still mid-flight, which would corrupt the measurement. A `widthFloor` variable acts as a high-water mark: normal increments only ever grow the box; `setCount` detects a *decrease* purely by comparing `next` against the previously-displayed value and only then shrinks the box snugly to fit. This is entirely client-side — the server has no notion of resets vs. increments in its broadcast (`update` covers both).
- **Reset control** — a small icon in the top-right corner reveals a password field (`{type: 'reset', password}` over the same WebSocket). The server compares it against `RESET_PASSWORD` with `crypto.timingSafeEqual`; on match it sets the Redis counter to 0 and broadcasts `update` to everyone (so the reset is instantly visible to all connected clients, not just the one who triggered it). On mismatch it sends `{type: 'reset-denied'}` back to just that client, which reopens the form with an error indicator.
- **Optimistic increments** — `client.js` bumps `currentCount` and retriggers the glow immediately on click, before the server round-trip completes (increments go through a network call to Redis, not a local write). The authoritative `update` broadcast then confirms or corrects it; `setCount`'s `currentCount === next` guard skips a redundant re-animation when they already match. If the server's Redis call fails, it sends `{type: 'error'}` back to just that client, which decrements its local count by 1 to undo the optimistic bump.

## Deployment

Deploys to [Render](https://render.com) via `render.yaml` (a Blueprint: free web service, no persistent disk needed since state lives in Upstash Redis). Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` as secret env vars in the Render dashboard (they're marked `sync: false` in the blueprint, so Render prompts for them rather than storing values in git).
