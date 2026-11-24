/**
 * Form helpers shared by every page: read values, run the shared validation
 * rules, and display per-field errors accessibly.
 *
 * Markup convention for each field:
 *   <input id="x" name="x" aria-describedby="x-error">
 *   <p class="field-error" id="x-error"></p>
 * The form has <div class="form-alert" role="alert"></div> for a summary.
 */
import { validate } from './shared/validation.js';
import { ApiError } from './api.js';

/** Collect form values into a plain object (radio groups -> single value). */
export function readForm(form) {
  const data = {};
  for (const [key, value] of new FormData(form)) data[key] = typeof value === 'string' ? value : '';
  return data;
}

export function clearErrors(form) {
  form.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'));
  form.querySelectorAll('.field-error').forEach((el) => { el.textContent = ''; });
  const alert = form.querySelector('.form-alert');
  if (alert) alert.textContent = '';
}

/**
 * Show field messages and focus the first invalid control.
 * @param {HTMLFormElement} form
 * @param {Record<string,string>} fields
 * @param {string} [summary]
 */
export function showErrors(form, fields = {}, summary) {
  clearErrors(form);
  let first = null;
  for (const [name, message] of Object.entries(fields)) {
    const control = form.elements.namedItem(name);
    const errorEl = form.querySelector(`#${CSS.escape(form.dataset.prefix || '')}${CSS.escape(name)}-error`);
    if (errorEl) errorEl.textContent = message;
    // Radio groups: mark the fieldset; single controls: mark the control.
    const target = control instanceof RadioNodeList ? form.querySelector(`fieldset[data-group="${name}"]`) : control;
    if (target) {
      target.setAttribute('aria-invalid', 'true');
      first ??= control instanceof RadioNodeList ? control[0] : control;
    }
  }
  const alert = form.querySelector('.form-alert');
  const count = Object.keys(fields).length;
  if (alert && (summary || count)) {
    alert.textContent = summary || `Please fix ${count === 1 ? 'the highlighted field' : `the ${count} highlighted fields`}.`;
  }
  first?.focus();
}

/**
 * Validate a form against a shared schema. Shows errors and returns null on
 * failure, or the cleaned values on success.
 */
export function validateForm(form, schema, options) {
  const { value, errors } = validate(readForm(form), schema, options);
  if (errors) {
    showErrors(form, errors);
    return null;
  }
  clearErrors(form);
  return value;
}

/** Display an ApiError (or anything thrown) on a form. */
export function showApiError(form, err) {
  if (err instanceof ApiError && err.fields) showErrors(form, err.fields, err.message);
  else {
    clearErrors(form);
    const alert = form.querySelector('.form-alert');
    if (alert) alert.textContent = err.message || 'Something went wrong.';
  }
}

/** Disable a submit button while a request is in flight. */
export async function withBusy(button, fn) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Please wait…';
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}
