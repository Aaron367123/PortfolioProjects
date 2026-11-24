#!/usr/bin/env node
// cli.js - compile a Mini-C file and (optionally) run it on the MIPS emulator.
//
//   node cli.js examples/fibonacci.mc            print the generated assembly
//   node cli.js examples/fibonacci.mc --run      compile, assemble and execute
//   node cli.js prog.mc -O0                      no optimisation (default is -O1)
//   node cli.js prog.mc --ast | --tokens         dump the AST or the token list
//   node cli.js prog.mc -o prog.asm              write the assembly to a file

import { readFileSync, writeFileSync } from 'node:fs';
import { compile } from './src/index.js';
import { runAsm } from './run.js';

const USAGE = 'Usage: node cli.js program.mc [--run] [-O0|-O1] [--ast] [--tokens] [--quiet] [-o out.asm]';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('-')));
const outIndex = args.indexOf('-o');
const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
const file = args.find((a, i) => !a.startsWith('-') && (outIndex < 0 || i !== outIndex + 1));

if (!file || flags.has('--help') || flags.has('-h')) {
  console.log(USAGE);
  process.exit(file ? 0 : 1);
}

const source = readFileSync(file, 'utf8');
const optimize = !flags.has('-O0');
const result = compile(source, { optimize });

for (const d of result.diagnostics) {
  console.error(`${file}:${d.text}\n`);
}
if (!result.ok) process.exit(1);

if (flags.has('--tokens')) {
  for (const t of result.tokens) {
    console.log(`${String(t.line).padStart(4)}:${String(t.col).padEnd(4)} ${t.type.padEnd(8)} ${t.text}`);
  }
} else if (flags.has('--ast')) {
  console.log(JSON.stringify(result.optimizedAst, astReplacer, 2));
} else if (outFile) {
  writeFileSync(outFile, result.asm);
  console.log(`wrote ${outFile} (${result.stats.instructions} instructions)`);
} else if (!flags.has('--run') && !flags.has('--quiet')) {
  process.stdout.write(result.asm);
}

if (flags.has('--run')) {
  const run = runAsm(result.asm);
  process.stdout.write(run.output);
  if (run.error) {
    console.error(`\nrun-time error: ${run.error}`);
    process.exit(2);
  }
  console.error(`\n[-O${optimize ? 1 : 0}] ${run.steps} instructions executed, ${run.words} words of code, ${run.haltReason}`);
}

/** Keep the AST dump readable: drop positions, summarise symbols. */
function astReplacer(key, value) {
  if (key === 'line' || key === 'col' || key === 'length') return undefined;
  if (key === 'symbol' && value) return `${value.kind} ${value.name}${value.offset !== undefined ? ` @ ${value.offset}($fp)` : ''}`;
  return value;
}
