/** Public entry point of the logic-sim engine (pure ES modules, no DOM). */
export { ZERO, ONE, X, toLogic, fmt, and, or, xor, not, GATE_FUNCTIONS } from './logic.js';
export { COMPONENTS, GATE_TYPES, SEGMENT_TABLE, hexToSegments, withDefaults, floatingValue, isKnownType } from './components.js';
export {
  SCHEMA, SCHEMA_VERSION, CircuitError, createCircuit, parseRef, byPosition, nameOf, findChip,
  chipInterface, componentPins, validateCircuit, checkRecursion, cloneCircuit, packageAsChip,
} from './circuit.js';
export { compile, findCycles } from './netlist.js';
export { Simulator } from './simulator.js';
export { truthTable, criticalPath, gateCount, assertCombinational, circuitIO, MAX_TRUTH_TABLE_INPUTS } from './analysis.js';
export { toJSON, fromJSON, stringify } from './serialize.js';
export { encodeCircuit, decodeCircuit } from './share.js';
export { CircuitBuilder } from './builder.js';
