/**
 * WebSocketSource - live data from the Node server.
 *
 * Data-source interface (implemented identically by DemoSource):
 *   connect({onMessage, onStatus})   onMessage({type, data}); onStatus({state, ...})
 *   getHistory({metric, deviceId, from, to, bucketMs}) -> Promise<{points, bucketMs}>
 *   putConfig(patch)                  -> Promise<{ok, config} | {ok:false, errors}>
 *   acknowledge(alertId)              -> Promise<void>
 *   close()
 *
 * All URLs are relative to the page, so the dashboard works under any sub-path.
 * Reconnects with exponential backoff + jitter; treats >25 s without any message as a
 * dead connection (the server sends a heartbeat every 10 s).
 */
const STALE_MS = 25_000;
const TOKEN_KEY = 'pml-admin-token';

export class WebSocketSource {
  constructor() {
    this.kind = 'live';
    this.attempt = 0;
    this.ws = null;
    this.closed = false;
  }

  get adminToken() {
    try {
      return sessionStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  }

  set adminToken(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable: token lives for this call only */
    }
  }

  connect({ onMessage, onStatus }) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.#open();
  }

  #open() {
    if (this.closed) return;
    const url = new URL('ws', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.onStatus({ state: this.attempt ? 'reconnecting' : 'connecting', attempt: this.attempt });
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.onStatus({ state: 'live' });
      this.#touch();
    };
    ws.onmessage = (e) => {
      this.#touch();
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    ws.onclose = () => {
      clearTimeout(this.staleTimer);
      if (this.ws !== ws || this.closed) return;
      // 0.5 s, 1 s, 2 s ... capped at 15 s, with ±30 % jitter so many tabs don't stampede.
      const base = Math.min(15_000, 500 * 2 ** this.attempt);
      const delay = Math.round(base * (0.7 + Math.random() * 0.6));
      this.attempt++;
      this.onStatus({ state: 'reconnecting', attempt: this.attempt, retryAt: Date.now() + delay });
      this.retryTimer = setTimeout(() => this.#open(), delay);
    };
    ws.onerror = () => ws.close();
  }

  /** Any message proves the connection is alive; silence for STALE_MS forces a reconnect. */
  #touch() {
    clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => this.ws?.close(), STALE_MS);
  }

  #headers(json) {
    const h = json ? { 'Content-Type': 'application/json' } : {};
    if (this.adminToken) h.Authorization = `Bearer ${this.adminToken}`;
    return h;
  }

  async getHistory({ metric, deviceId, from, to, bucketMs }) {
    const q = new URLSearchParams({ metric, deviceId, from: String(Math.round(from)), to: String(Math.round(to)), bucket: String(bucketMs) });
    const res = await fetch(`api/history?${q}`);
    if (!res.ok) throw new Error(`history ${res.status}`);
    return res.json();
  }

  async putConfig(patch) {
    const res = await fetch('api/config', { method: 'PUT', headers: this.#headers(true), body: JSON.stringify(patch) });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, config: body };
    if (res.status === 401) return { ok: false, errors: ['Admin token required or wrong - enter it below.'], needsToken: true };
    return { ok: false, errors: body.details ?? [body.error ?? `HTTP ${res.status}`] };
  }

  async acknowledge(alertId) {
    const res = await fetch(`api/alerts/${encodeURIComponent(alertId)}/ack`, { method: 'POST', headers: this.#headers(false) });
    if (!res.ok) throw new Error(res.status === 401 ? 'Admin token required (Settings)' : `HTTP ${res.status}`);
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.staleTimer);
    this.ws?.close();
  }
}
