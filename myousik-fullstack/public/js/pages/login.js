/**
 * Log in / create account. On success, return to ?next= (same-site paths
 * only, to avoid an open redirect) or the playlists page.
 */
import { api } from '../api.js';
import { initLayout } from '../layout.js';
import { validateForm, showApiError, withBusy } from '../forms.js';
import { schemas } from '../shared/validation.js';

const user = await initLayout();

const next = new URLSearchParams(location.search).get('next');
// Only accept "/path" — not "//evil.com" or "https://evil.com".
const destination = next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/playlists';
if (user) location.replace(destination);

const tabs = { login: document.getElementById('tab-login'), register: document.getElementById('tab-register') };
const forms = { login: document.getElementById('login-form'), register: document.getElementById('register-form') };

function select(name) {
  for (const key of Object.keys(tabs)) {
    const active = key === name;
    tabs[key].setAttribute('aria-selected', String(active));
    tabs[key].tabIndex = active ? 0 : -1;
    forms[key].hidden = !active;
  }
  forms[name].querySelector('input').focus();
}
tabs.login.addEventListener('click', () => select('login'));
tabs.register.addEventListener('click', () => select('register'));
// Arrow keys move between tabs (WAI-ARIA tabs pattern).
document.querySelector('[role=tablist]').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const name = tabs.login.getAttribute('aria-selected') === 'true' ? 'register' : 'login';
    select(name);
    tabs[name].focus();
  }
});
if (location.hash === '#register') select('register');

function wire(form, schema, endpoint) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = validateForm(form, schema);
    if (!values) return;
    await withBusy(form.querySelector('[type=submit]'), async () => {
      try {
        await api(endpoint, { method: 'POST', body: values });
        location.href = destination;
      } catch (err) {
        showApiError(form, err);
      }
    });
  });
}

wire(forms.login, schemas.login, '/api/auth/login');
wire(forms.register, schemas.register, '/api/auth/register');
