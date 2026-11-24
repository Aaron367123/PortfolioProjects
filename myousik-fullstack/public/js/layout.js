/**
 * Shared page chrome: header (nav + auth state), footer, toasts.
 * Every page module calls initLayout() first and awaits the current user.
 */
import { api } from './api.js';
import { h, icon } from './dom.js';
import { initPlayer } from './player.js';

const NAV = [
  { href: '/', label: 'Home', page: 'home' },
  { href: '/library', label: 'Library', page: 'library' },
  { href: '/playlists', label: 'Playlists', page: 'playlists' },
  { href: '/feedback', label: 'Feedback', page: 'feedback' },
  { href: '/about', label: 'About', page: 'about' },
];

let userPromise;

/** The logged-in user, or null. Fetched once per page load. */
export function currentUser() {
  userPromise ??= api('/api/auth/me').then((r) => r.user).catch(() => null);
  return userPromise;
}

/**
 * Render the header/footer and resolve with the current user.
 * @returns {Promise<{id:number, username:string}|null>}
 */
export async function initLayout() {
  const page = document.body.dataset.page;
  renderFooter();
  initPlayer();
  const header = document.getElementById('site-header');
  renderHeader(header, page, undefined); // render immediately, auth area fills in after /me
  const user = await currentUser();
  renderHeader(header, page, user);
  return user;
}

function renderHeader(header, page, user) {
  const nav = h('nav', { class: 'main-nav', id: 'main-nav', 'aria-label': 'Main' },
    h('ul', {}, NAV.map((item) => h('li', {},
      h('a', { href: item.href, 'aria-current': item.page === page ? 'page' : false }, item.label)))));

  const toggle = h('button', {
    type: 'button', class: 'icon-btn menu-toggle', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': 'main-nav',
    onclick: () => {
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
    },
  }, icon('menu'));

  let auth;
  if (user === undefined) {
    auth = h('div', { class: 'auth-area', 'aria-hidden': 'true' });
  } else if (user) {
    auth = h('div', { class: 'auth-area' },
      h('span', { class: 'user-chip' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, user.username.charAt(0)),
        h('span', { class: 'username' }, user.username)),
      h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onclick: logout }, 'Log out'));
  } else {
    const next = page === 'login' ? '' : `?next=${encodeURIComponent(location.pathname + location.search)}`;
    auth = h('div', { class: 'auth-area' },
      h('a', { class: 'btn btn-primary btn-sm', href: `/login${next}`, 'aria-current': page === 'login' ? 'page' : false }, 'Log in'));
  }

  header.replaceChildren(
    h('div', { class: 'container header-inner' },
      h('a', { class: 'brand', href: '/', 'aria-label': 'Myousik home' },
        h('img', { src: '/images/logo-mark.png', alt: '', width: '36', height: '36' }),
        'Myousik', h('span', { class: 'badge' }, '2.0')),
      nav, auth, toggle));
}

async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST', body: {} });
  } finally {
    location.href = '/';
  }
}

function renderFooter() {
  const footer = document.getElementById('site-footer');
  if (!footer) return;
  footer.replaceChildren(
    h('div', { class: 'container footer-inner' },
      h('img', { src: '/images/logo.png', alt: 'Myousik streaming logo', width: '72', height: '71' }),
      h('div', {},
        h('p', {}, h('strong', {}, 'Myousik 2.0'), ' — a full-stack rebuild of a college music-site mockup.'),
        h('p', {}, 'v1 built by Medi Muamba, Caio Q, Aaron Jara and Chidinma Etumni; v2 full-stack rebuild by Aaron Jara.')),
      h('p', { class: 'small' }, h('a', { href: '/about' }, 'About the project'))));
}

/** Small transient status message, announced to screen readers. */
export function toast(message, { error = false } = {}) {
  let region = document.querySelector('.toast-region');
  if (!region) {
    region = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  const el = h('div', { class: `toast${error ? ' error' : ''}` }, message);
  region.append(el);
  setTimeout(() => el.remove(), 3500);
}

/** Send logged-out visitors to the login page, then back here afterwards. */
export function loginUrl() {
  return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}
