/**
 * Dashboard bootstrap.
 *
 *   data source (WebSocketSource | DemoSource)
 *        │  {type, data} messages
 *        ▼
 *   applyMessage(state) ──► dirty flags ──► requestAnimationFrame render
 *
 * The UI only knows the message protocol and the small source interface
 * (connect / getHistory / putConfig / acknowledge), so live and demo mode share every
 * line of UI code.
 */
import { MODE } from './mode.js';
import { WebSocketSource } from './ws-source.js';
import { DemoSource } from './demo-source.js';
import { createState, applyMessage, selectedDevice } from './state.js';
import { LineChart } from './charts.js';
import { renderCards, renderDeviceCard, renderAlerts, renderVisits, renderConnection } from './views.js';
import { createSettings } from './settings.js';
import { chooseBucketMs } from '../shared/history.js';

const params = new URLSearchParams(location.search);
const isDemo = MODE === 'demo' || params.has('demo');
const SPEEDS = [1, 10, 60];
const initialSpeed = SPEEDS.includes(Number(params.get('speed'))) ? Number(params.get('speed')) : 10;
const source = isDemo ? new DemoSource({ speed: initialSpeed }) : new WebSocketSource();

const state = createState();
const dirty = { cards: true, alerts: true, visits: true, charts: true };
let connection = { state: 'connecting' };
let windowMs = [60_000, 600_000, 3_600_000, 86_400_000].includes(Number(params.get('window'))) ? Number(params.get('window')) : 600_000;
let history = null; // {key, from, to, bucketMs, series: {metric: points}}
let historyTimer = null;

const charts = {
  temperatureC: new LineChart(document.getElementById('chart-temp'), { unit: '°C', decimals: 1, color: '--accent', minSpan: 4 }),
  pH: new LineChart(document.getElementById('chart-ph'), { unit: 'pH', decimals: 2, color: '--accent-2', minSpan: 0.6 }),
  weightG: new LineChart(document.getElementById('chart-weight'), { unit: 'g', decimals: 0, color: '--ok', minSpan: 40 }),
};

// ---- helpers -------------------------------------------------------------------------

function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

function setActive(groupId, attr, value) {
  for (const b of document.querySelectorAll(`#${groupId} button`)) b.classList.toggle('active', Number(b.dataset[attr]) === value);
}

function visitSpans(dev, from) {
  const spans = state.events
    .filter((e) => e.type === 'visit_end' && e.deviceId === dev.deviceId && e.endTs >= from)
    .map((e) => ({ from: e.startTs, to: e.endTs }));
  if (dev.session.visiting) spans.push({ from: dev.session.startTs, to: dev.lastTs });
  return spans;
}

function thresholds(metric) {
  const a = state.config?.alerts;
  if (!a) return {};
  if (metric === 'temperatureC') return { low: a.temperature.lowC, high: a.temperature.highC };
  if (metric === 'pH') return { low: a.ph.min, high: a.ph.max };
  return {};
}

// ---- charts ------------------------------------------------------------------------

const isLongWindow = () => windowMs > 600_000;

function drawCharts() {
  const dev = selectedDevice(state);
  if (!dev) return;
  if (isLongWindow()) {
    if (!history || history.key !== `${dev.deviceId}:${windowMs}`) return; // fetch in flight
    for (const [metric, chart] of Object.entries(charts)) {
      chart.setData({ kind: 'bucket', points: history.series[metric], from: history.from, to: history.to, bucketMs: history.bucketMs, spans: metric === 'weightG' ? visitSpans(dev, history.from) : [], ...thresholds(metric) });
    }
    return;
  }
  const to = dev.lastTs ?? Date.now();
  const from = to - windowMs;
  let i = dev.readings.length;
  while (i > 0 && dev.readings[i - 1].ts >= from) i--;
  const visible = dev.readings.slice(i);
  for (const [metric, chart] of Object.entries(charts)) {
    chart.setData({ kind: 'raw', points: visible.map((r) => ({ t: r.ts, v: r[metric] })), from, to, spans: metric === 'weightG' ? visitSpans(dev, from) : [], ...thresholds(metric) });
  }
}

async function loadHistory() {
  const dev = selectedDevice(state);
  if (!dev || !isLongWindow()) return;
  const to = dev.lastTs ?? Date.now();
  const from = to - windowMs;
  const bucketMs = chooseBucketMs(windowMs, 240);
  const key = `${dev.deviceId}:${windowMs}`;
  try {
    const results = await Promise.all(Object.keys(charts).map((metric) => source.getHistory({ metric, deviceId: dev.deviceId, from, to, bucketMs })));
    if (key !== `${selectedDevice(state)?.deviceId}:${windowMs}`) return; // user switched meanwhile
    history = { key, from, to, bucketMs: results[0].bucketMs, series: Object.fromEntries(Object.keys(charts).map((m, i) => [m, results[i].points])) };
    dirty.charts = true;
    schedule();
  } catch (err) {
    console.warn('history failed', err);
  }
}

