/**
 * Small fluent helper for building circuits in code (tests, example
 * generator). Methods that create a component with one output return its
 * output pin reference, so gates compose like expressions:
 *
 *   const b = new CircuitBuilder('half-adder');
 *   const a = b.input('A'), c = b.input('B');
 *   b.output('S', b.gate('XOR', [a, c]));
 *   b.output('C', b.gate('AND', [a, c]));
 *   const circuit = b.build();
 */
import { createCircuit } from './circuit.js';
import { COMPONENTS } from './components.js';

export class CircuitBuilder {
  constructor(name = 'untitled', description = '') {
    this.circuit = createCircuit(name, description);
    this.counters = {};
  }

  /** Add any component; returns its id. */
  add(type, { id, label, x = 0, y = 0, ...props } = {}) {
    const n = (this.counters[type] = (this.counters[type] ?? 0) + 1);
    const cid = id ?? `${type.toLowerCase()}${n}`;
    const comp = { id: cid, type, x, y };
    if (label !== undefined) comp.label = label;
    if (Object.keys(props).length) comp.props = props;
    this.circuit.components.push(comp);
    return cid;
  }

  /** Connect an output pin to an input pin. */
  wire(from, to, route) {
    const w = { from, to };
    if (route) w.route = route;
    this.circuit.wires.push(w);
    return this;
  }

  input(label, opts = {}) {
    return `${this.add('INPUT', { label, id: opts.id ?? label, ...opts })}.out`;
  }

  clock(label, period = 8, opts = {}) {
    return `${this.add('CLOCK', { label, id: opts.id ?? label, period, ...opts })}.out`;
  }

  constant(value, opts = {}) {
    return `${this.add('CONST', { value, ...opts })}.out`;
  }

  output(label, src, opts = {}) {
    const id = this.add('OUTPUT', { label, id: opts.id ?? label, ...opts });
    if (src) this.wire(src, `${id}.in`);
    return id;
  }

  probe(label, src, opts = {}) {
    const id = this.add('PROBE', { label, ...opts });
    if (src) this.wire(src, `${id}.in`);
    return id;
  }

  /** Gate with sources wired to in0..inN (or 'in' for NOT/BUF). */
  gate(type, srcs, opts = {}) {
    const single = COMPONENTS[type].kind === 'gate' && (type === 'NOT' || type === 'BUF');
    const props = single ? opts : { inputs: srcs.length, ...opts };
    const id = this.add(type, props);
    srcs.forEach((s, i) => s && this.wire(s, `${id}.${single ? 'in' : 'in' + i}`));
    return `${id}.out`;
  }

  not(src, opts) { return this.gate('NOT', [src], opts); }

  /** D flip-flop; returns its id (pins: d, clk, rst -> q, qn). */
  dff({ d, clk, rst, ...opts } = {}) {
    const id = this.add('DFF', opts);
    if (d) this.wire(d, `${id}.d`);
    if (clk) this.wire(clk, `${id}.clk`);
    if (rst) this.wire(rst, `${id}.rst`);
    return id;
  }

  /** Register a chip definition in this circuit's library. */
  defineChip(name, def) {
    this.circuit.chips[name] = def;
    return this;
  }

  /** Instantiate a chip; `pins` maps input pin label -> source ref. Returns the id. */
  chip(name, pins = {}, opts = {}) {
    const id = this.add('SUBCIRCUIT', { chip: name, ...opts });
    for (const [pin, src] of Object.entries(pins)) if (src) this.wire(src, `${id}.${pin}`);
    return id;
  }

  build() {
    return this.circuit;
  }
}
