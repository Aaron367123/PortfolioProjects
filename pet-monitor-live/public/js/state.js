/**
 * Client-side state, updated by applying protocol messages ({type, data}).
 * Pure data - rendering lives in views.js. The same reducer handles messages from the
 * WebSocket and from the in-browser demo.
 */
const MAX_READINGS = 3000; // per device, enough for the 1 min / 10 min windows
const MAX_ALERTS = 150;
const MAX_EVENTS = 400;

export function createState() {
  return {
    devices: new Map(), // deviceId -> device view-model
    selected: null,
    alerts: new Map(), // id -> alert (newest last)
    events: [], // visit events, oldest first
    config: null,
    clockOffset: 0, // server clock - browser clock (ms)
  };
}

function ensureDevice(state, id) {
  let d = state.devices.get(id);
  if (!d) {
    d = { deviceId: id, online: false, lastReceivedAt: null, lastTs: null, lastReading: null, session: { visiting: false }, lastVisitTs: null, today: null, faults: [], readings: [] };
    state.devices.set(id, d);
  }
  if (!state.selected) state.selected = id;
  return d;
}

function trim(arr, max) {
  if (arr.length > max * 1.1) arr.splice(0, arr.length - max); // trim in chunks, not per push
}

/**
 * Applies one message. Returns the set of things that changed so the UI can re-render
 * only what is needed.
 */
export function applyMessage(state, { type, data }) {
  const changed = new Set([type]);
  switch (type) {
    case 'snapshot': {
      state.clockOffset = data.serverTime - Date.now();
      state.config = data.config;
      state.devices.clear();
      for (const dev of data.devices) {
        const { readings, ...status } = dev;
        Object.assign(ensureDevice(state, dev.deviceId), status, { readings: readings.slice() });
      }
      if (state.selected && !state.devices.has(state.selected)) state.selected = data.devices[0]?.deviceId ?? null;
      state.alerts = new Map([...data.alerts].reverse().map((a) => [a.id, a]));
      state.events = data.events.slice();
      ['reading', 'alert', 'event', 'config', 'status'].forEach((c) => changed.add(c));
      break;
    }
    case 'reading': {
      const d = ensureDevice(state, data.deviceId);
      d.readings.push(data);
      trim(d.readings, MAX_READINGS);
      d.lastReading = data;
      d.lastTs = data.ts;
      d.lastReceivedAt = data.receivedAt;
      d.faults = data.faults;
      d.online = true;
      break;
    }
    case 'event': {
      const d = ensureDevice(state, data.deviceId);
      if (data.type === 'visit_start') d.session = { visiting: true, startTs: data.ts };
      if (data.type === 'visit_end') {
        d.session = { visiting: false };
        d.lastVisitTs = data.endTs;
        if (data.daily) d.today = data.daily;
      }
      state.events.push(data);
      trim(state.events, MAX_EVENTS);
      break;
    }
    case 'alert': {
      state.alerts.delete(data.id); // re-insert so updates move to the end
      state.alerts.set(data.id, data);
      if (state.alerts.size > MAX_ALERTS) state.alerts.delete(state.alerts.keys().next().value);
      break;
    }
    case 'status':
      Object.assign(ensureDevice(state, data.deviceId), { online: data.online, lastReceivedAt: data.lastReceivedAt });
      break;
    case 'config':
      state.config = data;
      break;
    case 'heartbeat':
    case 'pong':
      state.clockOffset = data.serverTime - Date.now();
      break;
    default:
      changed.clear(); // unknown message types are ignored (forward compatible)
  }
  return changed;
}

export function selectedDevice(state) {
  return state.selected ? state.devices.get(state.selected) : null;
}
