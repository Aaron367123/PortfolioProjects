/**
 * Component type registry.
 *
 * Every type says which pins it has (pin lists may depend on its props, e.g.
 * the number of gate inputs), how long it takes to react (`delay`, in ticks),
 * what an unconnected input reads as (`floating`), and how to evaluate it.
 *
 * Kinds:
 *   source - drives a net from outside the logic (switch, button, clock, constant)
 *   gate   - combinational primitive, output = f(inputs) after `delay` ticks
 *   seq    - sequential primitive with internal state (D flip-flop)
 *   sink   - only observes a net (LED, probe, 7-segment display)
 *   chip   - SUBCIRCUIT; its pins come from the packaged circuit and it is
 *            flattened away before simulation (see netlist.js)
 */
import { GATE_FUNCTIONS, X } from './logic.js';

export const GATE_TYPES = Object.freeze(['AND', 'OR', 'XOR', 'NAND', 'NOR', 'XNOR']);
export const MIN_GATE_INPUTS = 2;
export const MAX_GATE_INPUTS = 4;

const none = () => [];
const single = (name) => () => [name];
const numbered = (prefix) => (props) =>
  Array.from({ length: props.inputs }, (_, i) => prefix + i);

function define(spec) {
  return Object.freeze({
    delay: 0,
    defaults: {},
    floating: {},
    inputs: none,
    outputs: none,
    ...spec,
  });
}

const gate = (type, title) =>
  define({
    kind: 'gate',
    title,
    delay: 1,
    defaults: { inputs: 2 },
    inputs: numbered('in'),
    outputs: single('out'),
    evaluate: GATE_FUNCTIONS[type],
  });

export const COMPONENTS = Object.freeze({
  INPUT: define({ kind: 'source', title: 'Switch', defaults: { value: 0 }, outputs: single('out') }),
  BUTTON: define({ kind: 'source', title: 'Push button', outputs: single('out') }),
  CLOCK: define({ kind: 'source', title: 'Clock', defaults: { period: 8 }, outputs: single('out') }),
  CONST: define({ kind: 'source', title: 'Constant', defaults: { value: 0 }, outputs: single('out') }),

  AND: gate('AND', 'AND gate'),
  OR: gate('OR', 'OR gate'),
  XOR: gate('XOR', 'XOR gate'),
  NAND: gate('NAND', 'NAND gate'),
  NOR: gate('NOR', 'NOR gate'),
  XNOR: gate('XNOR', 'XNOR gate'),
  NOT: define({
    kind: 'gate', title: 'Inverter', delay: 1,
    inputs: single('in'), outputs: single('out'), evaluate: GATE_FUNCTIONS.NOT,
  }),
  BUF: define({
    kind: 'gate', title: 'Buffer', delay: 1,
    inputs: single('in'), outputs: single('out'), evaluate: GATE_FUNCTIONS.BUF,
  }),

  OUTPUT: define({ kind: 'sink', title: 'LED', defaults: { color: 'led' }, inputs: single('in') }),
  PROBE: define({ kind: 'sink', title: 'Probe', inputs: single('in') }),
  SEG7: define({
    kind: 'sink', title: '7-segment display',
    inputs: () => ['d0', 'd1', 'd2', 'd3'],
  }),

  // Rising-edge D flip-flop with optional asynchronous active-high reset.
  // `init` is the power-on state: 0, 1 or 'X' (unknown, the default).
  // The reset pin is optional, so when unconnected it floats to 0 (inactive)
  // instead of X; every other floating input reads X.
  DFF: define({
    kind: 'seq', title: 'D flip-flop', delay: 1,
    defaults: { init: 'X' },
    floating: { rst: 0 },
    inputs: () => ['d', 'clk', 'rst'],
    outputs: () => ['q', 'qn'],
  }),

  SUBCIRCUIT: define({ kind: 'chip', title: 'Chip', defaults: { chip: '' } }),
});

export function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(COMPONENTS, type);
}

/** Props with the type's defaults filled in. */
export function withDefaults(comp) {
  return { ...COMPONENTS[comp.type].defaults, ...(comp.props ?? {}) };
}

/** Value an unconnected input pin reads: X unless the type says otherwise. */
export function floatingValue(type, pin) {
  const f = COMPONENTS[type].floating;
  return Object.prototype.hasOwnProperty.call(f, pin) ? f[pin] : X;
}

/* ------------------------------------------------------------------------ */
/* 7-segment decoding                                                         */
/* ------------------------------------------------------------------------ */

/**
 * Segment patterns for the hex digits 0-F (bit 0 = segment a ... bit 6 = g).
 *
 *    aaa
 *   f   b
 *    ggg
 *   e   c
 *    ddd
 *
 * Lower-case b and d keep them distinct from 8 and 0.
 */
export const SEGMENT_TABLE = Object.freeze([
  0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07,
  0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71,
]);

/** Lit segments for a 4-bit value as a string, e.g. 1 -> 'bc', 8 -> 'abcdefg'. */
export function hexToSegments(value) {
  const bits = SEGMENT_TABLE[value & 0xf];
  let lit = '';
  for (let i = 0; i < 7; i++) if (bits & (1 << i)) lit += 'abcdefg'[i];
  return lit;
}
