// diagnostics.js - errors and warnings with a source position.
//
// Every stage of the compiler reports problems the same way: a message plus
// the 1-based line and column where it happened (and how many characters to
// underline). formatDiagnostic() turns that into the familiar compiler style:
//
//   error 3:11: unknown identifier 'y'
//       3 |   int x = y + 1;
//         |           ^

/** Thrown by the lexer and parser, which stop at the first syntax error. */
export class CompileError extends Error {
  /**
   * @param {string} message
   * @param {{line: number, col: number, length?: number}} where
   */
  constructor(message, where) {
    super(message);
    this.name = 'CompileError';
    this.line = where?.line ?? 0;
    this.col = where?.col ?? 0;
    this.length = Math.max(1, where?.length ?? 1);
  }
}

/** Build a plain diagnostic object (what compile() returns). */
export function diagnostic(severity, message, where) {
  return {
    severity, // 'error' | 'warning'
    message,
    line: where?.line ?? 0,
    col: where?.col ?? 0,
    length: Math.max(1, where?.length ?? 1),
  };
}

/**
 * Format a diagnostic with the offending source line and a caret underneath.
 * Tabs in the source line are copied into the caret line so the caret stays
 * under the right character.
 */
export function formatDiagnostic(d, source) {
  const header = `${d.severity} ${d.line}:${d.col}: ${d.message}`;
  const lines = source.split(/\r?\n/);
  const text = lines[d.line - 1];
  if (text === undefined || d.line < 1) return header;

  const gutter = String(d.line).length;
  const prefix = text.slice(0, d.col - 1).replace(/[^\t]/g, ' ');
  const width = Math.max(1, Math.min(d.length, text.length - d.col + 1));
  return [
    header,
    `  ${String(d.line).padStart(gutter)} | ${text}`,
    `  ${' '.repeat(gutter)} | ${prefix}^${'~'.repeat(width - 1)}`,
  ].join('\n');
}
