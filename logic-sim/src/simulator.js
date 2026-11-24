/**
 * Event-driven gate-level simulator with unit delay and 0/1/X values.
 *
 * Model
 * -----
 * Time advances in integer ticks. Each gate (and flip-flop) has a delay of
 * one tick: when an input net changes at tick t, the gate is re-evaluated at
 * t and its new output is *scheduled* for t + delay. Nothing else is
 * evaluated, so the work per tick is proportional to activity, not size.
 *
 * Pending changes live in a time wheel: a ring of buckets indexed by
 * (time mod WHEEL_SIZE), each a Map(net -> value). Delays are at most 8, so a
 * 16-slot ring never wraps onto an unprocessed bucket.
 *
 * Because every gate really takes a tick, unequal path lengths are visible:
 * AND(A, NOT A) outputs a one-tick 1 pulse when A rises (a static hazard),
 * and a ripple-carry adder's sum bits flicker until the carry arrives.
 * Delays are transport delays: every scheduled change is applied, even a
 * pulse one tick wide.
 *
 * Stability
 * ---------
 * In a circuit without feedback, all activity caused by a stimulus (a switch
 * flip or clock edge) dies out within D ticks, where D is the sum of all
 * component delays (a bound on the longest path). So if events are still
 * pending more than D ticks after the last stimulus, some loop is
 * oscillating. The simulator then reports the nets on that loop (from the
 * strongly connected components found at compile time) and its measured
 * period. A per-tick event cap guards against runaway activity as well.
 */
import { X, ONE, ZERO, not, toLogic, fmt } from './logic.js';
import { hexToSegments } from './components.js';
import { CircuitError } from './circuit.js';
import { compile } from './netlist.js';

const WHEEL_SIZE = 16;
const NO_TIME = -1;

export class Simulator {
  /**
   * @param {object} circuit - circuit JSON (see circuit.js)
   * @param {object} [options]
   * @param {number} [options.maxEventsPerTick=100000] - activity cap per tick
   * @param {number} [options.historyLimit=4000] - changes kept per watched signal
   */
  constructor(circuit, options = {}) {
    this.circuit = circuit;
    this.flat = compile(circuit);
    this.maxEventsPerTick = options.maxEventsPerTick ?? 100000;
    this.historyLimit = options.historyLimit ?? 4000;

    const { comps, nets } = this.flat;
    const n = nets.length;
    this.values = new Uint8Array(n);      // current value of every net
    this.projected = new Uint8Array(n);   // value after all pending events
    this.lastChange = new Float64Array(n);
    this.lastRise = new Float64Array(n);
    this.prevRise = new Float64Array(n);
    this.wheel = Array.from({ length: WHEEL_SIZE }, () => new Map());

    // Upper bound on how long a stimulus can keep an acyclic circuit busy.
    this.settleBound = comps.reduce((s, c) => s + c.delay, 0) + 1;
    this.loopNets = new Set(this.flat.cycles.flat().flatMap((ci) => comps[ci].outputs));

    this.sourceIdx = [];
    this.clockIdx = [];
    comps.forEach((c, ci) => {
      if (c.kind === 'source') this.sourceIdx.push(ci);
      if (c.type === 'CLOCK') this.clockIdx.push(ci);
    });

    // Switch / button levels survive reset(); start from the saved values.
    this.inputLevels = new Map();
    for (const ci of this.sourceIdx) {
      const c = comps[ci];
      if (c.type === 'INPUT' || c.type === 'CONST') this.inputLevels.set(ci, toLogic(c.props.value));
      if (c.type === 'BUTTON') this.inputLevels.set(ci, ZERO);
    }

    this.watched = new Map(); // net -> [[time, value], ...]
    this.reset();
  }

  /* ---------------------------------------------------------------- */
  /* Lifecycle                                                          */
  /* ---------------------------------------------------------------- */

