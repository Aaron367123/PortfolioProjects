# logic-sim

A digital logic circuit simulator that runs in the browser. You drag gates onto a board, wire them up, flip switches and watch the signals move through the circuit one gate delay at a time.

The engine (`src/`) is plain JavaScript ES modules. It has no dependencies and doesn't touch the DOM, so the same code runs under `node --test` and in the web demo. The demo copies it into `demos/logic-sim/engine/` byte for byte, and a test checks that the copies match.

## Features

- **Components:** switch, push button, clock (period set in ticks), constant 0/1, AND, OR, XOR, NAND, NOR and XNOR with 2 to 4 inputs, NOT, buffer, LED (green, amber, red or cyan), probe, 7-segment hex display, a built-in rising-edge D flip-flop with optional async reset, and **chips**: any circuit with labelled switches and LEDs can be packaged as a reusable component. Chips can contain other chips; recursive chips are rejected.
- **Event-driven simulation:** every gate has a 1-tick delay, so glitches, hazards and races show up. Values are 0, 1 and X. The simulator detects oscillation and reports which nets are in the loop and the loop's period. You can step one tick, run, or settle (run until stable). It records the history of watched signals for timing diagrams.
- **Analysis:** truth tables for combinational circuits (up to 8 inputs), critical path (longest gate-delay chain), and gate count after flattening chips.
- **Serialisation:** versioned JSON with validation. Share codes are deflate-compressed and base64url-encoded, short enough to fit in a URL hash.
- **Editor (demo):** an SVG "PCB" with drag-to-place parts, pin-to-pin wiring, orthogonal wire routing with rounded corners and junction dots, select, move, box-select and delete, pan and zoom (wheel, drag or pinch), snap to grid, and undo/redo. Wires take their colour from their value. Moving sparks show propagation. The demo also has a timing-diagram panel, a truth-table modal, package-as-chip, save/load, a share link, a light theme, and a bottom-sheet layout for phones.

## The simulation model

### Event queue and unit delay

The simulator doesn't re-evaluate the whole circuit on every tick. It only processes **events**, meaning scheduled changes to a net's value:

```
tick t:
  1. clocks whose half-period has elapsed toggle (stimulus)
  2. apply every event scheduled for t; collect nets that really changed
  3. evaluate each component fed by a changed net (once, even if several inputs changed)
  4. schedule each new output value at t + delay (1 tick) unless the net is already heading there
```

Pending events are kept in a **time wheel**: a ring of 16 buckets indexed by `time mod 16`, where each bucket is a `Map(net -> value)`. Delays are capped at 8 ticks, so scheduling never wraps around onto an unprocessed bucket, and adding or removing an event costs O(1). The work per tick grows with the circuit's *activity*, not its size. An idle 1000-gate circuit costs nothing.

A per-net `projected` value (the value the net will have once all its pending events are applied) stops a gate from scheduling the same value twice. Delays are **transport** delays: a pulse one tick wide still propagates.

### Why it shows glitches

Every gate really takes a tick, so paths of different lengths deliver their results at different times:

- `AND(A, NOT A)` should always be 0. But when A rises, the AND sees A=1 one tick before the inverter's output falls, and outputs a one-tick 1 pulse (a static hazard). `test/gates.test.js` checks the exact pulse.
- In a ripple-carry adder, the sum bits briefly show wrong values while the carry travels down the chain (`test/adders.test.js`).
- Releasing S=R=1 on a NOR latch at the same moment makes both gates flip together forever. Real hardware does this too and resolves it as metastability (`test/sequential.test.js`).

A **levelised** (zero-delay, topologically sorted) simulator evaluates each gate once per input change, in dependency order, so every output is instantly correct. That's faster for big synchronous designs and fine for checking logic, but it can't show hazards or races, and it needs special handling for feedback loops such as latches. The event-driven model handles feedback naturally, because a loop is just events scheduling more events. Its cost is that you have to detect loops that never settle.

### Measured timing (from the tests)

| Ripple-carry adder | Gates (flattened) | Critical path | Cin to Cout settle |
|---|---|---|---|
| 1 bit | 5 | 3 ticks | 2 ticks |
| 2 bits | 10 | 5 ticks | 4 ticks |
| 4 bits | 20 | 9 ticks | 8 ticks |
| 8 bits | 40 | 17 ticks | 16 ticks |

