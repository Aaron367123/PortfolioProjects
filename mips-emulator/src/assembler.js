// assembler.js - a two-pass MIPS assembler.
//
// It follows the same plan as parser.c + lab7.c from the C labs:
//
//   Pass 1 (parse_MIPS, first loop)
//     Walk every line, remember where each label is, work out how many bytes
//     every data directive needs and how many words every instruction needs.
//     After pass 1 every label has an address, including labels that are used
//     before they are defined ("forward references", e.g. `bge $s0, $a1, exit`).
//
//   Pass 2 (parse_MIPS second loop + setupInstructionMemory)
//     Fill in the data bytes and encode every instruction into a 32-bit word,
//     now that all label addresses are known.
//
// Supported syntax
//   labels        name:   (several labels and an instruction may share a line)
//   comments      # to the end of the line
//   segments      .text  .data   (.globl / .global are accepted and ignored)
//   data          .byte  .half  .word  .ascii  .asciiz  .space  .align
//   registers     $zero $at $v0 ... $ra, or by number $0 ... $31
//   numbers       42  -7  0x2A  0b101010  'A'
//
// Alignment: like real MIPS assemblers (MARS, SPIM), .half is aligned to 2
// bytes and .word to 4 bytes. In the course test program `counter: .byte 32`
// comes first, so testdata1 moves from offset 1 to offset 4. Without this the
// lw/sw instructions would make unaligned word accesses, which real MIPS
// hardware rejects.

import { INSTRUCTIONS, REGISTER_NAMES, TEXT_BASE, DATA_BASE, TEXT_LIMIT, MEMORY_SIZE } from './isa.js';
import { encodeInstruction } from './encoder.js';
import { MipsError, hex32 } from './errors.js';

const LABEL_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const LABEL_AT_START = /^([A-Za-z_][A-Za-z0-9_.]*)\s*:/;
const DATA_DIRECTIVES = ['.byte', '.half', '.word', '.ascii', '.asciiz', '.space', '.align'];

/**
 * Assemble MIPS source code.
 *
 * @param {string} source the whole .asm file
 * @returns {{
 *   textBase: number, dataBase: number, codeEnd: number,
 *   text: number[],          // machine words, text[i] lives at textBase + 4*i
 *   data: Uint8Array,        // initial contents of the data section
 *   labels: Map<string, number>,  // label -> absolute address
 *   listing: {address: number, word: number, line: number, source: string, pseudo: string|null}[]
 * }}
 * @throws {MipsError} on the first error found, with .line set
 */
export function assemble(source) {
  const state = {
    segment: 'text',          // MARS/SPIM start in .text if no directive is given
    textOffset: 0,            // bytes of code so far
    dataOffset: 0,            // bytes of data so far
    labels: new Map(),
    pendingDataLabels: [],    // data labels waiting for the (possibly aligned) address of the next item
    instructions: [],         // filled in pass 1, encoded in pass 2
    dataItems: [],            // filled in pass 1, written in pass 2
  };

  // ---- Pass 1: labels, sizes and addresses ----
  const lines = source.split(/\r?\n/);
  lines.forEach((text, index) => passOneLine(state, text, index + 1));
  definePendingLabels(state);

  // ---- Pass 2: write data bytes and encode instructions ----
  const data = new Uint8Array(state.dataOffset);
  for (const item of state.dataItems) {
    writeDataItem(item, data, state.labels);
  }

  const text = [];
  const listing = [];
  for (const inst of state.instructions) {
    const word = encodeLine(inst, state.labels);
    text.push(word);
    listing.push({ address: inst.address, word, line: inst.line, source: inst.source, pseudo: inst.pseudo });
  }

  return {
    textBase: TEXT_BASE,
    dataBase: DATA_BASE,
    codeEnd: TEXT_BASE + text.length * 4,
    text,
    data,
    labels: state.labels,
    listing,
  };
}

// ===========================================================================
// Pass 1
// ===========================================================================

