/**
 * Server-side glue around the shared validation rules.
 *
 * The rules themselves live in public/js/shared/validation.js so the browser
 * imports exactly the same code. Here we only translate a failed validation
 * into a 400 HttpError and parse route ids.
 */
import { validate, schemas } from '../public/js/shared/validation.js';
import { badRequest, notFound } from './errors.js';

export { schemas };

/**
 * Validate and return cleaned data, or throw a 400 with per-field messages.
 * @param {object} input
 * @param {object} schema
 * @param {{partial?: boolean}} [options]
 */
export function check(input, schema, options) {
  const { value, errors } = validate(input, schema, options);
  if (errors) throw badRequest('Some fields are invalid.', errors);
  return value;
}

/** Parse a numeric route parameter; anything else can't match a row, so 404. */
export function parseId(raw, what) {
  if (!/^[1-9]\d{0,15}$/.test(raw)) throw notFound(what);
  return Number(raw);
}
