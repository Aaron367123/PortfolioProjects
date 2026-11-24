// parser.js - hand-written recursive-descent parser for Mini-C.
//
// Statements are parsed by plain recursive descent: one function per grammar
// rule (parseIf, parseWhile, ...). Binary expressions use precedence
// climbing, which handles every precedence level with a single loop instead of
// one function per level. See parseBinary() for how it works.
//
// The result is an AST of plain objects. Every node has `kind` plus the
// position of its main token (`line`, `col`, `length`) so later stages can
// point at the right place in error messages.
//
// The parser stops at the first syntax error (it throws a CompileError).

import { CompileError } from './diagnostics.js';

// Binary operator precedence, lowest to highest. All are left-associative.
// Same order as C.
export const PRECEDENCE = {
  '||': 1,
  '&&': 2,
  '|': 3,
  '^': 4,
  '&': 5,
  '==': 6, '!=': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9,
  '*': 10, '/': 10, '%': 10,
};

const UNARY_OPS = new Set(['-', '!', '~']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
const MAX_NESTING = 200; // keeps pathological input from overflowing the JS stack

/**
 * @param {ReturnType<import('./lexer.js').tokenize>} tokens
 * @returns {object} the Program node
 */
export function parse(tokens) {
  return new Parser(tokens).parseProgram();
}

/** Position of a token, in the shape AST nodes and diagnostics use. */
function at(token) {
  return { line: token.line, col: token.col, length: token.length };
}

/** Span from the first character of `first` to the last character of `last` (same line only). */
function spanOf(first, last) {
  const length = first.line === last.line ? last.col + last.length - first.col : first.length;
  return { line: first.line, col: first.col, length };
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
    this.depth = 0;
  }

  // -------------------------------------------------------------------------
  // Token helpers
  // -------------------------------------------------------------------------
  peek(offset = 0) {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  previous() {
    return this.tokens[this.pos - 1];
  }

  next() {
    const token = this.peek();
    if (token.type !== 'eof') this.pos++;
    return token;
  }

  /** Is the next token the operator/keyword `text`? */
  check(text) {
    const t = this.peek();
    return (t.type === 'op' || t.type === 'keyword') && t.value === text;
  }

  accept(text) {
    if (this.check(text)) return this.next();
    return null;
  }

  expect(text, context = '') {
    if (this.check(text)) return this.next();
    const t = this.peek();
    // A friendlier message for the most common surprise: i++ inside an expression.
    if (text === ';' && (t.value === '++' || t.value === '--')) {
      throw new CompileError(`'${t.value}' can only be used as a statement on its own (e.g. i${t.value};)`, at(t));
    }
    throw new CompileError(`expected '${text}'${context ? ` ${context}` : ''} but found ${describe(t)}`, at(t));
  }

  expectIdent(what) {
    const t = this.peek();
    if (t.type === 'ident') return this.next();
    throw new CompileError(`expected ${what} but found ${describe(t)}`, at(t));
  }

  enter() {
    if (++this.depth > MAX_NESTING) throw new CompileError('program is nested too deeply', at(this.peek()));
  }

  leave() {
    this.depth--;
  }

  // -------------------------------------------------------------------------
  // Top level:  program = { global_decl | function } EOF
  // -------------------------------------------------------------------------
  parseProgram() {
    const program = { kind: 'Program', globals: [], functions: [], line: 1, col: 1, length: 1 };
    while (this.peek().type !== 'eof') {
      const typeToken = this.peek();
      if (!this.check('int')) {
        throw new CompileError(`expected 'int' to start a global variable or function, found ${describe(typeToken)}`, at(typeToken));
      }
      this.next();
      const name = this.expectIdent('a name after \'int\'');
      if (this.check('(')) {
        program.functions.push(this.parseFunction(name));
      } else {
        program.globals.push(...this.parseDeclarators(name, true));
        this.expect(';', 'after the global declaration');
      }
    }
    return program;
  }

  // function = "int" IDENT "(" [ "int" IDENT { "," "int" IDENT } ] ")" block
  parseFunction(name) {
    this.expect('(');
    const params = [];
    if (!this.check(')')) {
      do {
        if (!this.accept('int')) throw new CompileError(`expected 'int' before the parameter name, found ${describe(this.peek())}`, at(this.peek()));
        const p = this.expectIdent('a parameter name');
        params.push({ name: p.value, ...at(p) });
      } while (this.accept(','));
    }
    this.expect(')', 'after the parameter list');
    if (!this.check('{')) throw new CompileError(`expected '{' to start the body of '${name.value}', found ${describe(this.peek())}`, at(this.peek()));
    const body = this.parseBlock();
    return { kind: 'Function', name: name.value, params, body, ...at(name) };
  }

  /**
   * declarator { "," declarator }   after "int" and the first name.
   *   declarator = IDENT [ "=" expr ]
   *              | IDENT "[" expr "]" [ "=" "{" expr { "," expr } "}" ]   (globals only)
   */
  parseDeclarators(firstName, isGlobal) {
    const decls = [];
    let name = firstName;
    for (;;) {
      if (this.check('[')) {
        if (!isGlobal) {
          throw new CompileError(`local arrays are not supported: declare '${name.value}' at global scope`, at(name));
        }
        this.next();
        const size = this.parseExpression();
        this.expect(']', 'after the array size');
        let init = null;
        if (this.accept('=')) {
          this.expect('{', 'to start the array initialiser');
          init = [];
          if (!this.check('}')) {
            do init.push(this.parseExpression()); while (this.accept(','));
          }
          this.expect('}', 'to end the array initialiser');
        }
        decls.push({ kind: 'ArrayDecl', name: name.value, size, init, global: true, ...at(name) });
      } else {
        const init = this.accept('=') ? this.parseExpression() : null;
        decls.push({ kind: 'VarDecl', name: name.value, init, global: isGlobal, ...at(name) });
      }
      if (!this.accept(',')) break;
      name = this.expectIdent('a variable name');
    }
    return decls;
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------
  parseBlock() {
    const open = this.expect('{');
    const body = [];
    this.enter();
    while (!this.check('}')) {
      if (this.peek().type === 'eof') throw new CompileError(`missing '}' to close the block opened at ${open.line}:${open.col}`, at(this.peek()));
      body.push(this.parseStatement());
    }
    this.leave();
    this.next(); // '}'
    return { kind: 'Block', body, ...at(open) };
  }

  parseStatement() {
    const t = this.peek();
    if (t.type === 'op' && t.value === '{') return this.parseBlock();
    if (t.type === 'op' && t.value === ';') {
      this.next();
      return { kind: 'Empty', ...at(t) };
    }
    if (t.type === 'keyword') {
      switch (t.value) {
        case 'int': {
          const decl = this.parseLocalDecl();
          this.expect(';', 'after the declaration');
          return decl;
        }
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'for': return this.parseFor();
        case 'break':
        case 'continue':
          this.next();
          this.expect(';', `after '${t.value}'`);
          return { kind: t.value === 'break' ? 'Break' : 'Continue', ...at(t) };
        case 'return': {
          this.next();
          if (this.check(';')) throw new CompileError("'return' needs a value: every Mini-C function returns int", at(t));
          const value = this.parseExpression();
          this.expect(';', 'after the return value');
          return { kind: 'Return', value, ...at(t) };
        }
        case 'else':
          throw new CompileError("'else' without a matching 'if'", at(t));
      }
    }
    const stmt = this.parseSimple();
    this.expect(';', 'at the end of the statement');
    return stmt;
  }

  parseLocalDecl() {
    const intToken = this.expect('int');
    const name = this.expectIdent('a variable name');
    return { kind: 'DeclStmt', decls: this.parseDeclarators(name, false), ...at(intToken) };
  }

  // if = "if" "(" expr ")" statement [ "else" statement ]
  parseIf() {
    const t = this.next();
    this.expect('(', "after 'if'");
    const cond = this.parseExpression();
    this.expect(')', 'after the condition');
    this.enter();
    const then = this.parseStatement();
    const otherwise = this.accept('else') ? this.parseStatement() : null;
    this.leave();
    return { kind: 'If', cond, then, else: otherwise, ...at(t) };
  }

  // while = "while" "(" expr ")" statement
  parseWhile() {
    const t = this.next();
    this.expect('(', "after 'while'");
    const cond = this.parseExpression();
    this.expect(')', 'after the condition');
    this.enter();
    const body = this.parseStatement();
    this.leave();
    return { kind: 'While', cond, body, ...at(t) };
  }

  // for = "for" "(" [ local_decl | simple ] ";" [ expr ] ";" [ simple ] ")" statement
  parseFor() {
    const t = this.next();
    this.expect('(', "after 'for'");
    let init = null;
    if (this.check('int')) init = this.parseLocalDecl();
    else if (!this.check(';')) init = this.parseSimple();
    this.expect(';', 'after the for-loop initialiser');
    const cond = this.check(';') ? null : this.parseExpression();
    this.expect(';', 'after the for-loop condition');
    const update = this.check(')') ? null : this.parseSimple();
    this.expect(')', 'after the for-loop update');
    this.enter();
    const body = this.parseStatement();
    this.leave();
    return { kind: 'For', init, cond, update, body, ...at(t) };
  }

  /**
   * simple = ("++" | "--") lvalue
   *        | lvalue assign_op expr
   *        | lvalue ("++" | "--")
   *        | expr                      (normally a call)
   * Assignment is a statement in Mini-C, not an expression, so `a = b = 1`
   * and `if (x = 1)` are syntax errors instead of silent bugs.
   */
  parseSimple() {
    const first = this.peek();
    if (this.check('++') || this.check('--')) {
      const opToken = this.next();
      const startTarget = this.peek();
      const target = this.parseUnary();
      this.checkLvalue(target, spanOf(startTarget, this.previous()), opToken.value);
      return incDec(opToken, target, first);
    }

    const expr = this.parseExpression();
    const exprSpan = spanOf(first, this.previous());
    const t = this.peek();
    if (t.type === 'op' && ASSIGN_OPS.has(t.value)) {
      this.checkLvalue(expr, exprSpan, t.value);
      this.next();
      const value = this.parseExpression();
      return { kind: 'Assign', op: t.value, target: expr, value, ...at(t) };
    }
    if (t.type === 'op' && (t.value === '++' || t.value === '--')) {
      this.checkLvalue(expr, exprSpan, t.value);
      this.next();
      return incDec(t, expr, first);
    }
    return { kind: 'ExprStmt', expr, ...exprSpan };
  }

  checkLvalue(expr, span, op) {
    if (expr.kind !== 'Identifier' && expr.kind !== 'Index') {
      throw new CompileError(`cannot use '${op}' here: the left side is not a variable or array element`, span);
    }
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------
  parseExpression() {
    this.enter();
    const expr = this.parseBinary(1);
    this.leave();
    return expr;
  }

  /**
   * Precedence climbing.
   *
   * parseBinary(minPrec) parses an expression whose binary operators all have
   * precedence >= minPrec. It reads one operand, then, while the next token is
   * an operator that binds at least that tightly, it consumes the operator and
   * parses the right-hand side with minPrec = prec + 1. The "+ 1" makes
   * operators of equal precedence group to the left:
   *
   *   a - b - c    ->  (a - b) - c
   *   a + b * c    ->  a + (b * c)    (the recursive call swallows "* c")
   */
  parseBinary(minPrec) {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const prec = t.type === 'op' ? PRECEDENCE[t.value] : undefined;
      if (prec === undefined || prec < minPrec) return left;
      this.next();
      const right = this.parseBinary(prec + 1);
      left = { kind: 'Binary', op: t.value, left, right, ...at(t) };
    }
  }

  // unary = ("-" | "!" | "~") unary | postfix
  parseUnary() {
    const t = this.peek();
    if (t.type === 'op' && UNARY_OPS.has(t.value)) {
      this.next();
      // -2147483648 is written as minus applied to 2147483648, which on its
      // own does not fit in an int. Accept exactly that one case here.
      const operandToken = this.peek();
      if (t.value === '-' && operandToken.type === 'int' && operandToken.value === 2147483648) {
        this.next();
        return { kind: 'Number', value: -2147483648, text: `-${operandToken.text}`, ...spanOf(t, operandToken) };
      }
      this.enter();
      const operand = this.parseUnary();
      this.leave();
      return { kind: 'Unary', op: t.value, operand, ...at(t) };
    }
    return this.parsePostfix();
  }

  // postfix = IDENT "(" [ expr { "," expr } ] ")" | IDENT "[" expr "]" | primary
  parsePostfix() {
    const t = this.peek();
    if (t.type === 'ident') {
      this.next();
      if (this.accept('(')) {
        const args = [];
        if (!this.check(')')) {
          do args.push(this.parseExpression()); while (this.accept(','));
        }
        this.expect(')', `to close the call to '${t.value}'`);
        return { kind: 'Call', name: t.value, args, ...at(t) };
      }
      if (this.accept('[')) {
        const index = this.parseExpression();
        this.expect(']', 'after the array index');
        return { kind: 'Index', name: t.value, index, ...at(t) };
      }
      return { kind: 'Identifier', name: t.value, ...at(t) };
    }
    return this.parsePrimary();
  }

  // primary = INT | CHAR | STRING | "(" expr ")"
  parsePrimary() {
    const t = this.next();
    if (t.type === 'int') {
      if (t.value === 2147483648) {
        throw new CompileError('integer literal 2147483648 is out of range (max 2147483647)', at(t));
      }
      return { kind: 'Number', value: t.value, text: t.text, ...at(t) };
    }
    if (t.type === 'string') {
      return { kind: 'String', value: t.value, text: t.text, ...at(t) };
    }
    if (t.type === 'op' && t.value === '(') {
      const expr = this.parseExpression();
      this.expect(')', 'to close the parenthesis');
      return expr;
    }
    throw new CompileError(`expected an expression but found ${describe(t)}`, at(t));
  }
}

/** i++ / --i  ->  Assign { op: '+=' | '-=', value: 1 } (remembering how it was written). */
function incDec(opToken, target, first) {
  const one = { kind: 'Number', value: 1, text: '1', ...at(opToken) };
  return {
    kind: 'Assign',
    op: opToken.value === '++' ? '+=' : '-=',
    target,
    value: one,
    form: opToken.value,
    ...at(first),
  };
}

function describe(token) {
  if (token.type === 'eof') return 'the end of the file';
  if (token.type === 'string') return 'a string literal';
  if (token.type === 'int') return `the number ${token.text}`;
  if (token.type === 'ident') return `'${token.value}'`;
  return `'${token.text}'`;
}
