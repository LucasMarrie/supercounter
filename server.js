require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Redis } = require('@upstash/redis');

const PORT = process.env.PORT || 3000;
const COUNTER_KEY = 'supercounter:count';
const RESET_PASSWORD = process.env.RESET_PASSWORD;

// increments/decrements mutate the in-memory count and broadcast immediately;
// the Redis write is debounced so a burst of clicks costs one write instead
// of one per click. FLUSH_DEBOUNCE_MS resets on every new change (so a quiet
// period triggers a flush); FLUSH_MAX_DELAY_MS is a hard cap so sustained
// clicking still flushes periodically instead of starving the debounce.
const FLUSH_DEBOUNCE_MS = 3000;
const FLUSH_MAX_DELAY_MS = 10000;

const redis = Redis.fromEnv();

function passwordsMatch(candidate, expected) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let count = 0;
let pendingDelta = 0;
let debounceTimer = null;
let maxWaitTimer = null;

function clearFlushTimers() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }
}

function scheduleFlush() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushPending, FLUSH_DEBOUNCE_MS);
  if (!maxWaitTimer) {
    maxWaitTimer = setTimeout(flushPending, FLUSH_MAX_DELAY_MS);
  }
}

async function flushPending() {
  clearFlushTimers();
  if (pendingDelta === 0) return;

  const delta = pendingDelta;
  pendingDelta = 0;
  try {
    await redis.incrby(COUNTER_KEY, delta);
  } catch (err) {
    console.error('Failed to flush pending counter delta:', err);
    // put it back so the next scheduled flush retries it
    pendingDelta += delta;
    scheduleFlush();
  }
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const payload = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', count }));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'increment') {
      count += 1;
      pendingDelta += 1;
      scheduleFlush();
      broadcast({ type: 'update', count, id: msg.id });
    } else if (msg.type === 'decrement') {
      count -= 1;
      pendingDelta -= 1;
      scheduleFlush();
      broadcast({ type: 'update', count, id: msg.id });
    } else if (msg.type === 'reset') {
      const value = Number(msg.value);
      if (
        RESET_PASSWORD &&
        typeof msg.password === 'string' &&
        passwordsMatch(msg.password, RESET_PASSWORD) &&
        Number.isInteger(value)
      ) {
        try {
          await redis.set(COUNTER_KEY, value);
          count = value;
          // the SET above already reflects the new truth; drop any unflushed
          // delta so it doesn't get re-applied on top of the reset later
          pendingDelta = 0;
          clearFlushTimers();
          broadcast({ type: 'update', count });
        } catch (err) {
          console.error('Failed to reset counter:', err);
          ws.send(JSON.stringify({ type: 'error' }));
        }
      } else {
        ws.send(JSON.stringify({ type: 'reset-denied' }));
      }
    }
  });
});

async function start() {
  count = (await redis.get(COUNTER_KEY)) || 0;
  server.listen(PORT, () => {
    console.log(`supercounter listening on http://localhost:${PORT}`);
  });
}

function shutdown() {
  flushPending().finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