Each full adder (two half-adders and an OR) adds an AND and an OR to the carry path, which costs 2 ticks per bit. The delay grows linearly, as the theory says.

### Three-valued logic (0 / 1 / X)

X means unknown: a net nothing has driven yet, a floating input, or a flip-flop that has never been clocked. Gates follow Kleene logic, so a known value wins only when it decides the result on its own:

| | rule | examples |
|---|---|---|
| AND | any 0 gives 0, else any X gives X | `AND(0,X)=0`, `AND(1,X)=X` |
| OR | any 1 gives 1, else any X gives X | `OR(1,X)=1`, `OR(0,X)=X` |
| XOR | any X gives X | `XOR(1,X)=X` |
| NOT | X stays X | |

**Dangling inputs:** an unconnected input is high-impedance (Z) and reads as **X**, the way a floating CMOS input behaves in practice. The one exception is the D flip-flop's optional reset pin, which floats to 0 (inactive). The editor draws X wires as dashed red, which makes a forgotten connection easy to spot.

D flip-flop: a clean 0 to 1 clock edge copies D into Q. An edge involving X (0 to X, or X to 1) might or might not be a real edge, so Q keeps its value only if D agrees with it and becomes X otherwise. Reset=1 clears Q at once.

X is pessimistic. A ring of inverters that starts at X stays at X forever, and so does a toggle flip-flop (`D = NOT Q`) that is never reset. Real circuits use a reset for exactly this reason, and the counter example has one.

### Oscillation detection

In a circuit with no feedback, a stimulus (a switch flip or a clock edge) can only keep the circuit busy for **D** ticks, where D is the sum of all component delays, an upper bound on the longest path. If events are still pending more than D ticks after the last stimulus, some loop is oscillating. That gives a precise test with no arbitrary thresholds. The simulator then reports:

- the nets on the loop: nets that changed recently and whose drivers belong to a strongly connected component of the gate graph (found with Tarjan's algorithm at compile time; flip-flops break loops, so they're excluded)
- the period, measured from the gap between two rising edges on a loop net

The 5-stage ring oscillator example is reported as `oscillation, period 10`, and the tests check 3-, 5- and 7-stage rings. A per-tick event cap (`maxEventsPerTick`) also reports runaway activity as unstable.

## Subcircuits and flattening

A chip is a circuit stored in `chips` under a name. Its labelled INPUT and OUTPUT components become pins, ordered top to bottom by position. Before simulation, `compile()` flattens everything into primitive gates:

1. Expand recursively. A primitive inside instance `fa0`, which in turn sits inside `ha1`, gets the path `fa0/ha1/x1`. The chip's own INPUT and OUTPUT components aren't emitted. Instead, the chip pin node (`fa0.CIN`) is **aliased** to the inner pin node (`fa0/cin.out`), so chips add no delay.
2. Every wire and every alias is a `union()` in a union-find structure over pin-node strings.
3. Each resulting set is one net. Two primitive outputs in one set is a conflict; no driver means the net floats.

Recursion (`a -> b -> a`) is caught by a depth-first walk of the chip-usage graph, both during validation and during packaging. Gate count and critical path run on the flattened netlist: the 4-bit adder is 20 gates (8 XOR, 8 AND, 4 OR) across three levels of chips.

## Data model (JSON schema, version 1)

```json
{
  "schema": "logic-sim",
  "version": 1,
  "name": "half-adder",
  "description": "S = A XOR B, C = A AND B.",
  "components": [
    { "id": "A",  "type": "INPUT", "x": 80,  "y": 80, "label": "A", "props": { "value": 0 } },
    { "id": "x1", "type": "XOR",   "x": 240, "y": 80, "props": { "inputs": 2 } },
    { "id": "S",  "type": "OUTPUT","x": 400, "y": 100, "label": "S" }
  ],
  "wires": [
    { "from": "A.out", "to": "x1.in0" },
    { "from": "x1.out", "to": "S.in", "route": { "x": 340 } }
  ],
  "chips": { "half-adder": { "name": "...", "components": [], "wires": [], "chips": {} } }
}
```