function passOneLine(state, rawText, line) {
  let text = stripComment(rawText).trim();

  // Peel off any labels at the start of the line ("loop:", "exit:", ...).
  let match;
  while ((match = LABEL_AT_START.exec(text)) !== null) {
    defineLabel(state, match[1], line);
    text = text.slice(match[0].length).trim();
  }
  if (text === '') return;

  // The first word is the directive or mnemonic, the rest are its operands.
  const firstSpace = text.search(/\s/);
  const head = (firstSpace < 0 ? text : text.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace < 0 ? '' : text.slice(firstSpace).trim();

  if (head.startsWith('.')) {
    handleDirective(state, head, rest, line);
  } else {
    handleInstruction(state, head, rest, line, text);
  }
}

function defineLabel(state, name, line) {
  const alreadyPending = state.pendingDataLabels.some((p) => p.name === name);
  if (state.labels.has(name) || alreadyPending) {
    throw new MipsError(`Duplicate label '${name}'`, { line });
  }
  if (state.segment === 'text') {
    state.labels.set(name, TEXT_BASE + state.textOffset);
  } else {
    // A data label gets its address when the next data item is placed,
    // because that item may be moved forward to satisfy alignment.
    state.pendingDataLabels.push({ name, line });
  }
}

function definePendingLabels(state) {
  for (const pending of state.pendingDataLabels) {
    state.labels.set(pending.name, DATA_BASE + state.dataOffset);
  }
  state.pendingDataLabels = [];
}

function handleDirective(state, name, rest, line) {
  if (name === '.text' || name === '.data') {
    if (rest !== '') {
      throw new MipsError(`'${name}' with an address is not supported (code is always at ${hex32(TEXT_BASE)}, data at ${hex32(DATA_BASE)})`, { line });
    }
    definePendingLabels(state);
    state.segment = name === '.text' ? 'text' : 'data';
    return;
  }
  if (name === '.globl' || name === '.global') {
    return; // only meaningful for linkers; ignored like in parser.c
  }
  if (!DATA_DIRECTIVES.includes(name)) {
    throw new MipsError(`Unknown directive '${name}'`, { line });
  }
  if (state.segment !== 'data') {
    throw new MipsError(`'${name}' is only allowed in the .data section`, { line });
  }

  const item = parseDataDirective(name, rest, line);

  // Move forward to the required boundary, then give waiting labels this address.
  state.dataOffset = alignUp(state.dataOffset, item.alignment);
  definePendingLabels(state);

  item.offset = state.dataOffset;
  state.dataItems.push(item);
  state.dataOffset += item.size;

  if (DATA_BASE + state.dataOffset > MEMORY_SIZE) {
    throw new MipsError('Data section does not fit in memory', { line });
  }
}

/** Work out a data directive's values, size and alignment (pass 1). */
function parseDataDirective(directive, rest, line) {
  const item = { directive, line, values: [], size: 0, alignment: 1, offset: 0 };

  switch (directive) {
    case '.byte':
      item.values = parseNumberList(rest, -128, 255, directive, line);
      item.size = item.values.length;
      break;

    case '.half':
      item.values = parseNumberList(rest, -32768, 65535, directive, line);
      item.size = item.values.length * 2;
      item.alignment = 2;
      break;

    case '.word': {
      // .word may contain labels (their addresses are filled in during pass 2).
      const tokens = splitOperands(rest);
      if (tokens.length === 0) throw new MipsError('.word needs at least one value', { line });
      for (const token of tokens) {
        const value = parseNumber(token);
        if (value === null && !LABEL_NAME.test(token)) {
          throw new MipsError(`Bad .word value '${token}'`, { line });
        }
        if (value !== null && (value < -0x80000000 || value > 0xffffffff)) {
          throw new MipsError(`.word value '${token}' does not fit in 32 bits`, { line });
        }
      }
      item.values = tokens;
      item.size = tokens.length * 4;
      item.alignment = 4;
      break;
    }

    case '.ascii':
    case '.asciiz':
      item.values = parseStringLiteral(rest, line);
      if (directive === '.asciiz') item.values.push(0); // NUL terminator
      item.size = item.values.length;
      break;

    case '.space': {
      const size = parseNumber(rest);
      if (size === null || size < 0) throw new MipsError(`.space needs a byte count, got '${rest}'`, { line });
      item.size = size;
      break;
    }

    case '.align': {
      const power = parseNumber(rest);
      if (power === null || power < 0 || power > 8) throw new MipsError(`.align needs a power of two between 0 and 8, got '${rest}'`, { line });
      item.alignment = 2 ** power;
      break;
    }
  }
  return item;
}

function parseNumberList(text, min, max, directive, line) {
  const tokens = splitOperands(text);
  if (tokens.length === 0) throw new MipsError(`${directive} needs at least one value`, { line });
  return tokens.map((token) => {
    const value = parseNumber(token);
    if (value === null) throw new MipsError(`Bad ${directive} value '${token}'`, { line });
    if (value < min || value > max) throw new MipsError(`${directive} value ${token} is out of range (${min}..${max})`, { line });
    return value;
  });
}

function handleInstruction(state, mnemonic, operandText, line, sourceText) {
  if (state.segment !== 'text') {
    throw new MipsError(`Instruction '${mnemonic}' found in the .data section (put code after .text)`, { line });
  }
  const operands = splitOperands(operandText);
  const realInstructions = expandPseudo(mnemonic, operands, line);

  for (const inst of realInstructions) {
    state.instructions.push({
      mnemonic: inst.mnemonic,
      operands: inst.operands,
      line,
      source: sourceText,
      address: TEXT_BASE + state.textOffset,
      pseudo: inst.mnemonic === mnemonic ? null : mnemonic, // remember "li" etc. for the listing
    });
    state.textOffset += 4;
  }

  if (state.textOffset > TEXT_LIMIT - TEXT_BASE) {
    throw new MipsError(`Code section is full: code must fit below the data section at ${hex32(DATA_BASE)}`, { line });
  }
}

/**
 * Turn a pseudo-instruction into one or more real instructions.
 * Real instructions are returned unchanged. This happens in pass 1 because
 * the number of words (li can need two) decides the addresses of later labels.
 */
function expandPseudo(mnemonic, operands, line) {
  const expect = (count, usage) => {
    if (operands.length !== count) {
      throw new MipsError(`'${mnemonic}' expects ${count} operand(s): ${usage}`, { line });
    }
  };

  switch (mnemonic) {
    case 'nop':
      expect(0, 'nop');
      return [{ mnemonic: 'sll', operands: ['$zero', '$zero', '0'] }];

    case 'move':
      expect(2, 'move rd, rs');
      return [{ mnemonic: 'addu', operands: [operands[0], operands[1], '$zero'] }];

    case 'b':
      expect(1, 'b label');
      return [{ mnemonic: 'beq', operands: ['$zero', '$zero', operands[0]] }];

    case 'beqz':
      expect(2, 'beqz rs, label');
      return [{ mnemonic: 'beq', operands: [operands[0], '$zero', operands[1]] }];

    case 'bnez':
      expect(2, 'bnez rs, label');
      return [{ mnemonic: 'bne', operands: [operands[0], '$zero', operands[1]] }];

    case 'li': {
      expect(2, 'li rt, value');
      const value = parseNumber(operands[1]);
      if (value === null) throw new MipsError(`li expects a number, got '${operands[1]}'`, { line });
      if (value < -0x80000000 || value > 0xffffffff) throw new MipsError(`li value ${operands[1]} does not fit in 32 bits`, { line });

      if (value >= -32768 && value <= 32767) {
        return [{ mnemonic: 'addiu', operands: [operands[0], '$zero', String(value)] }];
      }
      if (value >= 0 && value <= 0xffff) {
        return [{ mnemonic: 'ori', operands: [operands[0], '$zero', String(value)] }];
      }
      // A full 32-bit constant needs two instructions: upper half, then lower half.
      const bits = value >>> 0;
      return [
        { mnemonic: 'lui', operands: ['$at', String(bits >>> 16)] },
        { mnemonic: 'ori', operands: [operands[0], '$at', String(bits & 0xffff)] },
      ];
    }

    default:
      if (!INSTRUCTIONS[mnemonic]) {
        throw new MipsError(`Unknown instruction '${mnemonic}'`, { line });
      }
      return [{ mnemonic, operands }];
  }
}

// ===========================================================================
// Pass 2
// ===========================================================================

function writeDataItem(item, data, labels) {
  let p = item.offset;
  switch (item.directive) {
    case '.byte':
      for (const value of item.values) data[p++] = value & 0xff;
      break;

    case '.half':
      for (const value of item.values) {
        data[p++] = value & 0xff;
        data[p++] = (value >>> 8) & 0xff;
      }
      break;

    case '.word':
      for (const token of item.values) {
        let value = parseNumber(token);
        if (value === null) {
          if (!labels.has(token)) throw new MipsError(`Undefined label '${token}'`, { line: item.line });
          value = labels.get(token);
        }
        // little-endian, same as the LITTLE_ENDIAN branch of addData() in parser.c
        data[p++] = value & 0xff;
        data[p++] = (value >>> 8) & 0xff;
        data[p++] = (value >>> 16) & 0xff;
        data[p++] = (value >>> 24) & 0xff;
      }
      break;

    case '.ascii':
    case '.asciiz':
      data.set(item.values, p);
      break;

    // .space and .align leave zeros behind, which Uint8Array already has.
  }
}

/** Check the operands of one real instruction and encode it into a word. */
function encodeLine(inst, labels) {
  const { mnemonic, operands, line } = inst;
  const spec = INSTRUCTIONS[mnemonic];
  const pattern = spec.operands === '' ? [] : spec.operands.split(',');

  if (operands.length !== pattern.length) {
    const usage = [mnemonic, pattern.map((k) => (k === 'mem' ? 'offset(rs)' : k)).join(', ')].join(' ').trim();
    throw new MipsError(`'${mnemonic}' expects ${pattern.length} operand(s): ${usage}`, { line });
  }

  const fields = { rs: 0, rt: 0, rd: 0, shamt: 0, immediate: 0, address: 0 };

  pattern.forEach((kind, i) => {
    const token = operands[i];
    switch (kind) {
      case 'rd':
      case 'rs':
      case 'rt':
        fields[kind] = parseRegister(token, line);
        break;

      case 'shamt':
        fields.shamt = parseNumberInRange(token, 0, 31, 'shift amount', line);
        break;

      case 'imm':
        fields.immediate = spec.imm === 'unsigned'
          ? parseNumberInRange(token, 0, 0xffff, 'unsigned 16-bit immediate', line)
          : parseNumberInRange(token, -32768, 32767, 'signed 16-bit immediate', line);
        break;

      case 'mem': {
        const { offset, base } = parseMemoryOperand(token, line);
        fields.immediate = offset;
        fields.rs = base;
        break;
      }

      case 'label':
        if (spec.format === 'J') {
          fields.address = jumpTarget(token, inst, labels);
        } else if (mnemonic === 'la') {
          fields.immediate = loadAddress(token, inst, labels);
        } else {
          fields.immediate = branchOffset(token, inst, labels);
        }
        break;
    }
  });

  return encodeInstruction(mnemonic, fields);
}

/**
 * Branch offset = number of instructions between the instruction after the
 * branch (PC + 4) and the target. This is the same calculation as lab7.c,
 * where the parser stored the target's instruction index and the encoder did
 * `immediate -= (i + 1)` with i = index of the branch itself.
 */
function branchOffset(token, inst, labels) {
  const target = lookupLabel(token, labels, inst.line);
  const offset = (target - (inst.address + 4)) / 4;
  if (offset < -32768 || offset > 32767) {
    throw new MipsError(`Branch target '${token}' is too far away`, { line: inst.line });
  }
  return offset;
}

/** J-type field = target address / 4 (parser.c: findLabel(op) >> 2). */
function jumpTarget(token, inst, labels) {
  let target = parseNumber(token);
  if (target === null) target = lookupLabel(token, labels, inst.line);
  if (target < TEXT_BASE || target % 4 !== 0) {
    throw new MipsError(`Jump target ${hex32(target)} is not a word-aligned code address`, { line: inst.line });
  }
  return target >>> 2;
}

/**
 * The course-defined `la` instruction keeps the address in its 16-bit
 * immediate field (lab7.c / lab8.c). We store the real address (0x2000 +
 * offset for data labels), so the address in the register points at the data.
 */
function loadAddress(token, inst, labels) {
  const address = lookupLabel(token, labels, inst.line);
  if (address > 0xffff) {
    throw new MipsError(`la can only reach addresses up to 0xFFFF ('${token}' is at ${hex32(address)})`, { line: inst.line });
  }
  return address;
}

function lookupLabel(token, labels, line) {
  if (!labels.has(token)) {
    if (token.startsWith('$')) throw new MipsError(`Expected a label, got register '${token}'`, { line });
    throw new MipsError(`Undefined label '${token}'`, { line });
  }
  return labels.get(token);
}

// ===========================================================================
// Small parsing helpers (exported so the tests can check them directly)
// ===========================================================================

/** Register name ($t0) or number ($8) -> 0..31. Port of getRegNum() in parser.c. */
export function parseRegister(token, line = null) {
  const index = REGISTER_NAMES.indexOf(token.toLowerCase());
  if (index >= 0) return index;
  const numbered = /^\$(\d{1,2})$/.exec(token);
  if (numbered && Number(numbered[1]) < 32) return Number(numbered[1]);
  throw new MipsError(`Bad register '${token}'`, { line });
}

/** Decimal, hex (0x), binary (0b) or character ('a', '\n'). Returns null if it is not a number. */
export function parseNumber(token) {
  const text = token.trim();

  const char = /^'(\\?.)'$/.exec(text);
  if (char) {
    const escapes = { '\\n': 10, '\\t': 9, '\\0': 0, '\\r': 13, '\\\\': 92, "\\'": 39 };
    if (char[1].length === 2) return escapes[char[1]] ?? null;
    return char[1].charCodeAt(0);
  }

  const match = /^([-+]?)(0x[0-9a-f]+|0b[01]+|\d+)$/i.exec(text);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const digits = match[2].toLowerCase();
  let value;
  if (digits.startsWith('0x')) value = parseInt(digits.slice(2), 16);
  else if (digits.startsWith('0b')) value = parseInt(digits.slice(2), 2);
  else value = parseInt(digits, 10);
  return sign * value;
}

function parseNumberInRange(token, min, max, what, line) {
  const value = parseNumber(token);
  if (value === null) throw new MipsError(`Expected a number for the ${what}, got '${token}'`, { line });
  if (value < min || value > max) throw new MipsError(`${token} is out of range for a ${what} (${min}..${max})`, { line });
  return value;
}

/** "8($sp)" -> { offset: 8, base: 29 }. "($t0)" means offset 0. */
function parseMemoryOperand(token, line) {
  const match = /^(.*)\((\$[A-Za-z0-9]+)\)$/.exec(token);
  if (!match) {
    throw new MipsError(`Expected offset($register), got '${token}'`, { line });
  }
  const offset = match[1] === '' ? 0 : parseNumberInRange(match[1], -32768, 32767, 'memory offset', line);
  return { offset, base: parseRegister(match[2], line) };
}

/**
 * Split an operand list on commas and/or spaces (the C parser used " ,\t" as
 * delimiters too). Spaces around parentheses are removed first so that
 * "0 ( $t1 )" becomes "0($t1)". Character literals like ' ' are kept whole.
 */
export function splitOperands(text) {
  const normalised = text.replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')');
  const parts = [];
  let current = '';
  let inQuote = false;
  for (const ch of normalised) {
    if (ch === "'") inQuote = !inQuote;
    if (!inQuote && (ch === ',' || /\s/.test(ch))) {
      if (current !== '') parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** Remove a # comment, but not a # inside "a string" or a 'c' character literal. */
export function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;            // skip the escaped character
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return text.slice(0, i);
    }
  }
  return text;
}

/** "Hi\n" -> bytes [72, 105, 10]. Supports \n \t \r \0 \\ \" escapes; other text is UTF-8. */
function parseStringLiteral(text, line) {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  if (!match) throw new MipsError(`Expected a string in double quotes, got '${text}'`, { line });

  const escapes = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', "'": "'" };
  let value = '';
  const body = match[1];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') {
      const next = body[++i];
      if (!(next in escapes)) throw new MipsError(`Unknown escape '\\${next}' in string`, { line });
      value += escapes[next];
    } else {
      value += body[i];
    }
  }
  return Array.from(new TextEncoder().encode(value));
}

function alignUp(offset, alignment) {
  return Math.ceil(offset / alignment) * alignment;
}
