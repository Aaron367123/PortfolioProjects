/**
 * HttpError carries everything the error handler needs to build the
 * consistent JSON error shape used by every endpoint:
 *
 *   { "error": { "code": "VALIDATION_ERROR", "message": "...", "fields": { ... } } }
 */
export class HttpError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const badRequest = (message, fields) => new HttpError(400, 'VALIDATION_ERROR', message, fields);
export const unauthenticated = (message = 'You need to log in to do that.') => new HttpError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'FORBIDDEN', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found.`);
export const conflict = (message, fields) => new HttpError(409, 'CONFLICT', message, fields);