  /** Back to tick 0: all nets X, flip-flops at their init state, clocks low. */
  reset() {
    const { comps } = this.flat;
    this.time = 0;
    this.values.fill(X);
    this.projected.fill(X);
    this.lastChange.fill(NO_TIME);
    this.lastRise.fill(NO_TIME);
    this.prevRise.fill(NO_TIME);
    for (const b of this.wheel) b.clear();
    this.lastStimulus = 0;
    this.lastChanged = [];
    this.eventCapHit = null;
    this.stats = { events: 0, evaluations: 0 };
    this._oscCache = { time: -1, value: null };

    this.state = comps.map((c) => {
      if (c.kind === 'seq') return { q: toLogic(c.props.init), prevClk: undefined };
      if (c.type === 'CLOCK') return { level: ZERO, count: 0, half: c.props.period / 2 };
      return null;
    });
    for (const list of this.watched.values()) list.splice(0, list.length, [0, X]);

    // Sources drive their nets immediately at t = 0 (they are the stimulus)...
    for (const ci of this.sourceIdx) {
      const level = comps[ci].type === 'CLOCK' ? ZERO : this.inputLevels.get(ci);
      this._set(comps[ci].outputs[0], level, 0);
    }
    // ...then every other component evaluates once and schedules its output.
    comps.forEach((c, ci) => {
      if (c.kind === 'seq' || c.kind === 'gate') this._evaluate(ci, 0);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Stimulus                                                           */
  /* ---------------------------------------------------------------- */

  /** Set a top-level switch or button (by id or label) to 0/1/X, now. */
  setInput(ref, value) {
    const ci = this._topComp(ref, ['INPUT', 'BUTTON']);
    const v = toLogic(value);
    this.inputLevels.set(ci, v);
    const net = this.flat.comps[ci].outputs[0];
    if (this.values[net] === v) return;
    this._set(net, v, this.time);
    this.lastStimulus = this.time;
    for (const sink of this.flat.nets[net].sinks) this._evaluate(sink, this.time);
  }

  /** Flip a switch; returns the new value. */
  toggle(ref) {
    const v = this.read(ref) === ONE ? ZERO : ONE;
    this.setInput(ref, v);
    return v;
  }

  /* ---------------------------------------------------------------- */
  /* Time                                                               */
  /* ---------------------------------------------------------------- */

  /**
   * Advance one tick: apply the events due now, then evaluate every
   * component whose inputs changed (scheduling their outputs for later).
   * With freezeClocks, clocks hold their level (used by settle()).
   * Returns the list of nets that changed this tick.
   */
  step({ freezeClocks = false } = {}) {
    const t = ++this.time;
    const { comps, nets } = this.flat;
    const bucket = this.wheel[t % WHEEL_SIZE];

    // 1. Clocks are stimulus: they toggle every period/2 ticks.
    if (!freezeClocks) {
      for (const ci of this.clockIdx) {
        const st = this.state[ci];
        if (++st.count >= st.half) {
          st.count = 0;
          st.level ^= 1;
          const net = comps[ci].outputs[0];
          bucket.set(net, st.level);
          this.projected[net] = st.level;
          this.lastStimulus = t;
        }
      }
    }

    // 2. Apply this tick's events; collect the components they feed.
    const changed = [];
    const dirty = new Set();
    for (const [net, v] of bucket) {
      if (this.values[net] === v) continue;
      this._set(net, v, t);
      changed.push(net);
      for (const ci of nets[net].sinks) dirty.add(ci);
    }
    bucket.clear();
    this.stats.events += changed.length;
    this.lastChanged = changed;

    if (changed.length > this.maxEventsPerTick && !this.eventCapHit) {
      this.eventCapHit = { reason: 'event-cap', time: t, nets: changed.map((n) => nets[n].name) };
    }

    // 3. Evaluate affected components; their outputs land in later buckets.
    for (const ci of dirty) this._evaluate(ci, t);
    return changed;
  }

  /** Run a fixed number of ticks (clocks running). */
  run(ticks) {
    for (let i = 0; i < ticks; i++) this.step();
    return this;
  }

  /**
   * Run with clocks held until no events are pending ("run until stable").
   * Returns { stable: true, ticks } or, for an oscillating circuit,
   * { stable: false, reason: 'oscillation', nets, period, ticks }.
   */
  settle({ maxTicks = 10000 } = {}) {
    const start = this.time;
    while (this.pendingEvents > 0) {
      if (this.eventCapHit) return { stable: false, ticks: this.time - start, ...this.eventCapHit };
      if (this.time - start >= maxTicks) {
        return { stable: false, reason: 'max-ticks', ticks: this.time - start, nets: this._recentNets(maxTicks) };
      }
      this.step({ freezeClocks: true });
      if (this.oscillation) {
        // Keep going until the loop's period has been measured.
        const limit = this.time + 4 * this.settleBound;
        while (this.oscillation.period === undefined && this.time < limit && this.pendingEvents > 0) {
          this.step({ freezeClocks: true });
        }
        const osc = this.oscillation;
        if (osc) return { stable: false, ticks: this.time - start, ...osc };
      }
    }
    return { stable: true, ticks: this.time - start };
  }

  /** Number of scheduled-but-not-applied net changes. */
  get pendingEvents() {
    let n = 0;
    for (const b of this.wheel) n += b.size;
    return n;
  }

  /**
   * null while the circuit is stable or still legitimately settling;
   * { reason: 'oscillation', nets, period } once activity has outlived every
   * acyclic path since the last stimulus.
   */
  get oscillation() {
    if (this._oscCache.time === this.time) return this._oscCache.value;
    let value = null;
    if (this.eventCapHit) value = this.eventCapHit;
    else if (this.pendingEvents > 0 && this.time - this.lastStimulus > this.settleBound) {
      const recent = this._recentNetIdx(this.settleBound);
      const loop = recent.filter((n) => this.loopNets.has(n));
      const involved = loop.length ? loop : recent;
      // Period = gap between the last two rising edges seen after the stimulus.
      let period;
      for (const n of involved) {
        if (this.prevRise[n] > this.lastStimulus) { period = this.lastRise[n] - this.prevRise[n]; break; }
      }
      value = { reason: 'oscillation', nets: involved.map((n) => this.flat.nets[n].name), period };
    }
    this._oscCache = { time: this.time, value };
    return value;
  }

  /* ---------------------------------------------------------------- */
  /* Reading values                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Net index for a reference: a pin node ('g1.out', 'fa0.COUT',
   * 'fa0/ha1/x1.out') or the id/label of a top-level switch, button, clock,
   * constant, LED or probe.
   */
  netOf(ref) {
    if (typeof ref === 'number') return ref;
    if (this.flat.nodeNet.has(ref)) return this.flat.nodeNet.get(ref);
    const ci = this._topComp(ref, ['INPUT', 'BUTTON', 'CLOCK', 'CONST', 'OUTPUT', 'PROBE']);
    const c = this.flat.comps[ci];
    if (c.kind === 'source') return c.outputs[0];
    return this.flat.nodeNet.get(`${c.path}.in`);
  }

  /** Current value (0, 1 or X) of a net / pin / named signal. */
  read(ref) {
    const net = this.netOf(ref);
    if (net === undefined) throw new CircuitError(`unknown signal "${ref}"`);
    return this.flat.nets[net].driver < 0 ? this._floatingAt(ref) : this.values[net];
  }

  /** Read several signals as a string, e.g. readBits(['Q3','Q2','Q1','Q0']) -> '0101'. */
  readBits(refs) {
    return refs.map((r) => fmt(this.read(r))).join('');
  }

  /** Read signals (MSB first) as an unsigned integer, or null if any is X. */
  readNumber(refs) {
    let v = 0;
    for (const r of refs) {
      const b = this.read(r);
      if (b === X) return null;
      v = v * 2 + b;
    }
    return v;
  }

  /** What a top-level 7-segment display shows: { value, segments } or null for X. */
  display(id) {
    const ci = this._topComp(id, ['SEG7']);
    const c = this.flat.comps[ci];
    let value = 0;
    for (let i = 3; i >= 0; i--) {
      const b = this._input(c, i);
      if (b === X) return null;
      value = value * 2 + b;
    }
    return { value, segments: hexToSegments(value), char: value.toString(16).toUpperCase() };
  }

  /** Internal state of a top-level D flip-flop (0, 1 or X). */
  flipFlopState(id) {
    return this.state[this._topComp(id, ['DFF'])].q;
  }

  /* ---------------------------------------------------------------- */
  /* History (timing diagrams)                                          */
  /* ---------------------------------------------------------------- */

  /** Start recording changes of a signal; returns its net index. */
  watch(ref) {
    const net = this.netOf(ref);
    if (!this.watched.has(net)) this.watched.set(net, [[this.time, this.values[net]]]);
    return net;
  }

  unwatch(ref) {
    this.watched.delete(this.netOf(ref));
  }

  /** Recorded [time, value] change list for a watched signal. */
  history(ref) {
    return this.watched.get(this.netOf(ref)) ?? [];
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                          */
  /* ---------------------------------------------------------------- */

  _set(net, v, t) {
    this.values[net] = v;
    this.projected[net] = v;
    this.lastChange[net] = t;
    if (v === ONE) {
      this.prevRise[net] = this.lastRise[net];
      this.lastRise[net] = t;
    }
    const h = this.watched.get(net);
    if (h) {
      h.push([t, v]);
      if (h.length > this.historyLimit) h.splice(0, h.length - this.historyLimit);
    }
  }

  /** Schedule net := v at time `at`, unless it is already heading there. */
  _drive(net, v, at) {
    if (this.projected[net] === v) return;
    this.projected[net] = v;
    this.wheel[at % WHEEL_SIZE].set(net, v);
  }

  _input(c, i) {
    const n = c.inputs[i];
    return n < 0 ? c.floating[i] : this.values[n];
  }

  _evaluate(ci, t) {
    const c = this.flat.comps[ci];
    this.stats.evaluations++;
    if (c.kind === 'gate') {
      const ins = c.inputs.map((_, i) => this._input(c, i));
      this._drive(c.outputs[0], c.evaluate(ins), t + c.delay);
    } else if (c.kind === 'seq') {
      this._evaluateFlipFlop(ci, c, t);
    }
  }

  /**
   * Rising-edge D flip-flop, inputs [d, clk, rst], outputs [q, qn].
   * - rst = 1 clears q immediately (asynchronous); rst = X makes q unknown
   *   unless it is already 0.
   * - a clean 0 -> 1 clock edge copies d into q.
   * - an edge involving X (0 -> X, X -> 1) might or might not be an edge, so
   *   q keeps its value only if d agrees with it, otherwise becomes X.
   */
  _evaluateFlipFlop(ci, c, t) {
    const st = this.state[ci];
    const d = this._input(c, 0), clk = this._input(c, 1), rst = this._input(c, 2);
    if (st.prevClk !== undefined) {
      const prev = st.prevClk;
      if (rst === ONE) st.q = ZERO;
      else if (rst === X && st.q !== ZERO) st.q = X;
      else if (prev === ZERO && clk === ONE) st.q = d;
      else if ((prev === ZERO && clk === X) || (prev === X && clk === ONE)) st.q = st.q === d ? st.q : X;
    } else if (rst === ONE) {
      st.q = ZERO;
    }
    st.prevClk = clk;
    this._drive(c.outputs[0], st.q, t + c.delay);
    this._drive(c.outputs[1], not(st.q), t + c.delay);
  }

  _floatingAt(ref) {
    // A floating net reads X (high impedance); flip-flop reset pins read 0.
    if (typeof ref === 'string' && ref.endsWith('.rst')) return ZERO;
    return X;
  }

  _topComp(ref, types) {
    const { comps, top } = this.flat;
    let ci = top.get(ref);
    if (ci === undefined) ci = comps.findIndex((c) => c.top && c.label === ref && types.includes(c.type));
    if (ci === undefined || ci < 0 || !types.includes(comps[ci].type)) {
      throw new CircuitError(`no top-level ${types.join('/')} named "${ref}"`);
    }
    return ci;
  }

  _recentNetIdx(window) {
    const since = this.time - window;
    const out = [];
    for (let n = 0; n < this.lastChange.length; n++) {
      if (this.lastChange[n] > since && this.lastChange[n] > this.lastStimulus) out.push(n);
    }
    return out;
  }

  _recentNets(window) {
    return this._recentNetIdx(window).map((n) => this.flat.nets[n].name);
  }
}
