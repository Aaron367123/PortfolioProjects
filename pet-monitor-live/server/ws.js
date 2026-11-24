/**
 * WebSocket fan-out hub (library: ws).
 *
 * - Upgrade requests are accepted on any path ending in "/ws", so the dashboard works
 *   behind a reverse proxy sub-path (it connects to a URL relative to the page).
 * - Each new client first receives {type:'snapshot'}; afterwards every pipeline message.
 * - Liveness: protocol-level ping every `heartbeatMs`; a client that did not answer the
 *   previous ping is terminated (stale-client cleanup for half-open TCP connections).
 *   An application-level {type:'heartbeat'} message is sent too, because browsers do not
 *   expose ping frames - the dashboard uses it to detect a silent server.
 * - Backpressure: a slow client whose send buffer exceeds `maxBufferedBytes` skips
 *   'reading' messages (it will catch up via the next one); alerts/events are never dropped.
 */
import { WebSocketServer, WebSocket } from 'ws';

export function createHub({ server, getSnapshot, heartbeatMs = 10_000, maxBufferedBytes = 1 << 20, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (!pathname.endsWith('/ws')) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.dropped = 0;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => {
      // Clients may send {"type":"ping"} for an application-level round trip.
      try {
        if (JSON.parse(raw.toString()).type === 'ping') send(ws, { type: 'pong', data: { serverTime: Date.now() } });
      } catch {
        /* ignore junk */
      }
    });
    ws.on('error', (err) => log(`ws client error: ${err.message}`));
    log(`ws client connected (${req.socket.remoteAddress}); ${wss.clients.size} connected`);
    send(ws, { type: 'snapshot', data: getSnapshot() });
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        log('ws client unresponsive - terminating');
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    broadcast({ type: 'heartbeat', data: { serverTime: Date.now(), clients: wss.clients.size } });
  }, heartbeatMs);
  pinger.unref();

  function send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  /** Serialise once, send to every open client. */
  function broadcast(msg) {
    if (wss.clients.size === 0) return;
    const payload = JSON.stringify(msg);
    const droppable = msg.type === 'reading';
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && ws.bufferedAmount > maxBufferedBytes) {
        ws.dropped++;
        continue;
      }
      ws.send(payload);
    }
  }

  function close() {
    clearInterval(pinger);
    for (const ws of wss.clients) ws.terminate();
    return new Promise((resolve) => wss.close(() => resolve()));
  }

  return {
    broadcast,
    close,
    get clientCount() {
      return wss.clients.size;
    },
  };
}
