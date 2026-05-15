/**
 * Forgotten Society — Audio MITM Proxy Server
 * 
 * Raw WebSocket proxy: browser ↔ proxy ↔ audio.nekto.me
 * Adds Origin/User-Agent headers, handles Engine.IO ping-pong.
 * 
 * Usage: node proxy.mjs
 * Open:  http://localhost:8000
 */

import http from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, extname } from 'path';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = 8000;
const STATIC_DIR = resolve('dist');

/* Optional .kz upstream fallback. Per-connection: client passes
   ?upstream=kz in the WS URL (the React settings panel toggles this).
   Global default: set NEKTO_USE_KZ_FALLBACK=1 to flip the default. */
const DEFAULT_UPSTREAM_HOST = process.env.NEKTO_USE_KZ_FALLBACK === '1'
  ? 'audio.nekto-me.kz'
  : 'audio.nekto.me';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/* ─── HTTP: serve dist/ ─── */

const server = http.createServer((req, res) => {
  let path = req.url?.split('?')[0] || '/';
  if (path === '/') path = '/index.html';
  const file = resolve(STATIC_DIR, path.slice(1));
  if (!file.startsWith(STATIC_DIR) || !existsSync(file)) {
    const fallback = resolve(STATIC_DIR, 'index.html');
    if (existsSync(fallback)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(fallback));
    }
    res.writeHead(404);
    return res.end('Not found');
  }
  const ct = MIME[extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct });
  res.end(readFileSync(file));
});

/* ─── WebSocket proxy ─── */

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/audio-ws' || url.pathname === '/audio-ws/') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (clientWs, req) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const token = url.searchParams.get('token') || '';

  /* Per-connection upstream override. UI sends ?upstream=kz to route
     this WS to audio.nekto-me.kz (different edge node, often a different
     IP bucket → may bypass an IP-level ban on .me). Defaults to whatever
     NEKTO_USE_KZ_FALLBACK env says, or audio.nekto.me. */
  const upstreamParam = (url.searchParams.get('upstream') || '').toLowerCase();
  const upstreamHost = upstreamParam === 'kz'
    ? 'audio.nekto-me.kz'
    : upstreamParam === 'me'
      ? 'audio.nekto.me'
      : DEFAULT_UPSTREAM_HOST;

  const targetUrl = `wss://${upstreamHost}/websocket/?EIO=4&transport=websocket${token ? '&token=' + encodeURIComponent(token) : ''}`;

  const tag = token.slice(0, 8);
  console.log(`[PROXY] ← Client connected token=${tag}... upstream=${upstreamHost}`);

  const targetWs = new WebSocket(targetUrl, {
    headers: {
      'Origin': 'https://nekto.me',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  });

  let alive = true;

  /* ─── Target (nekto.me) → Client (browser) ─── */

  targetWs.on('open', () => {
    console.log(`[PROXY] → Connected to nekto.me token=${tag}`);
  });

  targetWs.on('message', (raw) => {
    const msg = raw.toString(); // ALWAYS convert to string!

    // Engine.IO v3: server sends "2" (ping) → respond "3" (pong)
    if (msg === '2') {
      targetWs.send('3');
      return; // Don't forward ping to client
    }

    // Engine.IO upgrade probe
    if (msg === '2probe') {
      targetWs.send('3probe');
      return;
    }

    // Forward as STRING (not Buffer!) so browser can parse it
    if (alive && clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(msg);
    }
  });

  targetWs.on('close', (code, reason) => {
    console.log(`[PROXY] → nekto.me closed code=${code} token=${tag}`);
    alive = false;
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason.toString());
  });

  targetWs.on('error', (err) => {
    console.error(`[PROXY] → nekto.me error: ${err.message}`);
    alive = false;
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'Upstream error');
  });

  /* ─── Client (browser) → Target (nekto.me) ─── */

  clientWs.on('message', (raw) => {
    if (alive && targetWs.readyState === WebSocket.OPEN) {
      // Forward as string
      targetWs.send(raw.toString());
    }
  });

  clientWs.on('close', (code) => {
    console.log(`[PROXY] ← Client closed code=${code} token=${tag}`);
    alive = false;
    if (targetWs.readyState === WebSocket.OPEN) targetWs.close(code);
  });

  clientWs.on('error', (err) => {
    console.error(`[PROXY] ← Client error: ${err.message}`);
    alive = false;
    if (targetWs.readyState === WebSocket.OPEN) targetWs.close(1011);
  });
});

/* ─── Start ─── */

server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║   FORGOTTEN SOCIETY — Audio MITM Proxy           ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Open: http://localhost:${PORT}                    ║`);
  console.log('║   Proxy: /audio-ws → wss://audio.nekto.me       ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
