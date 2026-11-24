/**
 * Thin wrapper around fetch for the JSON API.
 * Every non-2xx response is turned into an ApiError carrying the server's
 * { code, message, fields } so forms can show per-field messages.
 */
export class ApiError extends Error {
  constructor(status, { code = 'ERROR', message = 'Request failed.', fields } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

/**
 * @param {string} path  e.g. "/api/songs?q=jazz"
 * @param {{ method?: string, body?: unknown }} [options]
 */
export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, { code: 'NETWORK_ERROR', message: 'Could not reach the server. Check your connection.' });
  }

  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error);
  return data;
}

/** Build a query string, skipping empty values. */
export function query(params) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}
