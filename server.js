require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Redis } = require('@upstash/redis');

const PORT = process.env.PORT || 3000;
const COUNTER_KEY = 'supercounter:count';

const redis = Redis.fromEnv();

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
