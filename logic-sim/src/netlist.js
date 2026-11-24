/**
 * Netlist compiler: turns a (possibly nested) circuit into a flat list of
 * primitive components connected by numbered nets.
 *
 * Subcircuit flattening works on *pin nodes*, strings like "fa0/ha1/x1.out":
 *
 *   1. Expand recursively. Every primitive inside a chip instance gets a path
 *      prefix ("fa0/ha1/x1"). The chip's INPUT/OUTPUT components are not
 *      emitted; instead the chip pin node ("fa0.CIN") is aliased to the inner
 *      pin node ("fa0/cin.out"), so chips add zero delay.
 *   2. Every wire and every alias is a union() in a union-find structure.
 *   3. Each resulting set of nodes is one electrical net. A net may have at
 *      most one primitive output driving it; no driver means it floats.
 *
 * Union-find keeps this linear-ish and order-independent: it does not matter
 * whether the alias or the wire is seen first.
 */
import { COMPONENTS, floatingValue, withDefaults } from './components.js';
import { CircuitError, chipInterface, findChip, nameOf, validateCircuit } from './circuit.js';

const MAX_DEPTH = 32;

/** Minimal union-find (disjoint set) over string keys, with path halving. */
class UnionFind {
  constructor() { this.parent = new Map(); }
  add(a) { if (!this.parent.has(a)) this.parent.set(a, a); }
  find(a) {
    this.add(a);
    let p = this.parent;
    while (p.get(a) !== a) {
      p.set(a, p.get(p.get(a)));
      a = p.get(a);
    }
    return a;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

/**
 * compile(circuit) -> {
 *   comps: [{ path, id, type, kind, label, props, top, delay,
 *             inputNames, outputNames, inputs: [net|-1], outputs: [net], floating: [value] }],
 *   nets:  [{ name, driver: compIndex|-1, sinks: [compIndex] }],
 *   nodeNet: Map(pinNode -> net), top: Map(topLevelId -> compIndex),
 *   cycles: [[compIndex...]]   // combinational feedback loops (strongly connected components)
 * }
 */
export function compile(circuit) {
  const errors = validateCircuit(circuit);
  if (errors.length) throw new CircuitError(errors[0], { errors });

  const uf = new UnionFind();
  const prims = [];

  const expand = (def, scopes, prefix, stack, isTop) => {
    if (stack.length > MAX_DEPTH) throw new CircuitError(`chips nested deeper than ${MAX_DEPTH} levels`);
    for (const c of def.components) {
      const path = prefix + c.id;
      if (c.type === 'SUBCIRCUIT') {
        const name = c.props?.chip;
        if (stack.includes(name)) throw new CircuitError(`recursive chip: ${[...stack, name].join(' -> ')}`);
        const chip = findChip(name, scopes);
        const inner = path + '/';
        const iface = chipInterface(chip);
        // Alias chip pins to the inner INPUT/OUTPUT components' pins.
        for (const p of iface.inputs) uf.union(`${path}.${p.label}`, `${inner}${p.id}.out`);
        for (const p of iface.outputs) uf.union(`${path}.${p.label}`, `${inner}${p.id}.in`);
        expand(chip, [chip.chips ?? {}, ...scopes], inner, [...stack, name], false);
        continue;
      }
      // Inside a chip, INPUT/OUTPUT are pins, already aliased above.
      if (!isTop && (c.type === 'INPUT' || c.type === 'OUTPUT')) continue;
      const type = COMPONENTS[c.type];
      const props = withDefaults(c);
      const inputNames = type.inputs(props);
      const outputNames = type.outputs(props);
      prims.push({
        path, id: c.id, type: c.type, kind: type.kind, label: nameOf(c), props, top: isTop,
        delay: type.kind === 'gate' ? (props.delay ?? type.delay) : type.delay,
        inputNames, outputNames,
        floating: inputNames.map((pin) => floatingValue(c.type, pin)),
        evaluate: type.evaluate ?? null,
      });
      for (const pin of [...inputNames, ...outputNames]) uf.add(`${path}.${pin}`);
    }
    for (const w of def.wires) uf.union(prefix + w.from, prefix + w.to);
  };
  expand(circuit, [circuit.chips ?? {}], '', [], true);

  // One net per union-find set.
  const nets = [];
  const rootNet = new Map();
  const nodeNet = new Map();
  for (const node of uf.parent.keys()) {
    const root = uf.find(node);
    let n = rootNet.get(root);
    if (n === undefined) {
      n = nets.length;
      rootNet.set(root, n);
      nets.push({ name: node, driver: -1, sinks: [] });
    }
    nodeNet.set(node, n);
  }

  // Attach drivers and sinks; reject two drivers on one net.
  const top = new Map();
  prims.forEach((p, ci) => {
    if (p.top) top.set(p.id, ci);
    p.outputs = p.outputNames.map((pin) => {
      const n = nodeNet.get(`${p.path}.${pin}`);
      const net = nets[n];
      if (net.driver >= 0) {
        const other = prims[net.driver];
        throw new CircuitError(`net conflict: "${other.path}" and "${p.path}.${pin}" both drive one net`);
      }
      net.driver = ci;
      net.name = p.top && p.kind === 'source' ? p.label : `${p.path}.${pin}`;
      return n;
    });
  });
  prims.forEach((p, ci) => {
    p.inputs = p.inputNames.map((pin) => {
      const n = nodeNet.get(`${p.path}.${pin}`);
      if (nets[n].driver < 0) return -1; // floating input: reads p.floating[i]
      if (!nets[n].sinks.includes(ci)) nets[n].sinks.push(ci);
      return n;
    });
  });

  return { comps: prims, nets, nodeNet, top, cycles: findCycles(prims, nets) };
}

/**
 * Combinational feedback loops: strongly connected components (Tarjan) of the
 * gate graph, with edges driver -> sink. Flip-flops break loops (their output
 * only changes on a clock edge), so they are left out of the graph.
 */
export function findCycles(comps, nets) {
  const isNode = (ci) => comps[ci].kind === 'gate';
  const succ = comps.map((c, ci) =>
    isNode(ci) ? c.outputs.flatMap((n) => nets[n].sinks.filter(isNode)) : []);
  const index = new Array(comps.length).fill(-1);
  const low = new Array(comps.length).fill(0);
  const onStack = new Array(comps.length).fill(false);
  const stack = [];
  const cycles = [];
  let counter = 0;

  // Iterative Tarjan to avoid deep recursion on long gate chains.
  for (let start = 0; start < comps.length; start++) {
    if (!isNode(start) || index[start] >= 0) continue;
    const work = [[start, 0]];
    index[start] = low[start] = counter++;
    stack.push(start); onStack[start] = true;
    while (work.length) {
      const frame = work[work.length - 1];
      const [v, i] = frame;
      if (i < succ[v].length) {
        frame[1]++;
        const w = succ[v][i];
        if (index[w] < 0) {
          index[w] = low[w] = counter++;
          stack.push(w); onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1][0];
          low[parent] = Math.min(low[parent], low[v]);
        }
        if (low[v] === index[v]) {
          const scc = [];
          let w;
          do { w = stack.pop(); onStack[w] = false; scc.push(w); } while (w !== v);
          if (scc.length > 1 || succ[v].includes(v)) cycles.push(scc.reverse());
        }
      }
    }
  }
  return cycles;
}
