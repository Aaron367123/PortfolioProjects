// lexer.js - turn Mini-C source text into a list of tokens.
//
// A token is { type, value, text, line, col, length }:
//   type   'int' | 'ident' | 'keyword' | 'string' | 'op' | 'eof'
//   value  the number for 'int' (char literals are ints too), the decoded
//          text for 'string', otherwise the same as text
//   text   exactly what was written in the source ("0x1F", "'a'", "<=")
//
// The lexer is a single left-to-right scan. At each position it skips
// whitespace and comments, then looks at the first character to decide what
// kind of token starts there. Operators are matched longest-first, so "<="
// wins over "<" and "<<" wins over "<".

import { CompileError } from './diagnostics.js';

export const KEYWORDS = new Set(['int', 'if', 'else', 'while', 'for', 'break', 'continue', 'return']);

// Longest operators first so that greedy matching picks "<<" before "<".
const OPERATORS = [
  '<<=', '>>=',
  '||', '&&', '==', '!=', '<=', '>=', '<<', '>>', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '+', '-', '*', '/', '%', '<', '>', '=', '!', '~', '&', '|', '^',
  '(', ')', '{', '}', '[', ']', ',', ';',
];

const ESCAPES = { n: 10, t: 9, r: 13, 0: 0, '\\': 92, "'": 39, '"': 34 };

const INT_MAX_PLUS_ONE = 2147483648; // 2^31: only legal as the operand of unary minus

/**
 * @param {string} source
 * @returns {Array<{type: string, value: any, text: string, line: number, col: number, length: number}>}
 * @throws {CompileError} on the first lexical error
 */
export function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let lineStart = 0; // index of the first character of the current line

  const col = () => i - lineStart + 1;
  const here = (length = 1) => ({ line, col: col(), length });

  function newline() {
    line++;
    lineStart = i + 1;
  }

  function push(type, value, start, startLine, startCol) {
    const text = source.slice(start, i);
    tokens.push({ type, value, text, line: startLine, col: startCol, length: i - start });
  }

  while (i < source.length) {
    const ch = source[i];

    // ---- whitespace ----
    if (ch === '\n') { newline(); i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }

    // ---- comments: // to end of line, /* ... */ (not nested) ----
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const start = here(2);
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') newline();
        i++;
      }
      if (i >= source.length) throw new CompileError('unterminated /* comment', start);
      i += 2;
      continue;
    }

    const start = i;
    const startLine = line;
    const startCol = col();

    // ---- identifiers and keywords ----
    if (/[A-Za-z_]/.test(ch)) {
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i++;
      const word = source.slice(start, i);
      push(KEYWORDS.has(word) ? 'keyword' : 'ident', word, start, startLine, startCol);
      continue;
    }

    // ---- integer literals: decimal or 0x hex ----
    if (/[0-9]/.test(ch)) {
      let value;
      if (ch === '0' && /[xX]/.test(source[i + 1])) {
        i += 2;
        while (i < source.length && /[0-9A-Fa-f]/.test(source[i])) i++;
        const digits = source.slice(start + 2, i);
        if (digits === '') throw new CompileError('hex literal needs at least one digit after 0x', { line, col: startCol, length: 2 });
        value = parseInt(digits, 16);
        if (value > 0xffffffff) {
          throw new CompileError(`integer literal ${source.slice(start, i)} does not fit in 32 bits`, { line, col: startCol, length: i - start });
        }
        value |= 0; // 0xFFFFFFFF is -1, like a 32-bit int
      } else {
        while (i < source.length && /[0-9]/.test(source[i])) i++;
        value = Number(source.slice(start, i));
        if (value > INT_MAX_PLUS_ONE) {
          throw new CompileError(`integer literal ${source.slice(start, i)} is out of range (int is 32-bit: -2147483648..2147483647)`, { line, col: startCol, length: i - start });
        }
      }
      if (/[A-Za-z_]/.test(source[i] ?? '')) {
        throw new CompileError(`invalid character '${source[i]}' in number`, here());
      }
      push('int', value, start, startLine, startCol);
      continue;
    }

    // ---- character literals: 'a', '\n' (they are just ints) ----
    if (ch === "'") {
      i++;
      let value;
      if (source[i] === '\\') {
        const esc = source[i + 1];
        if (!(esc in ESCAPES)) throw new CompileError(`unknown escape '\\${esc ?? ''}' in character literal`, { line, col: col(), length: 2 });
        value = ESCAPES[esc];
        i += 2;
      } else if (source[i] === "'" ) {
        throw new CompileError('empty character literal', { line, col: startCol, length: 2 });
      } else if (source[i] === undefined || source[i] === '\n') {
        throw new CompileError('unterminated character literal', { line, col: startCol, length: 1 });
      } else {
        value = source.charCodeAt(i);
        if (value > 127) throw new CompileError('character literals must be ASCII', { line, col: col(), length: 1 });
        i++;
      }
      if (source[i] !== "'") throw new CompileError('unterminated character literal (expected closing \')', { line, col: startCol, length: i - start });
      i++;
      push('int', value, start, startLine, startCol);
      continue;
    }

    // ---- string literals: only legal as the argument of print(...) ----
    if (ch === '"') {
      i++;
      let value = '';
      while (source[i] !== '"') {
        if (i >= source.length || source[i] === '\n') {
          throw new CompileError('unterminated string literal', { line, col: startCol, length: i - start });
        }
        if (source[i] === '\\') {
          const esc = source[i + 1];
          if (!(esc in ESCAPES)) throw new CompileError(`unknown escape '\\${esc ?? ''}' in string`, { line, col: col(), length: 2 });
          value += String.fromCharCode(ESCAPES[esc]);
          i += 2;
        } else {
          value += source[i];
          i++;
        }
      }
      i++; // closing quote
      push('string', value, start, startLine, startCol);
      continue;
    }

    // ---- operators and punctuation (longest match first) ----
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (op) {
      i += op.length;
      push('op', op, start, startLine, startCol);
      continue;
    }

    throw new CompileError(`unexpected character '${ch}'`, here());
  }

  tokens.push({ type: 'eof', value: '', text: '', line, col: col(), length: 1 });
  return tokens;
}
