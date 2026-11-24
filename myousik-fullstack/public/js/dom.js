/**
 * DOM helpers. All user-supplied text goes through textContent (via h()),
 * never innerHTML, so song titles like "<img onerror=...>" render as text.
 */

/**
 * Create an element: h('a', { href: '/x', class: 'btn' }, 'Label', childNode)
 * Attributes starting with "on" become event listeners; `false`/null skip.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// Static, trusted SVG markup (no user data) — safe to parse.
const ICONS = {
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.6-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m14 6 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  list: '<path d="M4 6h11M4 12h11M4 18h7"/><circle cx="18.5" cy="16.5" r="2.5"/><path d="M21 16.5V8l-2 1"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
  return span.firstChild;
}

/** Icon-only button with an accessible name. */
export function iconButton(name, label, onClick, extraClass = '') {
  return h('button', { type: 'button', class: `icon-btn ${extraClass}`.trim(), 'aria-label': label, title: label, onclick: onClick }, icon(name));
}

/** 245 -> "4:05" */
export function formatDuration(totalSec) {
  if (!Number.isFinite(totalSec)) return '0:00';
  const s = Math.max(0, Math.round(totalSec));
  const hours = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = String(s % 60).padStart(2, '0');
  return hours ? `${hours}:${String(mins).padStart(2, '0')}:${secs}` : `${mins}:${secs}`;
}

/** "1 h 12 min" style summary for playlist totals. */
export function formatLongDuration(totalSec) {
  const mins = Math.round(totalSec / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/** Cover image, or a pink/mint gradient tile with the title's initial. */
export function cover(song, extraClass = '') {
  if (song.cover_url) {
    return h('img', { class: `cover ${extraClass}`.trim(), src: song.cover_url, alt: '', loading: 'lazy', decoding: 'async' });
  }
  return h('div', { class: `cover cover-fallback ${extraClass}`.trim(), 'aria-hidden': 'true' }, (song.title || '?').charAt(0));
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

/** Debounce for search-as-you-type. */
export function debounce(fn, ms = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
