/**
 * Circuit data model and structural validation.
 *
 * A circuit is plain JSON-friendly data:
 *
 *   {
 *     schema: 'logic-sim', version: 1, name, description,
 *     components: [{ id, type, x, y, label?, props? }],
 *     wires:      [{ from: 'g1.out', to: 'g2.in0', route? }],
 *     chips:      { 'full-adder': <circuit without schema/version> }
 *   }
 *
 * A wire connects one output pin to one input pin. All wires that leave the
 * same output pin form one net, so a net always has exactly one driver;
 * "two outputs on one net" can only be written as two wires into the same
 * input pin, which validation rejects.
 *
 * A SUBCIRCUIT component (props.chip = name) instantiates a circuit from
 * `chips`. Its pins are the labels of that circuit's INPUT and OUTPUT
 * components, ordered top-to-bottom by position (y, then x). Chip libraries
 * nest: a chip definition may carry its own `chips`, and names are looked up
 * from the innermost library outwards.
 */
import { COMPONENTS, GATE_TYPES, MAX_GATE_INPUTS, MIN_GATE_INPUTS, isKnownType, withDefaults } from './components.js';

export const SCHEMA = 'logic-sim';
export const SCHEMA_VERSION = 1;

/** Error type for invalid circuits; `details` carries the full error list. */
export class CircuitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CircuitError';
    this.details = details;
  }
}

export function createCircuit(name = 'untitled', description = '') {
  return { schema: SCHEMA, version: SCHEMA_VERSION, name, description, components: [], wires: [], chips: {} };
}

/** 'fa0.COUT' -> { id: 'fa0', pin: 'COUT' }. Ids may not contain '.' or '/'. */
export function parseRef(ref) {
  const dot = typeof ref === 'string' ? ref.lastIndexOf('.') : -1;
  if (dot <= 0 || dot === ref.length - 1) return null;
  return { id: ref.slice(0, dot), pin: ref.slice(dot + 1) };
}

/** Sort order used for chip pins and truth-table columns: top to bottom, then left to right. */
export function byPosition(a, b) {
  return (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0);
}

/** Display name of a component: its label, or its id. */
export function nameOf(comp) {
  return comp.label ? String(comp.label) : comp.id;
}

/** Look a chip name up in a chain of libraries, innermost first. */
export function findChip(name, scopes) {
  for (const lib of scopes) {
    if (lib && Object.prototype.hasOwnProperty.call(lib, name)) return lib[name];
  }
  return null;
}

/**
 * The pins a packaged circuit exposes: its INPUT and OUTPUT components,
 * in position order. Each entry is { label, id } (id = the inner component).
 */
export function chipInterface(def) {
  const pick = (type) =>
    def.components
      .filter((c) => c.type === type)
      .sort(byPosition)
      .map((c) => ({ label: String(c.label ?? ''), id: c.id }));
  return { inputs: pick('INPUT'), outputs: pick('OUTPUT') };
}

/** Pin names of a component. `scopes` resolves SUBCIRCUIT definitions. */
export function componentPins(comp, scopes = []) {
  const type = COMPONENTS[comp.type];
  if (!type) return { inputs: [], outputs: [] };
  if (type.kind === 'chip') {
    const def = findChip(comp.props?.chip, scopes);
    if (!def) return { inputs: [], outputs: [] };
    const iface = chipInterface(def);
    return { inputs: iface.inputs.map((p) => p.label), outputs: iface.outputs.map((p) => p.label) };
  }
  const props = withDefaults(comp);
  return { inputs: type.inputs(props), outputs: type.outputs(props) };
}

/**
 * Structural checks for one circuit level (and, recursively, every chip it
 * uses). Returns a list of human-readable error strings; empty = valid.
 */