function selectWindow(ms) {
  windowMs = ms;
  setActive('window-select', 'window', ms);
  clearInterval(historyTimer);
  if (isLongWindow()) {
    loadHistory();
    historyTimer = setInterval(loadHistory, isDemo ? 2000 : 5000);
  }
  dirty.charts = true;
  schedule();
}

// ---- render loop -------------------------------------------------------------------

let frame = 0;
let lastChartDraw = -Infinity;
let chartTimer = 0;
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(render);
  // Fallback: some embedders (hidden panes, throttled iframes) starve rAF; render anyway.
  setTimeout(() => {
    if (frame) {
      cancelAnimationFrame(frame);
      render();
    }
  }, 250);
}

function render() {
  frame = 0;
  const now = performance.now();
  const dev = selectedDevice(state);
  if (dirty.cards) renderCards(state, dev), (dirty.cards = false);
  if (dirty.alerts) renderAlerts(state, { activeOnly: document.getElementById('alerts-active-only').checked, onAck }), (dirty.alerts = false);
  if (dirty.visits) renderVisits(state, dev), (dirty.visits = false);
  if (dirty.charts) {
    // Readings can arrive at 60/s in fast simulations; ~8 chart redraws per second is plenty.
    if (now - lastChartDraw >= 120) {
      drawCharts();
      lastChartDraw = now;
      dirty.charts = false;
    } else if (!chartTimer) {
      chartTimer = setTimeout(() => {
        chartTimer = 0;
        schedule();
      }, 120 - (now - lastChartDraw));
    }
  }
}

function renderDeviceSelect() {
  const wrap = document.getElementById('device-wrap');
  const select = document.getElementById('device-select');
  const ids = [...state.devices.keys()];
  wrap.hidden = ids.length < 2;
  if (select.options.length !== ids.length) {
    select.replaceChildren(...ids.map((id) => new Option(id, id)));
  }
  select.value = state.selected ?? '';
}

// ---- message handling --------------------------------------------------------------

function onMessage(msg) {
  const changed = applyMessage(state, msg);
  if (!changed.size) return;
  if (changed.has('reading') || changed.has('status')) dirty.cards = dirty.charts = true;
  if (changed.has('event')) dirty.visits = dirty.cards = dirty.charts = true;
  if (changed.has('alert')) dirty.alerts = dirty.cards = true;
  if (changed.has('config')) {
    dirty.cards = dirty.charts = true;
    settings.onConfig();
  }
  if (msg.type === 'snapshot') {
    renderDeviceSelect();
    history = null;
    if (isLongWindow()) loadHistory();
  } else if (msg.type === 'reading' && state.devices.size !== document.getElementById('device-select').options.length) {
    renderDeviceSelect();
  }
  schedule();
}

async function onAck(id, button) {
  button.disabled = true;
  try {
    await source.acknowledge(id);
  } catch (err) {
    toast(err.message);
    button.disabled = false;
  }
}

// ---- wiring ------------------------------------------------------------------------

const settings = createSettings({ getConfig: () => state.config, source, toast });

document.getElementById('window-select').addEventListener('click', (e) => {
  const ms = Number(e.target.closest('button')?.dataset.window);
  if (ms) selectWindow(ms);
});
document.getElementById('alerts-active-only').addEventListener('change', () => {
  dirty.alerts = true;
  schedule();
});
document.getElementById('device-select').addEventListener('change', (e) => {
  state.selected = e.target.value;
  history = null;
  Object.keys(dirty).forEach((k) => (dirty[k] = true));
  if (isLongWindow()) loadHistory();
  schedule();
});
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  dirty.charts = true;
  schedule();
});

if (isDemo) {
  document.getElementById('demo-badge').hidden = false;
  const speed = document.getElementById('speed');
  speed.hidden = false;
  setActive('speed', 'speed', initialSpeed);
  speed.addEventListener('click', (e) => {
    const s = Number(e.target.closest('button')?.dataset.speed);
    if (!s) return;
    source.setSpeed(s);
    setActive('speed', 'speed', s);
  });
}

// Once a second: ages ("last update 3 s ago"), reconnect countdown.
setInterval(() => {
  renderDeviceCard(state, selectedDevice(state));
  if (connection.state === 'reconnecting') renderConnection(connection);
  dirty.cards = true;
  schedule();
}, 1000);

source.connect({
  onMessage,
  onStatus(s) {
    connection = s;
    renderConnection(s);
  },
});
selectWindow(windowMs);
