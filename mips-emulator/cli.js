#!/usr/bin/env node
// cli.js - run a .asm file from the command line, printing the same reports
// as the original C program (machine code, register file, data memory dump).
//
//   node cli.js examples/swap.asm

import { readFileSync } from 'node:fs';
import { assemble } from './src/assembler.js';
import { CPU } from './src/cpu.js';
import { MipsError } from './src/errors.js';
import { disassemble, labelsByAddress } from './src/disassembler.js';

const file = process.argv[2];
if (!file) {
  console.log('Usage: node cli.js program.asm');
  process.exit(1);
}

try {
  const program = assemble(readFileSync(file, 'utf8'));
  const names = labelsByAddress(program.labels);

  console.log('---- Code Section ----');
  program.listing.forEach((entry, i) => {
    const word = entry.word.toString(16).toUpperCase().padStart(8, '0');
    console.log(`The machine code at instruction ${i} is ${word}   ${disassemble(entry.word, entry.address, names)}`);
  });

  const cpu = new CPU();
  cpu.onOutput = (text) => process.stdout.write(text);
  cpu.load(program);
  console.log('\n---- Program output ----');
  cpu.run();
  console.log(`\n\nHalted after ${cpu.steps} instructions: ${cpu.haltReason}`);

  console.log('\n---- Register File ----');
  console.log(cpu.registerDump());
  console.log('\n---- Data Section ----');
  console.log(cpu.dataDump(256));
} catch (err) {
  if (err instanceof MipsError) {
    console.error(`Error: ${err.describe()}`);
    process.exit(2);
  }
  throw err;
}
