/**
 * DOM rendering for cards, alert feed and visit timeline.
 * Uses textContent / createElement only (never innerHTML with data).
 */
import { ago, clock, duration, num, slopePerMinute } from './format.js';

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

/** Latest non-null value of `key` in recent readings (a faulty sample is blanked). */
function lastGood(readings, key) {
  for (let i = readings.length - 1; i >= 0 && i >= readings.length - 120; i--) {
    if (readings[i][key] != null) return readings[i][key];
  }
  return null;
}

function trend(readings, key, deadband, decimals, unit) {
  const recent = readings.slice(-90).map((r) => ({ t: r.ts, v: r[key] }));
  const s = slopePerMinute(recent);
  if (s == null) return { cls: 'flat', text: '' };
  if (Math.abs(s) < deadband) return { cls: 'flat', text: '▬ steady' };
  return { cls: s > 0 ? 'up' : 'down', text: `${s > 0 ? '▲' : '▼'} ${Math.abs(s).toFixed(decimals)}`, unit: ` ${unit}/min` };
}

function activeAlertKeys(state, deviceId) {
  const keys = new Set();
  for (const a of state.alerts.values()) if (a.status === 'active' && a.deviceId === deviceId) keys.add(a.key);
  return keys;
}

const FAULT_TEXT = { temperatureC: 'DHT22', weightRaw: 'FSR', phVoltage: 'pH probe' };

function setCard(id, { value, foot, trendInfo, alerting }) {
  const card = document.getElementById(id);
  $('[data-value]', card).textContent = value;
  if (foot != null) $('[data-foot]', card).textContent = foot;
  const tr = $('[data-trend]', card);
  if (tr && trendInfo) {
    tr.className = `trend ${trendInfo.cls}`;
    tr.textContent = trendInfo.text;
    if (trendInfo.unit) tr.append(el('span', 'trend-unit', trendInfo.unit));
  }
  card.classList.toggle('alerting', !!alerting);
}

export function renderCards(state, dev) {
  if (!dev) return;
  const r = dev.readings;
  const last = dev.lastReading;
  const alerts = activeAlertKeys(state, dev.deviceId);
  const faults = new Set(dev.faults ?? []);
  const cfg = state.config?.alerts;

  setCard('card-temp', {
    value: num(lastGood(r, 'temperatureC'), 1),
    trendInfo: trend(r, 'temperatureC', 0.05, 2, '°C'),
    foot: faults.has('temperatureC') ? '⚠ sensor fault · DHT22' : cfg ? `DHT22 · safe ${cfg.temperature.lowC}–${cfg.temperature.highC} °C` : 'DHT22 · GPIO4',
    alerting: alerts.has('temp_high') || alerts.has('temp_low') || faults.has('temperatureC'),
  });
  setCard('card-ph', {
    value: num(lastGood(r, 'pH'), 2),
    trendInfo: trend(r, 'pH', 0.005, 3, 'pH'),
    foot: faults.has('phVoltage') ? `⚠ probe fault · ${num(last?.phVoltage, 3)} V` : `${num(last?.phVoltage, 3)} V${cfg ? ` · safe ${cfg.ph.min}–${cfg.ph.max}` : ''}`,
    alerting: alerts.has('ph_low') || alerts.has('ph_high') || faults.has('phVoltage'),
  });
  // While the pet presses on the bowl the reading is meaningless: show the pre-visit value.
  const weight = dev.session.visiting ? null : lastGood(r, 'weightG');
  setCard('card-weight', {
    value: dev.session.visiting ? '…' : num(weight, 0),
    trendInfo: dev.session.visiting ? { cls: 'flat', text: 'pet at bowl' } : trend(r, 'weightG', 1, 1, 'g'),
    foot: faults.has('weightRaw') ? `⚠ load sensor fault · raw ${last?.weightRaw ?? '--'}` : `raw ${last?.weightRaw ?? '--'}${dev.today ? ` · ${dev.today.foodEatenG} g eaten today` : ''}`,
    alerting: faults.has('weightRaw'),
  });

  const dataNow = dev.lastTs ?? Date.now();
  const presence = document.getElementById('card-presence');
  presence.classList.toggle('visiting', !!dev.session.visiting);
  setCard('card-presence', {
    value: dev.session.visiting ? 'At the bowl' : 'Away',
    foot: dev.session.visiting
      ? `for ${duration((dataNow - dev.session.startTs) / 1000)} · faces ${last?.faces ?? 0}`
      : dev.lastVisitTs ? `last visit ${ago(dataNow - dev.lastVisitTs)}` : 'no visit yet',
    alerting: alerts.has('no_visit'),
  });
  renderDeviceCard(state, dev);
}

/** Device card changes every second (age), so it is separate and cheap. */
export function renderDeviceCard(state, dev) {
  if (!dev) return;
  const card = document.getElementById('card-device');
  $('[data-value]', card).textContent = dev.deviceId;
  const age = dev.lastReceivedAt != null ? Date.now() + state.clockOffset - dev.lastReceivedAt : null;
  // Also judge staleness locally, so the pill is honest while the server itself is unreachable.
  const stale = age != null && age > (state.config?.alerts.offlineSeconds ?? 10) * 1000;
  const online = dev.online && !stale;
  const pill = $('[data-pill]', card);
  pill.textContent = online ? 'online' : 'offline';
  pill.className = `pill small ${online ? 'online' : 'offline'}`;
  $('[data-foot]', card).textContent = `last update ${ago(age)}${dev.lastTs ? ` · ${clock(dev.lastTs, true)}` : ''}`;
  card.classList.toggle('alerting', !online);
}

const RULE_LABEL = {
  temperature: 'Temperature',
  water_ph: 'Water pH',
  no_visit: 'Visits',
  device_offline: 'Connectivity',
  sensor_fault: 'Sensor fault',
};

