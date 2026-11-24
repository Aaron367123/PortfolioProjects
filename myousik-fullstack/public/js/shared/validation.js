/**
 * Shared validation rules — imported by BOTH the browser (forms) and the
 * Express server (src/validation.js). One source of truth means the client
 * and server can never disagree about what is valid or what the error says
 * (v1 had a password regex whose error text described a different rule).
 *
 * This module must stay environment-neutral: no DOM, no Node APIs.
 *
 * A schema is a plain object of field rules:
 *   { type: 'string' | 'int' | 'email' | 'url' | 'enum' | 'ids',
 *     label, required, min, max, pattern, values, message }
 *   - string: min/max are lengths; pattern is an optional RegExp
 *   - int:    min/max are numeric bounds (accepts numbers or digit strings)
 *   - email:  basic shape check, max 254 chars
 *   - url:    absolute http(s) URL or a site-relative path ("/images/x.jpg")
 *   - enum:   value must be one of `values`
 *   - ids:    array of unique positive integers (used for playlist reordering)
 * Strings are trimmed unless the rule sets `trim: false` (passwords).
 * `message`, when given, replaces every error for that field so the user sees
 * one consistent sentence describing the whole rule.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validate `input` against `schema`.
 * @param {object} input   untrusted data (req.body, req.query, form values)
 * @param {object} schema  field rules (see above)
 * @param {{partial?: boolean}} options  partial=true for PATCH: absent fields are skipped
 * @returns {{ value: object, errors: object|null }} cleaned values + field errors
 */
export function validate(input, schema, { partial = false } = {}) {
  const value = {};
  const errors = {};
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  for (const [name, rule] of Object.entries(schema)) {
    let raw = source[name];
    if (typeof raw === 'string' && rule.trim !== false) raw = raw.trim();

    const isAbsent = raw === undefined;
    const isEmpty = isAbsent || raw === null || raw === '';

    if (isEmpty) {
      if (partial && isAbsent) continue; // PATCH: leave the field unchanged
      if (rule.required) {
        errors[name] = rule.message || `${rule.label} is required.`;
      } else {
        value[name] = null; // optional field explicitly cleared (or omitted on create)
      }
      continue;
    }

    const result = checkField(raw, rule);
    if (result.error) errors[name] = rule.message || result.error;
    else value[name] = result.value;
  }

  return { value, errors: Object.keys(errors).length ? errors : null };
}

