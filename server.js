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

const redis = Redis.fromEnv();

function passwordsMatch(candidate, expected) {
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let count = 0;

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
      try {
        count = await redis.incr(COUNTER_KEY);
        broadcast({ type: 'update', count });
      } catch (err) {
        console.error('Failed to increment counter:', err);
        ws.send(JSON.stringify({ type: 'error', delta: 1 }));
      }
    } else if (msg.type === 'decrement') {
      try {
        count = await redis.decr(COUNTER_KEY);
        broadcast({ type: 'update', count });
      } catch (err) {
        console.error('Failed to decrement counter:', err);
        ws.send(JSON.stringify({ type: 'error', delta: -1 }));
      }
    } else if (msg.type === 'reset') {
      if (RESET_PASSWORD && typeof msg.password === 'string' && passwordsMatch(msg.password, RESET_PASSWORD)) {
        try {
          await redis.set(COUNTER_KEY, 0);
          count = 0;
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

start();
