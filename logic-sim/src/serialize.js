/**
 * JSON serialisation with a versioned schema.
 *
 * toJSON() writes a normalised copy (fixed key order, empty fields dropped);
 * fromJSON() accepts a string or object, checks the schema tag and version,
 * migrates older versions, validates the structure and returns a clean copy.
 */
import { CircuitError, SCHEMA, SCHEMA_VERSION, validateCircuit } from './circuit.js';

/** Upgraders from version N to N+1. Version 1 is the first, so none yet. */
const MIGRATIONS = {};

function normaliseComponent(c) {
  const out = { id: c.id, type: c.type, x: c.x ?? 0, y: c.y ?? 0 };
  if (c.label !== undefined && c.label !== '') out.label = String(c.label);
  if (c.props && Object.keys(c.props).length) out.props = { ...c.props };
  return out;
}

function normaliseWire(w) {
  const out = { from: w.from, to: w.to };
  if (w.route && Object.keys(w.route).length) out.route = { ...w.route };
  return out;
}

function normaliseBody(c) {
  const body = {
    name: c.name ?? 'untitled',
    description: c.description ?? '',
    components: (c.components ?? []).map(normaliseComponent),
    wires: (c.wires ?? []).map(normaliseWire),
  };
  const chips = Object.entries(c.chips ?? {});
  if (chips.length) body.chips = Object.fromEntries(chips.map(([k, v]) => [k, normaliseBody(v)]));
  return body;
}

/** Plain object ready for JSON.stringify. */
export function toJSON(circuit) {
  return { schema: SCHEMA, version: SCHEMA_VERSION, ...normaliseBody(circuit) };
}

/** Pretty-printed JSON text. */
export function stringify(circuit, indent = 2) {
  return JSON.stringify(toJSON(circuit), null, indent);
}

/** Parse + migrate + validate. Throws CircuitError on any problem. */
export function fromJSON(input) {
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input); } catch (e) { throw new CircuitError(`not valid JSON: ${e.message}`); }
  }
  if (!data || typeof data !== 'object') throw new CircuitError('circuit must be a JSON object');
  if (data.schema !== SCHEMA) throw new CircuitError(`unknown schema "${data.schema}" (expected "${SCHEMA}")`);
  let version = data.version;
  if (!Number.isInteger(version) || version < 1) throw new CircuitError(`invalid schema version ${version}`);
  if (version > SCHEMA_VERSION) {
    throw new CircuitError(`file uses schema version ${version}; this simulator supports up to ${SCHEMA_VERSION}`);
  }
  while (version < SCHEMA_VERSION) data = MIGRATIONS[version++](data);
  const circuit = { ...toJSON(data), chips: normaliseBody(data).chips ?? {} };
  const errors = validateCircuit(circuit);
  if (errors.length) throw new CircuitError(errors[0], { errors });
  return circuit;
}
