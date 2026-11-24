/**
 * Generates examples/*.json (and examples/index.json) from code, so every
 * example is built with the same builder API the tests use and the layouts
 * stay reviewable. Run with: npm run examples
 *
 * Coordinates are pixels on a 20 px grid; pin offsets per component are
 * documented in the demo's ui/geometry.js (e.g. a 2-input gate has inputs at
 * (0,0) and (0,40) and its output at (80,20)). `route` hints steer the
 * demo's wire router for feedback wires: { y, x1, x2 } = detour channel,
 * { x } = vertical trunk position.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CircuitBuilder } from '../src/builder.js';
import { stringify, toJSON } from '../src/serialize.js';
import { validateCircuit } from '../src/circuit.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples');

/** A chip definition is a circuit body without schema/version. */
const asChip = (circuit) => {
  const { schema, version, ...body } = toJSON(circuit);
  void schema; void version;
  return body;
};

/* ---------------------------------------------------------------- */

function halfAdder() {
  const b = new CircuitBuilder('half-adder', 'S = A XOR B, C = A AND B. Two gates, one gate delay.');
  const A = b.input('A', { x: 80, y: 80 });
  const B = b.input('B', { x: 80, y: 220 });
  const s = b.add('XOR', { id: 'x1', x: 240, y: 80 });
  const c = b.add('AND', { id: 'a1', x: 240, y: 180 });
  b.wire(A, `${s}.in0`).wire(A, `${c}.in0`).wire(B, `${s}.in1`).wire(B, `${c}.in1`);
  b.output('S', `${s}.out`, { x: 400, y: 100 });
  b.output('C', `${c}.out`, { x: 400, y: 200 });
  return b.build();
}

function fullAdder() {
  const b = new CircuitBuilder('full-adder', 'Two half-adder chips and an OR gate. Cin -> Cout takes 2 gate delays.');
  b.defineChip('half-adder', asChip(halfAdder()));
  const A = b.input('A', { x: 60, y: 100 });
  const B = b.input('B', { x: 60, y: 160 });
  const CIN = b.input('CIN', { x: 60, y: 300 });
  const ha1 = b.chip('half-adder', { A, B }, { id: 'ha1', x: 200, y: 80 });
  const ha2 = b.chip('half-adder', { A: `${ha1}.S`, B: CIN }, { id: 'ha2', x: 380, y: 180 });
  const or = b.add('OR', { id: 'o1', x: 580, y: 240 });
  b.wire(`${ha2}.C`, `${or}.in0`).wire(`${ha1}.C`, `${or}.in1`, { x: 340 });
  b.output('S', `${ha2}.S`, { x: 720, y: 200 });
  b.output('COUT', `${or}.out`, { x: 720, y: 260 });
  return b.build();
}

/** n-bit ripple-carry adder built from full-adder chips (staircase layout). */
export function rippleAdder(bits = 4, { carryIn = false } = {}) {
  const b = new CircuitBuilder(`${bits}-bit-adder`,
    `${bits}-bit ripple-carry adder from full-adder chips (which contain half-adder chips). The carry ripples through every stage, 2 gate delays each.`);
  b.defineChip('full-adder', asChip(fullAdder()));
  let carry = carryIn
    ? b.input('CIN', { x: 60, y: 20 })
    : b.constant(0, { id: 'zero', x: 180, y: 140 });
  for (let i = 0; i < bits; i++) {
    const x = 260 + 160 * i, y = 40 + 120 * i;
    const A = b.input(`A${i}`, { x: 60, y: 60 + 120 * i });
    const B = b.input(`B${i}`, { x: 60, y: 100 + 120 * i });
    const fa = b.chip('full-adder', { A, B, CIN: carry }, { id: `fa${i}`, x, y });
    b.output(`S${i}`, `${fa}.S`, { x: 260 + 160 * bits, y: 60 + 120 * i });
    carry = `${fa}.COUT`;
  }
  b.output('COUT', carry, { x: 260 + 160 * bits, y: 40 + 120 * (bits - 1) + 80 });
  return b.build();
}

