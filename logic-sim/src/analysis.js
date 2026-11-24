/**
 * Static and exhaustive analysis of circuits: truth tables, critical path,
 * gate count. All of them work on the flattened netlist, so chips count by
 * their contents.
 */
import { fmt } from './logic.js';
import { CircuitError, byPosition, nameOf } from './circuit.js';
import { compile } from './netlist.js';
import { Simulator } from './simulator.js';

export const MAX_TRUTH_TABLE_INPUTS = 8;
const LOGIC_GATES = new Set(['AND', 'OR', 'XOR', 'NAND', 'NOR', 'XNOR', 'NOT', 'BUF']);

/** Throws unless the circuit is purely combinational (no state, no loops). */
export function assertCombinational(flat) {
  const seq = flat.comps.find((c) => c.kind === 'seq' || c.type === 'CLOCK');
  if (seq) {
    throw new CircuitError(`sequential circuit: contains ${seq.type === 'CLOCK' ? 'a clock' : 'a flip-flop'} ("${seq.path}")`, { code: 'sequential' });
  }
  if (flat.cycles.length) {
    const loop = flat.cycles[0].map((ci) => flat.comps[ci].path).join(' -> ');
    throw new CircuitError(`sequential circuit: feedback loop ${loop}`, { code: 'sequential' });
  }
}

/** Top-level switches/buttons and LEDs in display order (by position). */
export function circuitIO(circuit) {
  const comps = [...circuit.components].sort(byPosition);
  return {
    inputs: comps.filter((c) => c.type === 'INPUT' || c.type === 'BUTTON'),
    outputs: comps.filter((c) => c.type === 'OUTPUT'),
  };
}

/**
 * Exhaustive truth table. Inputs are enumerated as a binary count with the
 * first (top-most) input as the most significant bit. Each row is computed
 * by the event-driven simulator, run until stable.
 *
 * -> { inputs: [names], outputs: [names], rows: [{ inputs: [0|1], outputs: ['0'|'1'|'X'] }],
 *      maxSettleTicks }
 */
export function truthTable(circuit, { maxInputs = MAX_TRUTH_TABLE_INPUTS } = {}) {
  const sim = new Simulator(circuit);
  assertCombinational(sim.flat);
  const io = circuitIO(circuit);
  if (!io.inputs.length) throw new CircuitError('no INPUT switches to enumerate', { code: 'no-inputs' });
  if (io.inputs.length > maxInputs) {
    throw new CircuitError(`${io.inputs.length} inputs is too many for a truth table (max ${maxInputs})`, { code: 'too-many-inputs' });
  }
  const n = io.inputs.length;
  const rows = [];
  let maxSettleTicks = 0;
  sim.settle();
  for (let r = 0; r < 2 ** n; r++) {
    const bits = io.inputs.map((_, j) => (r >> (n - 1 - j)) & 1);
    io.inputs.forEach((c, j) => sim.setInput(c.id, bits[j]));
    const res = sim.settle();
    maxSettleTicks = Math.max(maxSettleTicks, res.ticks);
    rows.push({ inputs: bits, outputs: io.outputs.map((c) => fmt(sim.read(c.id))) });
  }
  return { inputs: io.inputs.map(nameOf), outputs: io.outputs.map(nameOf), rows, maxSettleTicks };
}

/**
 * Critical path: the longest chain of gate delays from any source to any
 * sink, found by a longest-path pass over the netlist in topological order.
 * -> { depth, path: [component paths, source first] }
 */
export function criticalPath(circuit) {
  const flat = compile(circuit);
  assertCombinational(flat);
  const { comps, nets } = flat;
  const indeg = comps.map(() => 0);
  const succ = comps.map((c) => c.outputs.flatMap((n) => nets[n].sinks));
  succ.forEach((list) => list.forEach((s) => indeg[s]++));
  const dist = comps.map(() => 0);
  const prev = comps.map(() => -1);
  const queue = comps.map((_, i) => i).filter((i) => indeg[i] === 0);
  while (queue.length) {
    const ci = queue.shift();
    for (const s of succ[ci]) {
      const d = dist[ci] + comps[s].delay;
      if (d > dist[s]) { dist[s] = d; prev[s] = ci; }
      if (--indeg[s] === 0) queue.push(s);
    }
  }
  let end = -1;
  comps.forEach((c, i) => { if (end < 0 || dist[i] > dist[end]) end = i; });
  const path = [];
  for (let ci = end; ci >= 0; ci = prev[ci]) path.unshift(comps[ci].top ? comps[ci].label : comps[ci].path);
  return { depth: end < 0 ? 0 : dist[end], path };
}

/**
 * Gate count after flattening every chip.
 * -> { gates, flipFlops, primitives, byType: { AND: 4, ... } }
 */
export function gateCount(circuit) {
  const flat = compile(circuit);
  const byType = {};
  let gates = 0, flipFlops = 0;
  for (const c of flat.comps) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    if (LOGIC_GATES.has(c.type)) gates++;
    if (c.kind === 'seq') flipFlops++;
  }
  return { gates, flipFlops, primitives: flat.comps.length, byType };
}
