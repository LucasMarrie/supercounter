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
// last Redis value this process actually observed via a write's own return
// value. Used only to detect drift (something outside this process writing
// to the same key) — never to correct `count`, which stays authoritative.
let lastKnownRedisValue = 0;
let debounceTimer = null;
let maxWaitTimer = null;

// serializes every Redis-mutating operation (flush and reset) so at most one
// is ever in flight at a time. Without this, a reset's redis.set() could land
// at Upstash either before or after an already-in-flight flush's
// redis.incrby() (Upstash doesn't guarantee requests land in dispatch order —
// confirmed empirically), corrupting the persisted value to
// reset_value + stale_delta.
let writeLock = Promise.resolve();

function withWriteLock(task) {
  const result = writeLock.then(task, task);
  writeLock = result.catch(() => {});
  return result;
}

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
  debounceTimer = setTimeout(() => withWriteLock(flushPending), FLUSH_DEBOUNCE_MS);
  if (!maxWaitTimer) {
    maxWaitTimer = setTimeout(() => withWriteLock(flushPending), FLUSH_MAX_DELAY_MS);
  }
}

async function flushPending() {
  clearFlushTimers();
  if (pendingDelta === 0) return;

  const delta = pendingDelta;
  pendingDelta = 0;
  try {
    const newValue = await redis.incrby(COUNTER_KEY, delta);
    const expected = lastKnownRedisValue + delta;
    if (newValue !== expected) {
      console.warn(
        `Redis drift detected: expected ${expected} after incrby(${delta}) ` +
          `from ${lastKnownRedisValue}, got ${newValue}. Something else may ` +
          `be writing to this key. In-memory count is unaffected.`
      );
    }
    lastKnownRedisValue = newValue;
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
        await withWriteLock(async () => {
          clearFlushTimers();
          const preResetDelta = pendingDelta;
          try {
            await redis.set(COUNTER_KEY, value);
            lastKnownRedisValue = value;
            // pendingDelta may have grown further while the set() above was
            // in flight (a concurrent increment/decrement from another
            // client) — that portion happened after this reset was issued
            // and should still apply on top of it, rather than being
            // silently discarded. Only the pre-reset portion, which was
            // relative to the old baseline, is now stale and gets dropped.
            const accruedDuringReset = pendingDelta - preResetDelta;
            count = value + accruedDuringReset;
            pendingDelta = accruedDuringReset;
            if (pendingDelta !== 0) scheduleFlush();
            broadcast({ type: 'update', count });
          } catch (err) {
            console.error('Failed to reset counter:', err);
            ws.send(JSON.stringify({ type: 'error' }));
          }
        });
      } else {
        ws.send(JSON.stringify({ type: 'reset-denied' }));
      }
    }
  });
});

async function start() {
  count = (await redis.get(COUNTER_KEY)) || 0;
  lastKnownRedisValue = count;
  server.listen(PORT, () => {
    console.log(`supercounter listening on http://localhost:${PORT}`);
  });
}

function shutdown() {
  withWriteLock(flushPending).finally(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