function srLatch() {
  const b = new CircuitBuilder('sr-latch',
    'Cross-coupled NOR latch. S sets Q, R resets it, both low holds. Releasing S and R together from 1/1 is a race: the latch oscillates in the unit-delay model.');
  const R = b.input('R', { x: 60, y: 100 });
  const S = b.input('S', { x: 60, y: 260 });
  b.add('NOR', { id: 'n1', x: 220, y: 100 });
  b.add('NOR', { id: 'n2', x: 220, y: 220 });
  b.wire(R, 'n1.in0').wire(S, 'n2.in1');
  b.wire('n1.out', 'n2.in0', { y: 170, x1: 320, x2: 200 });
  b.wire('n2.out', 'n1.in1', { y: 190, x1: 340, x2: 180 });
  b.output('Q', 'n1.out', { x: 420, y: 120 });
  b.output('QN', 'n2.out', { x: 420, y: 240 });
  return b.build();
}

function dFlipFlop() {
  const b = new CircuitBuilder('d-flip-flop',
    'Master-slave positive-edge D flip-flop from NAND gates: the master latch is open while CLK is low, the slave while CLK is high, so Q only takes D on a rising edge.');
  const D = b.input('D', { x: 40, y: 80, value: 1 });
  const CLK = b.clock('CLK', 16, { x: 40, y: 320 });
  b.add('NOT', { id: 'nd', x: 160, y: 160 });
  b.add('NOT', { id: 'nclk', x: 160, y: 320 });
  b.add('NAND', { id: 'm1', x: 300, y: 80 });
  b.add('NAND', { id: 'm2', x: 300, y: 200 });
  b.add('NAND', { id: 'mq', x: 440, y: 100 });
  b.add('NAND', { id: 'mqn', x: 440, y: 200 });
  b.add('NAND', { id: 's1', x: 640, y: 100 });
  b.add('NAND', { id: 's2', x: 640, y: 200 });
  b.add('NAND', { id: 'q', x: 780, y: 100 });
  b.add('NAND', { id: 'qn', x: 780, y: 200 });
  b.wire(D, 'm1.in0').wire(D, 'nd.in').wire('nd.out', 'm2.in0');
  b.wire(CLK, 'nclk.in').wire('nclk.out', 'm1.in1').wire('nclk.out', 'm2.in1');
  b.wire('m1.out', 'mq.in0').wire('m2.out', 'mqn.in1');
  b.wire('mq.out', 'mqn.in0', { y: 160, x1: 540, x2: 420 });
  b.wire('mqn.out', 'mq.in1', { y: 180, x1: 560, x2: 400 });
  b.wire('mq.out', 's1.in0').wire('mqn.out', 's2.in0');
  b.wire(CLK, 's1.in1', { x: 600 }).wire(CLK, 's2.in1', { x: 600 });
  b.wire('s1.out', 'q.in0').wire('s2.out', 'qn.in1');
  b.wire('q.out', 'qn.in0', { y: 160, x1: 880, x2: 760 });
  b.wire('qn.out', 'q.in1', { y: 180, x1: 900, x2: 740 });
  b.probe('MASTER', 'mq.out', { x: 600, y: 40 });
  b.output('Q', 'q.out', { x: 960, y: 120 });
  b.output('QN', 'qn.out', { x: 960, y: 220 });
  return b.build();
}