export function renderAlerts(state, { activeOnly, onAck }) {
  const list = document.getElementById('alert-list');
  const all = [...state.alerts.values()];
  const active = all.filter((a) => a.status === 'active');
  const unacked = active.filter((a) => !a.acknowledged).length;
  document.getElementById('alert-count').textContent = unacked ? String(unacked) : '';

  // Unacknowledged active first, then acknowledged active, then resolved; newest first within each.
  const rank = (a) => (a.status !== 'active' ? 2 : a.acknowledged ? 1 : 0);
  const shown = (activeOnly ? active : all).sort((a, b) => rank(a) - rank(b) || b.ts - a.ts).slice(0, 60);

  list.replaceChildren();
  if (!shown.length) {
    list.append(el('li', 'empty', activeOnly ? 'No active alerts. All good.' : 'No alerts yet.'));
    return;
  }
  for (const a of shown) {
    const li = el('li', `alert sev-${a.severity} ${a.status}`);
    li.append(el('div', 'alert-msg', a.message));
    const meta = `${RULE_LABEL[a.rule] ?? a.rule} · ${a.deviceId} · ${clock(a.ts)}${a.resolvedTs ? ` → ${clock(a.resolvedTs)}` : ''}`;
    li.append(el('div', 'alert-meta', meta));
    const side = el('div', 'alert-side');
    side.append(el('span', `tag ${a.status}`, a.status === 'active' ? a.severity : 'resolved'));
    if (a.status === 'active' && !a.acknowledged) {
      const b = el('button', 'ack', 'Acknowledge');
      b.type = 'button';
      b.addEventListener('click', () => onAck(a.id, b));
      side.append(b);
    } else if (a.acknowledged) side.append(el('span', 'acked', '✓ acknowledged'));
    li.append(side);
    list.append(li);
  }
}

export function renderVisits(state, dev) {
  if (!dev) return;
  const dataNow = dev.lastTs ?? Date.now();
  const from = dataNow - 86_400_000;
  const visits = state.events.filter((e) => e.type === 'visit_end' && e.deviceId === dev.deviceId && e.endTs >= from);

  const today = dev.today ?? { visits: 0, eatingS: 0, drinkingS: 0, foodEatenG: 0 };
  const todayEl = document.getElementById('today');
  todayEl.replaceChildren(
    ...[
      [today.visits, 'visits today'],
      [duration(today.eatingS), 'eating'],
      [duration(today.drinkingS), 'drinking'],
      [`${Math.round(today.foodEatenG)} g`, 'food eaten'],
    ].map(([v, label]) => {
      const d = el('div');
      d.append(el('b', null, String(v)), el('span', null, label));
      return d;
    }),
  );

  const tl = document.getElementById('timeline');
  tl.replaceChildren();
  const pos = (t) => `${(((t - from) / 86_400_000) * 100).toFixed(3)}%`;
  for (let h = 6; h < 24; h += 6) {
    const g = el('div', 'tl-grid');
    g.style.left = `${(h / 24) * 100}%`;
    tl.append(g);
  }
  for (const v of visits) {
    const b = el('div', `tl-visit ${v.kind}`);
    b.style.left = pos(Math.max(from, v.startTs));
    b.style.width = `${Math.max(0.25, ((v.endTs - Math.max(from, v.startTs)) / 86_400_000) * 100)}%`;
    b.title = `${clock(v.startTs)} ${v.kind} ${duration(v.durationS)}${v.foodEatenG ? ` · ${v.foodEatenG} g` : ''}`;
    tl.append(b);
  }
  if (dev.session.visiting) {
    const b = el('div', 'tl-visit current');
    b.style.left = pos(dev.session.startTs);
    b.style.width = `${Math.max(0.4, ((dataNow - dev.session.startTs) / 86_400_000) * 100)}%`;
    tl.append(b);
  }
  // hour labels below the strip
  const wrap = tl.parentElement.querySelector('.tl-labels') ?? tl.insertAdjacentElement('afterend', el('div', 'tl-labels'));
  wrap.replaceChildren(...[0, 6, 12, 18, 24].map((h) => el('span', null, h === 24 ? 'now' : clock(from + h * 3_600_000))));

  const list = document.getElementById('visit-list');
  list.replaceChildren();
  const recent = visits.slice(-8).reverse();
  if (dev.session.visiting) {
    const li = el('li');
    li.append(el('span', 'time', clock(dev.session.startTs)), el('span', null, `At the bowl now · ${duration((dataNow - dev.session.startTs) / 1000)}`), el('span', 'amount', '…'));
    list.append(li);
  }
  if (!recent.length && !dev.session.visiting) list.append(el('li', 'empty', 'No visits in the last 24 h.'));
  for (const v of recent) {
    const li = el('li');
    li.append(
      el('span', 'time', clock(v.startTs)),
      el('span', null, `${v.kind === 'eating' ? 'Ate' : 'Drank'} for ${duration(v.durationS)}`),
      el('span', 'amount', v.kind === 'eating' && v.foodEatenG != null ? `−${v.foodEatenG} g` : '—'),
    );
    list.append(li);
  }
}

export function renderConnection(status) {
  const pill = document.getElementById('conn');
  const text = pill.querySelector('.pill-text');
  pill.className = `pill ${status.state}`;
  if (status.state === 'live') text.textContent = 'Live';
  else if (status.state === 'demo') text.textContent = 'Simulated';
  else if (status.state === 'connecting') text.textContent = 'Connecting…';
  else {
    const secs = status.retryAt ? Math.max(0, Math.ceil((status.retryAt - Date.now()) / 1000)) : null;
    text.textContent = `Reconnecting…${secs != null ? ` ${secs}s` : ''}`;
  }
}