export function validateCircuit(circuit, scopes = null, where = '') {
  const errors = [];
  const at = (msg) => errors.push(where ? `${where}: ${msg}` : msg);
  if (!circuit || !Array.isArray(circuit.components) || !Array.isArray(circuit.wires)) {
    return [`${where || 'circuit'}: needs "components" and "wires" arrays`];
  }
  const chain = scopes ?? [circuit.chips ?? {}];

  // Components: unique ids, known types, sane props.
  const byId = new Map();
  for (const c of circuit.components) {
    if (typeof c.id !== 'string' || !/^[A-Za-z_][\w-]*$/.test(c.id)) {
      at(`invalid component id ${JSON.stringify(c.id)} (letters, digits, _ and - only)`);
      continue;
    }
    if (byId.has(c.id)) at(`duplicate component id "${c.id}"`);
    byId.set(c.id, c);
    if (!isKnownType(c.type)) { at(`component "${c.id}" has unknown type "${c.type}"`); continue; }
    const p = withDefaults(c);
    if (GATE_TYPES.includes(c.type)) {
      if (!Number.isInteger(p.inputs) || p.inputs < MIN_GATE_INPUTS || p.inputs > MAX_GATE_INPUTS) {
        at(`gate "${c.id}" must have ${MIN_GATE_INPUTS}-${MAX_GATE_INPUTS} inputs`);
      }
    }
    if (COMPONENTS[c.type].kind === 'gate' && p.delay !== undefined) {
      if (!Number.isInteger(p.delay) || p.delay < 1 || p.delay > 8) at(`gate "${c.id}" delay must be 1-8 ticks`);
    }
    if (c.type === 'CLOCK' && (!Number.isInteger(p.period) || p.period < 2 || p.period % 2)) {
      at(`clock "${c.id}" period must be an even number of ticks >= 2`);
    }
    if (c.type === 'SUBCIRCUIT' && !findChip(p.chip, chain)) {
      at(`chip "${c.id}" uses unknown chip "${p.chip}"`);
    }
  }

  // Wires: existing endpoints, output -> input, one driver per input pin.
  const driverOf = new Map();
  circuit.wires.forEach((w, i) => {
    const from = parseRef(w.from), to = parseRef(w.to);
    if (!from || !to) { at(`wire ${i} needs "from" and "to" like "g1.out"`); return; }
    const src = byId.get(from.id), dst = byId.get(to.id);
    if (!src) { at(`wire ${i} starts at unknown component "${from.id}"`); return; }
    if (!dst) { at(`wire ${i} ends at unknown component "${to.id}"`); return; }
    if (!componentPins(src, chain).outputs.includes(from.pin)) {
      at(`wire ${i}: "${w.from}" is not an output pin`); return;
    }
    if (!componentPins(dst, chain).inputs.includes(to.pin)) {
      at(`wire ${i}: "${w.to}" is not an input pin`); return;
    }
    if (driverOf.has(w.to)) {
      at(`net conflict: input "${w.to}" is driven by both "${driverOf.get(w.to)}" and "${w.from}" (two outputs on one net)`);
    } else {
      driverOf.set(w.to, w.from);
    }
  });

  // A circuit used as a chip needs unique, non-empty pin labels.
  if (where) {
    const iface = chipInterface(circuit);
    for (const side of ['inputs', 'outputs']) {
      const seen = new Set();
      for (const p of iface[side]) {
        if (!p.label) at(`${side === 'inputs' ? 'INPUT' : 'OUTPUT'} "${p.id}" needs a label to be a chip pin`);
        else if (seen.has(p.label)) at(`duplicate chip pin label "${p.label}"`);
        seen.add(p.label);
      }
    }
  }

  // Recurse into each chip definition used here, once per name.
  if (!scopes) {
    try {
      checkRecursion(circuit);
    } catch (e) {
      errors.push(e.message);
      return errors;
    }
    const seen = new Set();
    const visit = (def, chainHere) => {
      for (const c of def.components) {
        if (c.type !== 'SUBCIRCUIT') continue;
        const name = c.props?.chip;
        const inner = findChip(name, chainHere);
        if (!inner || seen.has(name)) continue;
        seen.add(name);
        const innerChain = [inner.chips ?? {}, ...chainHere];
        errors.push(...validateCircuit(inner, innerChain, `chip "${name}"`));
        visit(inner, innerChain);
      }
    };
    visit(circuit, chain);
  }
  return errors;
}

/**
 * Throws if a chip contains itself, directly or through other chips.
 * Depth-first search over "chip uses chip" edges keeping the current path.
 */
export function checkRecursion(circuit, extraName = null) {
  const done = new Set();
  const walk = (def, chain, path) => {
    for (const c of def.components) {
      if (c.type !== 'SUBCIRCUIT') continue;
      const name = c.props?.chip;
      if (path.includes(name)) {
        throw new CircuitError(`recursive chip: ${[...path, name].join(' -> ')}`, { cycle: [...path, name] });
      }
      if (done.has(name)) continue;
      const inner = findChip(name, chain);
      if (!inner) continue;
      walk(inner, [inner.chips ?? {}, ...chain], [...path, name]);
      done.add(name);
    }
  };
  walk(circuit, [circuit.chips ?? {}], extraName ? [extraName] : []);
}

/** Deep copy via JSON (circuits are plain data). */
export function cloneCircuit(circuit) {
  return JSON.parse(JSON.stringify(circuit));
}

/**
 * Package a circuit as a reusable chip definition named `name`.
 * The result is self-contained (it keeps its own nested chip library).
 * Throws if it has no labelled pins or if it would contain itself.
 */
export function packageAsChip(circuit, name) {
  if (!name || typeof name !== 'string') throw new CircuitError('a chip needs a name');
  const iface = chipInterface(circuit);
  if (!iface.inputs.length || !iface.outputs.length) {
    throw new CircuitError('a chip needs at least one INPUT and one OUTPUT');
  }
  const def = {
    name,
    description: circuit.description ?? '',
    components: cloneCircuit(circuit.components),
    wires: cloneCircuit(circuit.wires),
    chips: cloneCircuit(circuit.chips ?? {}),
  };
  // Inside the new chip, a SUBCIRCUIT named `name` would refer to itself.
  checkRecursion(def, name);
  const errors = validateCircuit(def, [def.chips], `chip "${name}"`);
  if (errors.length) throw new CircuitError(errors[0], { errors });
  return def;
}