/** Synchronous 4-bit up-counter: 4 DFFs, an inverter, 3 XORs, 2 ANDs, shown on a 7-segment display. */
function counter4() {
  const b = new CircuitBuilder('4-bit-counter',
    'Synchronous 4-bit counter: bit i toggles when all lower bits are 1 (D = Q xor carry). Hold RST to clear it. The 7-segment display shows the count in hex.');
  const rowY = (i) => 60 + 180 * i;
  const CLK = b.clock('CLK', 8, { x: 360, y: 760 });
  const RST = `${b.add('BUTTON', { id: 'RST', label: 'RST', x: 360, y: 820 })}.out`;
  const xQ = [760, 740, 720, 700];                       // vertical feedback column per Q
  for (let i = 0; i < 4; i++) {
    b.dff({ id: `q${i}`, label: `FF${i}`, x: 560, y: rowY(i), init: 0, clk: null });
    b.wire(CLK, `q${i}.clk`, { x: 540 }).wire(RST, `q${i}.rst`, { x: 520 });
  }
  const Q = (i) => `q${i}.q`;
  const fb = (src, i, dst, y, x2) => b.wire(src, dst, { y, x1: xQ[i], x2 });
  // Bit 0 always toggles.
  b.add('NOT', { id: 'inv0', x: 440, y: 80 });
  b.wire('inv0.out', 'q0.d');
  fb(Q(0), 0, 'inv0.in', 40, 420);
  // Bit 1: D1 = Q1 xor Q0.
  b.add('XOR', { id: 'x1', x: 420, y: rowY(1) });
  b.wire('x1.out', 'q1.d');
  fb(Q(1), 1, 'x1.in0', rowY(1) - 20, 400);
  fb(Q(0), 0, 'x1.in1', rowY(1) - 40, 380);
  // Bit 2: D2 = Q2 xor (Q1 and Q0).
  b.add('XOR', { id: 'x2', x: 420, y: rowY(2) });
  b.add('AND', { id: 'c2', x: 300, y: rowY(2) + 20 });
  b.wire('c2.out', 'x2.in1').wire('x2.out', 'q2.d');
  fb(Q(2), 2, 'x2.in0', rowY(2) - 20, 400);
  fb(Q(0), 0, 'c2.in0', rowY(2) - 40, 280);
  fb(Q(1), 1, 'c2.in1', rowY(2) - 60, 260);
  // Bit 3: D3 = Q3 xor (Q2 and Q1 and Q0).
  b.add('XOR', { id: 'x3', x: 420, y: rowY(3) });
  b.add('AND', { id: 'c3', x: 300, y: rowY(3) + 20, inputs: 3 });
  b.wire('c3.out', 'x3.in1').wire('x3.out', 'q3.d');
  fb(Q(3), 3, 'x3.in0', rowY(3) - 20, 400);
  fb(Q(0), 0, 'c3.in0', rowY(3) - 40, 280);
  fb(Q(1), 1, 'c3.in1', rowY(3) - 60, 260);
  fb(Q(2), 2, 'c3.in2', rowY(3) - 80, 240);
  // Display + probes for the timing diagram.
  b.add('SEG7', { id: 'hex', label: 'COUNT', x: 900, y: 300 });
  [840, 820, 800, 780].forEach((x, i) => b.wire(Q(i), `hex.d${i}`, { x }));
  for (let i = 0; i < 4; i++) b.probe(`Q${i}`, Q(i), { id: `p${i}`, x: 900, y: rowY(i) + 20 });
  return b.build();
}

function decoder2to4() {
  const b = new CircuitBuilder('2-to-4-decoder', 'Exactly one output goes high: the one selected by A1 A0, while EN is high.');
  const A1 = b.input('A1', { x: 60, y: 60 });
  const A0 = b.input('A0', { x: 60, y: 160 });
  const EN = b.input('EN', { x: 60, y: 480, value: 1 });
  const nA1 = b.not(A1, { id: 'na1', x: 180, y: 60 });
  const nA0 = b.not(A0, { id: 'na0', x: 180, y: 160 });
  const terms = [[nA1, nA0], [nA1, A0], [A1, nA0], [A1, A0]];
  terms.forEach(([hi, lo], k) => {
    const g = b.gate('AND', [hi, lo, EN], { id: `y${k}g`, x: 440, y: 60 + 120 * k });
    b.output(`Y${k}`, g, { x: 600, y: 80 + 120 * k });
  });
  return b.build();
}

function mux4to1() {
  const b = new CircuitBuilder('4-to-1-mux', 'Y = D[S1 S0]: four AND-terms selected by the address lines, OR-ed together.');
  const S1 = b.input('S1', { x: 60, y: 40 });
  const S0 = b.input('S0', { x: 60, y: 100 });
  const nS1 = b.not(S1, { id: 'ns1', x: 180, y: 40 });
  const nS0 = b.not(S0, { id: 'ns0', x: 180, y: 100 });
  const sel = [[nS1, nS0], [nS1, S0], [S1, nS0], [S1, S0]];
  const terms = sel.map(([s1, s0], k) => {
    const D = b.input(`D${k}`, { x: 60, y: 180 + 100 * k, value: k === 1 || k === 2 ? 1 : 0 });
    return b.gate('AND', [D, s1, s0], { id: `t${k}`, x: 440, y: 180 + 100 * k });
  });
  const y = b.gate('OR', terms, { id: 'or4', x: 600, y: 270 });
  b.output('Y', y, { x: 740, y: 310 });
  return b.build();
}

