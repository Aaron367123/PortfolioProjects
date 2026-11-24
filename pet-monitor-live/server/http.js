/**
 * Minimal HTTP toolkit on top of node:http - a tiny router, JSON helpers and a safe static
 * file server. Keeps the project dependency-free apart from `ws`.
 */
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** Reads and parses a JSON request body with a size limit. */
export function readJson(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const type = req.headers['content-type'] ?? '';
    if (!type.toLowerCase().startsWith('application/json')) {
      reject(new HttpError(415, 'Content-Type must be application/json'));
      req.resume();
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new HttpError(413, `body larger than ${limitBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** Router with ":param" segments. */
export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler) {
      const names = [];
      const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)'))}$`);
      routes.push({ method, re, names, handler });
    },
    /** @returns {{handler, params}|{allowed:string[]}|null} */
    match(method, pathname) {
      const allowed = [];
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.method !== method) {
          allowed.push(r.method);
          continue;
        }
        const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        return { handler: r.handler, params };
      }
      return allowed.length ? { allowed } : null;
    },
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; frame-ancestors *";

/**
 * Serves files from `mounts` ([{prefix, dir}], longest prefix first).
 * Resolves the path and refuses anything that escapes the mounted directory.
 * @returns {boolean} true if a response was sent
 */
export function serveStatic(req, res, pathname, mounts) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  for (const { prefix, dir } of mounts) {
    if (!pathname.startsWith(prefix)) continue;
    let rel;
    try {
      rel = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
      return false;
    }
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(dir, rel);
    if (file !== dir && !file.startsWith(dir + path.sep)) return false; // path traversal
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': CSP,
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}
