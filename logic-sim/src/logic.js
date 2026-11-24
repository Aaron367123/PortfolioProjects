/**
 * Three-valued logic: 0, 1 and X.
 *
 * X means "unknown": a net nobody has driven yet, a floating (unconnected)
 * input, or a flip-flop that has never been clocked. The gate functions follow
 * Kleene's strong logic, so a known value wins whenever it decides the result
 * on its own: AND(0, X) = 0 (a single 0 forces the output low), but
 * AND(1, X) = X (the answer depends on the unknown input).
 *
 * Values are small integers so they fit in a Uint8Array inside the simulator.
 */

export const ZERO = 0;
export const ONE = 1;
export const X = 2;

/** Normalise user / JSON input (0, 1, true, '1', 'X', ...) to 0 | 1 | X. */
export function toLogic(v) {
  if (v === 0 || v === false || v === '0') return ZERO;
  if (v === 1 || v === true || v === '1') return ONE;
  return X;
}

/** Display form: '0', '1' or 'X'. */
export function fmt(v) {
  return v === X ? 'X' : String(v);
}

export function not(a) {
  return a === X ? X : a ^ 1;
}

/** AND: any 0 forces 0; otherwise any X gives X; otherwise 1. */
export function and(ins) {
  let unknown = false;
  for (const v of ins) {
    if (v === ZERO) return ZERO;
    if (v === X) unknown = true;
  }
  return unknown ? X : ONE;
}

/** OR: any 1 forces 1; otherwise any X gives X; otherwise 0. */
export function or(ins) {
  let unknown = false;
  for (const v of ins) {
    if (v === ONE) return ONE;
    if (v === X) unknown = true;
  }
  return unknown ? X : ZERO;
}

/** XOR (odd parity): no input value can decide it alone, so any X gives X. */
export function xor(ins) {
  let parity = 0;
  for (const v of ins) {
    if (v === X) return X;
    parity ^= v;
  }
  return parity;
}

/** Evaluation function for every combinational primitive, keyed by type. */
export const GATE_FUNCTIONS = Object.freeze({
  AND: and,
  OR: or,
  XOR: xor,
  NAND: (ins) => not(and(ins)),
  NOR: (ins) => not(or(ins)),
  XNOR: (ins) => not(xor(ins)),
  NOT: (ins) => not(ins[0]),
  BUF: (ins) => ins[0],
});