function trafficLight() {
  const b = new CircuitBuilder('traffic-light',
    'Moore state machine on two D flip-flops: GREEN (00) -> AMBER (01) -> RED (10) -> GREEN. It only leaves green while REQ is high.');
  const CLK = b.clock('CLK', 16, { x: 220, y: 300 });
  const REQ = b.input('REQ', { x: 220, y: 200, value: 1 });
  b.dff({ id: 's0', label: 'S0', x: 480, y: 80, init: 0 });
  b.dff({ id: 's1', label: 'S1', x: 480, y: 260, init: 0 });
  b.add('NOR', { id: 'green', x: 200, y: 60 });
  b.add('AND', { id: 'go', x: 340, y: 80 });
  b.wire('green.out', 'go.in0').wire(REQ, 'go.in1').wire('go.out', 's0.d');
  b.wire(CLK, 's0.clk', { x: 460 }).wire(CLK, 's1.clk', { x: 460 });
  b.wire('s0.q', 's1.d', { y: 200, x1: 600, x2: 440 });
  b.wire('s0.q', 'green.in1', { y: 0, x1: 620, x2: 180 });
  b.wire('s1.q', 'green.in0', { y: 380, x1: 640, x2: 160 });
  b.output('GREEN', 'green.out', { x: 760, y: 40, color: 'led' });
  b.output('AMBER', 's0.q', { x: 760, y: 100, color: 'warn' });
  b.output('RED', 's1.q', { x: 760, y: 160, color: 'danger' });
  return b.build();
}

function ringOscillator() {
  const b = new CircuitBuilder('ring-oscillator',
    'A NAND and four inverters in a loop: five inversions, so no stable state. Flip EN to 1 and the instability detector reports the loop and its period (2 x 5 = 10 ticks).');
  const EN = b.input('EN', { x: 40, y: 100 });
  b.add('NAND', { id: 'g0', x: 160, y: 100 });
  b.wire(EN, 'g0.in0');
  let src = 'g0.out';
  [300, 400, 500, 600].forEach((x, i) => { src = b.not(src, { id: `inv${i + 1}`, x, y: 120 }); });
  b.wire(src, 'g0.in1', { y: 200, x1: 680, x2: 140 });
  b.output('OSC', src, { x: 760, y: 120 });
  b.probe('RING', src, { id: 'ring', x: 760, y: 60 });
  return b.build();
}

/* ---------------------------------------------------------------- */

export const EXAMPLES = [
  ['half-adder', 'Half adder', halfAdder],
  ['full-adder', 'Full adder (from half-adder chips)', fullAdder],
  ['4-bit-adder', '4-bit ripple-carry adder', () => rippleAdder(4)],
  ['sr-latch', 'SR latch (NOR)', srLatch],
  ['d-flip-flop', 'D flip-flop (master-slave, gates)', dFlipFlop],
  ['4-bit-counter', '4-bit counter + 7-segment', counter4],
  ['2-to-4-decoder', '2-to-4 decoder', decoder2to4],
  ['4-to-1-mux', '4:1 multiplexer', mux4to1],
  ['traffic-light', 'Traffic-light state machine', trafficLight],
  ['ring-oscillator', 'Ring oscillator (unstable)', ringOscillator],
];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(outDir, { recursive: true });
  const index = [];
  for (const [name, title, make] of EXAMPLES) {
    const circuit = make();
    const errors = validateCircuit(circuit);
    if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
    writeFileSync(join(outDir, `${name}.json`), stringify(circuit) + '\n');
    index.push({ name, title, description: circuit.description });
  }
  writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`wrote ${index.length} examples to ${outDir}`);
}
