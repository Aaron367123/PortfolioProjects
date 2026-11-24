#!/usr/bin/env node
// bench.js - compile every example at -O0 and -O1, run both on the emulator
// and print a Markdown table of code size and executed instructions.
//
//   node bench.js        (or: npm run bench)

import { readdirSync, readFileSync } from 'node:fs';
import { compile } from './src/index.js';
import { runAsm } from './run.js';

const dir = new URL('./examples/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.mc')).sort();

const rows = [];
let total0 = 0;
let total1 = 0;
for (const file of files) {
  const source = readFileSync(new URL(file, dir), 'utf8');
  const [o0, o1] = [false, true].map((optimize) => {
    const result = compile(source, { optimize });
    if (!result.ok) throw new Error(`${file}: ${result.diagnostics.map((d) => d.text).join('\n')}`);
    return runAsm(result.asm);
  });
  if (o0.output !== o1.output) throw new Error(`${file}: -O0 and -O1 print different output`);
  total0 += o0.steps;
  total1 += o1.steps;
  const saved = (1 - o1.steps / o0.steps) * 100;
  rows.push(`| ${file} | ${o0.words} | ${o1.words} | ${o0.steps.toLocaleString('en-US')} | ${o1.steps.toLocaleString('en-US')} | ${saved.toFixed(1)}% |`);
}

console.log('| Example | Code words -O0 | Code words -O1 | Executed -O0 | Executed -O1 | Fewer executed |');
console.log('| ------- | -------------: | -------------: | -----------: | -----------: | -------------: |');
for (const row of rows) console.log(row);
console.log(`| **total** | | | ${total0.toLocaleString('en-US')} | ${total1.toLocaleString('en-US')} | ${((1 - total1 / total0) * 100).toFixed(1)}% |`);