| type | pins (in -> out) | props |
|---|---|---|
| `INPUT`, `BUTTON` | -> `out` | `value` (switch) |
| `CLOCK` | -> `out` | `period` (even, ticks) |
| `CONST` | -> `out` | `value` |
| `AND` `OR` `XOR` `NAND` `NOR` `XNOR` | `in0..in3` -> `out` | `inputs` (2-4), `delay` (1-8, default 1) |
| `NOT`, `BUF` | `in` -> `out` | `delay` |
| `OUTPUT`, `PROBE` | `in` | `color` (LED) |
| `SEG7` | `d0..d3` (d0 = LSB) | |
| `DFF` | `d`, `clk`, `rst` -> `q`, `qn` | `init` (0, 1, 'X') |
| `SUBCIRCUIT` | chip's pin labels | `chip` |

Validation rejects: unknown schema, a newer version, an unknown type, duplicate ids, wires to missing components or pins, output-to-output and input-to-input wires, **two wires into one input** (two outputs on one net), bad gate or clock props, unknown chips, unlabelled or duplicate chip pins, and recursive chips. `fromJSON` has a migration hook for future versions. `route` is an optional hint for the demo's wire router.

**Share links:** `encodeCircuit()` gives `'z' + base64url(deflate-raw(JSON))` using `CompressionStream`, or `'j' + base64url(JSON)` if that isn't available. The demo puts it in `#c=...`. The 4-bit adder, three levels of chips deep, encodes to about 1 KB.

## Using the engine

```js
import { CircuitBuilder, Simulator, truthTable, criticalPath, gateCount } from './src/index.js';

const b = new CircuitBuilder('half-adder');
const a = b.input('A'), c = b.input('B');
b.output('S', b.gate('XOR', [a, c]));
b.output('C', b.gate('AND', [a, c]));
const circuit = b.build();

const sim = new Simulator(circuit);
sim.setInput('A', 1);
sim.settle();                 // { stable: true, ticks: 1 }
sim.read('S');                // 1
truthTable(circuit).rows;     // [{ inputs: [0,0], outputs: ['0','0'] }, ...]
```

`Simulator` methods: `step()`, `run(n)`, `settle()`, `setInput()`, `toggle()`, `read()`, `readNumber()`, `display()`, `watch()`/`history()`, `reset()`, `pendingEvents` and `oscillation`.

## Running

```sh
npm test                # node --test: 67 tests
npm run examples        # regenerate examples/*.json from scripts/build-examples.js
npm run sync-demo       # copy src/ and examples/ into ../../demos/logic-sim/
```

The demo needs to be served over HTTP (ES modules), for example `python -m http.server` from the portfolio root, then open `demos/logic-sim/index.html`. URL parameters: `?example=4-bit-counter`, `?run=1`, `?theme=light|dark`, `?panel=timing|truth`, `?speed=25`, `?set=EN:1,A:0`, `#c=<share code>`.

Examples: half-adder, full-adder (from half-adder chips), 4-bit-adder (from full-adder chips), sr-latch (NOR), d-flip-flop (master-slave, NAND gates), 4-bit-counter (synchronous, on a 7-segment display), 2-to-4-decoder, 4-to-1-mux, traffic-light (Moore FSM), ring-oscillator.

## Layout

```
src/        logic.js (0/1/X), components.js (types, 7-seg), circuit.js (model, validation, chips),
            netlist.js (flattening, union-find, SCCs), simulator.js (event wheel), analysis.js,
            serialize.js, share.js, builder.js, index.js
examples/   10 circuits + index.json (generated by scripts/build-examples.js)
test/       gates, adders, sequential, oscillator, subcircuit, serialize, display, examples, demo-sync
```

## Limitations

- Unit (or small integer) delays only: no rise/fall asymmetry, no inertial filtering, no wire delay.
- Values are only 0/1/X. There's no high-impedance bus or tri-state driver (Z only exists as "floating input reads X"), and no wired-AND or wired-OR.
- X-pessimism: reconvergent X (`A AND NOT A` with A=X) gives X, not 0.
- Oscillation is only *proven* when no stimulus has occurred for D ticks. With a clock faster than that bound, a combinational loop is never flagged (you'll still see it oscillating).
- Flip-flops have no setup or hold check. D changing on the same tick as the clock edge uses the new D.
- Truth tables are limited to 8 inputs (256 rows), and each row is simulated by the event engine.
- The editor has no component rotation or manual wire bend points. Routing is automatic, with optional `route` hints in JSON.

## License

MIT © Aaron Morris Jara