/** Validate a single non-empty value. Returns { value } or { error }. */
function checkField(raw, rule) {
  const label = rule.label;
  switch (rule.type) {
    case 'string': {
      if (typeof raw !== 'string') return { error: `${label} must be text.` };
      if (rule.min && raw.length < rule.min) return { error: `${label} must be at least ${rule.min} characters.` };
      if (rule.max && raw.length > rule.max) return { error: `${label} must be at most ${rule.max} characters.` };
      if (rule.pattern && !rule.pattern.test(raw)) return { error: `${label} has an invalid format.` };
      return { value: raw };
    }
    case 'int': {
      const n = typeof raw === 'number' ? raw : /^-?\d+$/.test(String(raw)) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(n)) return { error: `${label} must be a whole number.` };
      if (rule.min !== undefined && n < rule.min) return { error: `${label} must be ${rule.min} or more.` };
      if (rule.max !== undefined && n > rule.max) return { error: `${label} must be ${rule.max} or less.` };
      return { value: n };
    }
    case 'email': {
      if (typeof raw !== 'string' || raw.length > 254 || !EMAIL_RE.test(raw)) {
        return { error: `${label} must be a valid email address.` };
      }
      return { value: raw.toLowerCase() };
    }
    case 'url': {
      if (typeof raw !== 'string' || raw.length > (rule.max || 500)) return { error: `${label} must be a valid URL.` };
      // Site-relative paths are allowed ("/images/covers/x.jpg") but not protocol-relative ("//evil.com").
      if (raw.startsWith('/') && !raw.startsWith('//')) return { value: raw };
      try {
        const url = new URL(raw);
        if (url.protocol === 'http:' || url.protocol === 'https:') return { value: url.href };
      } catch { /* fall through */ }
      return { error: `${label} must be an http(s) URL or a path starting with "/".` };
    }
    case 'enum': {
      if (!rule.values.includes(raw)) return { error: `${label} must be one of: ${rule.values.join(', ')}.` };
      return { value: raw };
    }
    case 'ids': {
      if (!Array.isArray(raw)) return { error: `${label} must be a list of ids.` };
      if (rule.max && raw.length > rule.max) return { error: `${label} can contain at most ${rule.max} items.` };
      if (!raw.every((id) => Number.isSafeInteger(id) && id > 0)) return { error: `${label} must contain positive whole numbers.` };
      if (new Set(raw).size !== raw.length) return { error: `${label} must not contain duplicates.` };
      return { value: raw };
    }
    default:
      throw new Error(`Unknown rule type "${rule.type}" for ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Schemas used by the API and the forms
// ---------------------------------------------------------------------------

const CURRENT_YEAR = new Date().getFullYear();

export const USERNAME_RULE = {
  type: 'string', label: 'Username', required: true, min: 3, max: 24,
  pattern: /^[A-Za-z][A-Za-z0-9_]*$/,
  message: 'Username must be 3–24 characters, start with a letter and use only letters, numbers or underscores.',
};

export const PASSWORD_RULE = {
  type: 'string', label: 'Password', required: true, min: 8, max: 128, trim: false,
  pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/,
  message: 'Password must be 8–128 characters and include at least one letter and one number.',
};

export const schemas = {
  register: { username: USERNAME_RULE, password: PASSWORD_RULE },

  // Login deliberately does not re-check the format rules: a wrong-format
  // username simply fails to match, and we never hint which part was wrong.
  login: {
    username: { type: 'string', label: 'Username', required: true, max: 24 },
    password: { type: 'string', label: 'Password', required: true, max: 128, trim: false },
  },

  song: {
    title: { type: 'string', label: 'Title', required: true, max: 120 },
    artist: { type: 'string', label: 'Artist', required: true, max: 120 },
    album: { type: 'string', label: 'Album', max: 120 },
    genre: { type: 'string', label: 'Genre', max: 40 },
    duration_sec: { type: 'int', label: 'Length (seconds)', required: true, min: 1, max: 3600 },
    year: { type: 'int', label: 'Year', min: 1900, max: CURRENT_YEAR + 1 },
    cover_url: { type: 'url', label: 'Cover URL' },
    audio_url: { type: 'url', label: 'Audio URL' },
  },

  songQuery: {
    q: { type: 'string', label: 'Search', max: 100 },
    genre: { type: 'string', label: 'Genre', max: 40 },
    sort: { type: 'enum', label: 'Sort', values: ['title', 'artist', 'year', 'duration_sec', 'created_at', 'popularity'] },
    order: { type: 'enum', label: 'Order', values: ['asc', 'desc'] },
    page: { type: 'int', label: 'Page', min: 1, max: 100000 },
    limit: { type: 'int', label: 'Limit', min: 1, max: 100 },
  },

  playlist: {
    name: { type: 'string', label: 'Name', required: true, max: 60 },
    description: { type: 'string', label: 'Description', max: 280 },
  },

  playlistAddSong: {
    song_id: { type: 'int', label: 'Song', required: true, min: 1 },
  },

  playlistOrder: {
    song_ids: { type: 'ids', label: 'Song order', required: true, max: 500 },
  },

  // Mirrors the v1 feedback form: name, email, 1–3 audio rating, comments.
  feedback: {
    name: { type: 'string', label: 'Name', required: true, max: 80 },
    email: { type: 'email', label: 'Email', required: true },
    rating: { type: 'int', label: 'Audio quality', required: true, min: 1, max: 3, message: 'Please rate the audio quality from 1 to 3.' },
    comments: { type: 'string', label: 'Feedback', required: true, min: 5, max: 2000, message: 'Please enter your feedback (5–2000 characters).' },
  },
};
