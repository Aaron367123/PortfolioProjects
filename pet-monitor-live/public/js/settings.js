/**
 * Settings drawer. The form is generated from CONFIG_FIELDS (shared/config.js), the same
 * table the server validates against, so the UI and API cannot drift apart.
 * Client-side checks are only for fast feedback; the source (server or demo) is the
 * authority and its error messages are shown verbatim.
 */
import { CONFIG_FIELDS, getPath, applyConfigPatch } from '../shared/config.js';

export function createSettings({ getConfig, source, toast }) {
  const drawer = document.getElementById('drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  const form = document.getElementById('settings-form');
  const fields = document.getElementById('settings-fields');
  const errors = document.getElementById('settings-errors');
  const tokenRow = document.getElementById('token-row');
  const tokenInput = document.getElementById('admin-token');
  let dirty = false;

  // Build grouped inputs once.
  const groups = new Map();
  for (const f of CONFIG_FIELDS) {
    if (!groups.has(f.group)) {
      const fs = document.createElement('fieldset');
      const lg = document.createElement('legend');
      lg.textContent = f.group;
      fs.append(lg);
      groups.set(f.group, fs);
      fields.append(fs);
    }
    const label = document.createElement('label');
    label.className = 'field';
    const text = document.createElement('span');
    text.textContent = f.label;
    const hint = document.createElement('span');
    hint.className = 'unit-hint';
    hint.textContent = ` (${f.unit})`;
    text.append(hint);
    const input = document.createElement('input');
    Object.assign(input, { type: 'number', name: f.path, min: f.min, max: f.max, step: f.step, required: true, inputMode: 'decimal' });
    input.addEventListener('input', () => {
      dirty = true;
      input.classList.remove('bad');
    });
    label.append(text, input);
    groups.get(f.group).append(label);
  }

  function fill() {
    const cfg = getConfig();
    if (!cfg) return;
    for (const f of CONFIG_FIELDS) form.elements[f.path].value = getPath(cfg, f.path);
    dirty = false;
    errors.replaceChildren();
  }

  function showErrors(list) {
    errors.replaceChildren(...list.map((e) => Object.assign(document.createElement('li'), { textContent: e })));
    for (const f of CONFIG_FIELDS) form.elements[f.path].classList.toggle('bad', list.some((e) => e.includes(f.path)));
  }

  function open() {
    fill();
    tokenRow.hidden = source.kind !== 'live';
    if (source.kind === 'live') tokenInput.value = source.adminToken;
    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.hidden = false;
    form.elements[CONFIG_FIELDS[0].path].focus();
  }

  function close() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.hidden = true;
    document.getElementById('open-settings').focus();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = getConfig();
    const patch = {};
    for (const f of CONFIG_FIELDS) {
      const raw = form.elements[f.path].value;
      const value = raw === '' ? NaN : Number(raw);
      if (value === getPath(current, f.path)) continue;
      const keys = f.path.split('.');
      let o = patch;
      for (const k of keys.slice(0, -1)) o = o[k] ??= {};
      o[keys.at(-1)] = value;
    }
    if (!Object.keys(patch).length) return close();
    const local = applyConfigPatch(current, patch);
    if (!local.ok) return showErrors(local.errors);
    if (source.kind === 'live') source.adminToken = tokenInput.value.trim();
    const result = await source.putConfig(patch);
    if (!result.ok) {
      if (result.needsToken) tokenRow.hidden = false;
      return showErrors(result.errors);
    }
    dirty = false;
    toast('Settings saved');
    close();
  });

  document.getElementById('reset-settings').addEventListener('click', fill);
  document.getElementById('open-settings').addEventListener('click', open);
  document.getElementById('close-settings').addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawer.classList.contains('open')) close();
  });

  return {
    /** Called when a config message arrives; don't clobber the user's unsaved edits. */
    onConfig() {
      if (!dirty) fill();
    },
  };
}
