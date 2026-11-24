/**
 * The last two middleware in the chain: a JSON 404 for unknown API routes,
 * and the error handler that turns anything thrown into the standard shape
 *   { error: { code, message, fields? } }
 */
import { HttpError } from '../errors.js';

export function apiNotFound(req, _res, next) {
  next(new HttpError(404, 'NOT_FOUND', `No API route for ${req.method} ${req.path}.`));
}

// Express recognises error handlers by their 4-argument signature.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let error = err;

  // Errors raised by express.json() while reading the body.
  if (err.type === 'entity.parse.failed') error = new HttpError(400, 'INVALID_JSON', 'Request body is not valid JSON.');
  else if (err.type === 'entity.too.large') error = new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');

  if (!(error instanceof HttpError)) {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
    error = new HttpError(500, 'INTERNAL_ERROR', 'Something went wrong on our side.');
  }

  if (error.retryAfterSec) res.set('Retry-After', String(error.retryAfterSec));

  const body = { error: { code: error.code, message: error.message } };
  if (error.fields) body.error.fields = error.fields;
  res.status(error.status).json(body);
}
