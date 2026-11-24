# Mini-C Compiler

A compiler for **Mini-C**, a small C-like language, that emits **MIPS assembly** for my [MIPS emulator](../mips-emulator/). It is written in plain JavaScript (ES modules, no dependencies, no build step) and has a hand-written lexer, a recursive-descent parser with precedence climbing, a semantic checker with scoped symbol tables, an AST optimiser, a MIPS code generator with a real calling convention, and a peephole optimiser.

Every example and 200 random expressions are compiled, assembled and **executed on the real emulator engine** in the tests, and their output is checked against the expected output.

```sh
node cli.js examples/fibonacci.mc --run
# 0 1 1 2 3 5 8 13 21 34 55
# fib_iter(40) = 102334155
# [-O1] 9533 instructions executed, 95 words of code, exit (syscall 10)
```

## Pipeline

```
  source text
      |
      v
  lexer.js       -> tokens  { type, value, text, line, col }
      |
      v
  parser.js      -> AST     recursive descent + precedence climbing
      |
      v
  semantic.js    -> checked AST: symbols resolved, frame slots assigned,
      |             errors / warnings with line:col
      v
  optimizer.js   -> constant folding, algebraic simplification,     (-O1)
      |             dead code
      v
  codegen.js     -> instruction list: calling convention, stack frames,
      |             register stack for expressions
      v
  peephole.js    -> local rewrites until nothing changes             (-O1)
      |
      v
  MIPS assembly  -> ../mips-emulator assembler + CPU (cli.js --run, tests, web demo)
```

`src/index.js` ties it together: `compile(source, { optimize })` returns `{ ok, asm, tokens, ast, optimizedAst, diagnostics, lineMap, stats }`. It never throws for a bad program; problems come back as diagnostics. The compiler core does **not** import the emulator, so the same files run in Node and in the browser. Only `run.js` (used by `cli.js`, `bench.js` and the tests) imports `../mips-emulator/src`.

| File | What it does |
| ---- | ------------ |
| `src/lexer.js` | Single-pass scanner: identifiers, keywords, decimal / hex / char literals, strings, `//` and `/* */` comments, longest-match operators. |
| `src/parser.js` | One function per statement rule; binary expressions by precedence climbing. Produces plain-object AST nodes with positions. |
| `src/semantic.js` | Global scope + a stack of block scopes, frame-slot allocation, string table, every semantic check. Keeps going after an error. |
| `src/optimizer.js` | AST optimiser. Also exports the 32-bit fold functions the checker uses for constant initialisers. |
| `src/codegen.js` | MIPS generation and the assembly printer (with `# line N:` comments and a line map). |
| `src/peephole.js` | 13 local rules plus a small liveness analysis. |
| `src/diagnostics.js` | `CompileError` and the `line:col` + caret formatter. |
| `cli.js`, `run.js`, `bench.js` | Command line, emulator glue, the -O0 / -O1 table below. |

## The Mini-C language

* One type: `int`, 32-bit two's complement. Arithmetic **wraps around** like C on real hardware (no overflow traps).
* Global scalars (`int g = 5;`) and global arrays (`int a[10];`, `int a[4] = {1, 2, 3};`, the rest are 0). Global initialisers and array sizes are constant expressions.
* Local scalars with initialisers, block scoping and shadowing. Locals without an initialiser start at 0.
* Functions with up to 4 `int` parameters that return `int`, recursion, calls in any order (no prototypes needed). Falling off the end of a function returns 0. `main()` is the entry point.
* Statements: declarations, `=`, `+= -= *= /= %= &= |= ^= <<= >>=`, `x++` `x--` `++x` `--x` (statements only), `if` / `else`, `while`, `for`, `break`, `continue`, `return`, blocks, empty `;`, and call statements.
* Expressions: `|| && | ^ & == != < <= > >= << >> + - * / %`, unary `- ! ~`, calls, `a[i]`, parentheses. C precedence, all left-associative; `&&` and `||` short-circuit and give 0 or 1. `/` truncates toward zero and `%` takes the sign of the dividend (MIPS `div`). `>>` is arithmetic. Shift counts use the low 5 bits.
* Literals: `42`, `0x2A`, `'a'`, `'\n'` (chars are ints), `-2147483648`.
* Built-ins: `print_int(x)`, `print_char(c)` and `print("text\n")`. String literals are only allowed as the argument of `print`; they become `.asciiz` data (identical strings share one label).
* Assignment is a statement, not an expression, so `if (x = 1)` and `a = b = 0` are syntax errors instead of silent bugs.

### Grammar (EBNF)

```ebnf
program     = { global | function } EOF ;
global      = "int" declarator { "," declarator } ";" ;
declarator  = IDENT [ "=" expr ]
            | IDENT "[" expr "]" [ "=" "{" [ expr { "," expr } ] "}" ] ;     (* arrays: global only *)
function    = "int" IDENT "(" [ "int" IDENT { "," "int" IDENT } ] ")" block ;

block       = "{" { statement } "}" ;
statement   = block | ";"
            | "int" IDENT [ "=" expr ] { "," IDENT [ "=" expr ] } ";"
            | "if" "(" expr ")" statement [ "else" statement ]
            | "while" "(" expr ")" statement
            | "for" "(" [ for_init ] ";" [ expr ] ";" [ simple ] ")" statement
            | "break" ";" | "continue" ";" | "return" expr ";"
            | simple ";" ;
for_init    = "int" IDENT [ "=" expr ] { "," IDENT [ "=" expr ] } | simple ;
simple      = lvalue assign_op expr | lvalue ( "++" | "--" ) | ( "++" | "--" ) lvalue | expr ;
lvalue      = IDENT | IDENT "[" expr "]" ;
assign_op   = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "&=" | "|=" | "^=" | "<<=" | ">>=" ;

expr        = binary(1) ;
binary(p)   = unary { OP(q) binary(q + 1) } ;        (* while q >= p: precedence climbing *)
unary       = ( "-" | "!" | "~" ) unary | postfix ;
postfix     = IDENT "(" [ expr { "," expr } ] ")" | IDENT "[" expr "]" | primary ;
primary     = INT | CHAR | STRING | IDENT | "(" expr ")" ;
```

| Precedence | Operators |
| ---------: | --------- |
| 1 (lowest) | `\|\|` |
| 2 | `&&` |
| 3 | `\|` |
| 4 | `^` |
| 5 | `&` |
| 6 | `==` `!=` |
| 7 | `<` `<=` `>` `>=` |
| 8 | `<<` `>>` |
| 9 | `+` `-` |
| 10 | `*` `/` `%` |
| unary | `-` `!` `~` |

## Calling convention and stack frame

A simplified MIPS O32 convention:

* Arguments in `$a0`-`$a3` (so at most 4 parameters), result in `$v0`, return address in `$ra` (`jal` / `jr $ra`).
* Every function saves `$ra` and the caller's `$fp`. `$fp` points at the top of the frame, so parameters and locals sit at fixed offsets from it even while expression temporaries are pushed and popped below.
* `$t0`-`$t7` are caller-saved. `$at` is left to the assembler (`li` with a 32-bit constant expands to `lui $at` + `ori`).
* Only `addu` / `subu` / `addiu` are used for arithmetic, because the emulator's `add` / `sub` / `addi` trap on overflow and Mini-C ints wrap.

```
 higher addresses
      |  caller's frame            |
      +----------------------------+ <- $fp  (= the caller's $sp at the call)
      |  saved $ra                 |   -4($fp)
      |  saved caller's $fp        |   -8($fp)
      |  parameter 0  (from $a0)   |  -12($fp)
      |  parameter 1 / locals ...  |  -16($fp) ...   slots are reused once a block ends
      +----------------------------+ <- $sp after the prologue
      |  spilled / saved $t values |   pushed and popped while evaluating expressions
 lower addresses
```

```asm
f_fact:                             # int fact(int n)   frame: 12 bytes
        addiu $sp, $sp, -12         # prologue: allocate frame
        sw    $ra, 8($sp)           # save return address
        sw    $fp, 4($sp)           # save caller's frame pointer
        addiu $fp, $sp, 12          # $fp = top of this frame
        sw    $a0, -12($fp)         # parameter n
        ...
f_fact.ret:
        lw    $ra, 8($sp)           # epilogue: restore $ra
        lw    $fp, 4($sp)           # restore caller's $fp
        addiu $sp, $sp, 12          # free the frame
        jr    $ra                   # return
```

Start-up code at address 0 is `jal f_main`, then syscall 10. Compiler-made labels contain a `.` (`L3.else`, `f_fact.ret`) and user names get a prefix (`f_`, `g_`), so they can never clash with each other.

## Register allocation: a register stack

Expressions are evaluated like on a stack machine, but the stack lives in registers: the k-th live value is kept in `$t(k mod 8)`.

* `push()` gives the next register. If all 8 are busy, the **deepest** value is spilled to the memory stack first (it shares the register). Operators only ever use the top one or two values, so the spilled values are the ones needed last.
* `ensure(n)` reloads spilled values when the top `n` are needed again. Because spills happen in order, the memory stack is always in the right order to pop.
* Before a call, `flush()` pushes every live register (`$t` registers are caller-saved). The arguments are evaluated, moved to `$a0`-`$a3`, and the result comes back from `$v0` onto the register stack.
* `&&` / `||` used as values also flush first, so every path into the join label sees the same allocator state.

Conditions in `if` / `while` / `for` compile straight to compare-and-branch (`blt`, `bge`, ...); `&&` and `||` short-circuit by jumping, and a comparison with `0` uses `$zero`. Loops put the test at the bottom (`j cond; body: ...; cond: blt ..., body`), so each iteration runs one branch instead of a branch and a jump.

A test builds a 12-deep expression to force spills, and the random-expression test mixes calls into deep expressions; both check that `$sp` ends where it started.

## Optimisations (-O1)

**AST level** (`optimizer.js`): constant folding with exact 32-bit semantics (`Math.imul`, `| 0`, truncating division), identities (`x + 0`, `x * 1`, `x | 0`, `x - x`, `- -x`, `!(a < b)` to `a >= b`), strength reduction (`x * 8` to `x << 3`; `x / 8` is deliberately **not** a shift, because `-1 / 8` is 0 but `-1 >> 3` is -1), reassociation (`x + 1 + 2` to `x + 3`), short-circuit with constants (`0 && f()` to 0), and dead code (`if (0)`, `while (0)`, statements after `return` / `break` / `continue`, effect-free expression statements, `x += 0`). Anything that would drop a function call is only done when the expression is pure, and division by a constant 0 is never folded, so it still fails at run time.

**Peephole** (`peephole.js`): self-moves, push/pop pairs, store-then-load forwarding, `li` + ALU op to an immediate instruction (`addiu`, `andi`, `slti`, `sll`, ...), `li 0` to `$zero`, computing a value straight into its final register (`lw $t0, x; move $a0, $t0` to `lw $a0, x`), dead temporaries, branch over a jump (inverted branch), jumps to the next label, unreachable code after `j` / `jr`, merged stack adjustments, and unused labels. Rules that remove or retarget a register write first ask `isLive()`, a depth-first walk along every control-flow path, whether the register can still be read.

Before and after for `return n * fact(n - 1);` and `if (n <= 1) return 1;`:

```asm
# -O0                                    # -O1
lw    $t0, -12($fp)    # n               move  $t0, $a0    # value is still in a register
li    $t1, 1                             li    $t1, 1
bgt   $t0, $t1, L1.endif                 bgt   $t0, $t1, L1.endif
li    $t0, 1                             li    $v0, 1      # return value
move  $v0, $t0                           j     f_fact.ret
j     f_fact.ret                       L1.endif:
L1.endif:                                lw    $t0, -12($fp)
lw    $t0, -12($fp)                      addiu $sp, $sp, -4
addiu $sp, $sp, -4                       sw    $t0, 0($sp)
sw    $t0, 0($sp)                        lw    $t1, -12($fp)
lw    $t1, -12($fp)                      addiu $a0, $t1, -1
li    $t2, 1                             jal   f_fact
subu  $t1, $t1, $t2                      move  $t1, $v0
move  $a0, $t1                           lw    $t0, 0($sp)
jal   f_fact                             addiu $sp, $sp, 4
move  $t1, $v0                           mul   $v0, $t0, $t1
lw    $t0, 0($sp)
addiu $sp, $sp, 4
mul   $t0, $t0, $t1
move  $v0, $t0
j     f_fact.ret
li    $v0, 0           # (unreachable)
```

### -O0 vs -O1 on the examples

Generated by `npm run bench`: static code size (machine words, after `li` expansion) and instructions executed on the emulator. Both levels print identical output (checked by the tests).

| Example | Code words -O0 | Code words -O1 | Executed -O0 | Executed -O1 | Fewer executed |
| ------- | -------------: | -------------: | -----------: | -----------: | -------------: |
| bubblesort.mc | 177 | 144 | 2,412 | 2,124 | 11.9% |
| collatz.mc | 108 | 91 | 8,816 | 8,077 | 8.4% |
| expressions.mc | 141 | 93 | 108 | 67 | 38.0% |
| factorial.mc | 87 | 69 | 2,597 | 2,200 | 15.3% |
| fibonacci.mc | 120 | 95 | 11,185 | 9,533 | 14.8% |
| fizzbuzz.mc | 85 | 75 | 561 | 508 | 9.4% |
| gcd.mc | 136 | 118 | 286 | 259 | 9.4% |
| hanoi.mc | 153 | 132 | 139,700 | 123,274 | 11.8% |
| hello.mc | 18 | 15 | 17 | 15 | 11.8% |
| primes.mc | 94 | 84 | 3,364 | 3,177 | 5.6% |
| **total** | | | 169,046 | 149,234 | 11.7% |

The gains are modest because -O0 is not naive: the condition branches, bottom-tested loops and the register stack are used at both levels. What remains is mostly memory traffic for locals, which would need a real register allocator (see Limitations).

## Error messages

Lexing and parsing stop at the first error; semantic analysis reports all of them. Every diagnostic has a line, a column and an underline:

```
error 3:11: unknown identifier 'y'
  3 |   int x = y + 1;
    |           ^
error 4:13: function 'add' expects 2 arguments but got 1
  4 |   print_int(add(x));
    |             ^~~
error 1:14: cannot use '=' here: the left side is not a variable or array element
  1 | int main() { 1 + 2 = 3; }
    |              ^~~~~
error 1:39: function 'f' has 5 parameters; Mini-C allows at most 4 (they are passed in $a0-$a3)
warning 7:3: unreachable code (it comes after a return, break or continue)
```

Also reported: unexpected characters, unterminated strings / comments, integer literals out of range, redeclaration in the same scope (with the first line), break / continue outside a loop, calling a non-function, using a function or array as a value, indexing a scalar, constant array indexes out of bounds, non-constant global initialisers, missing `main`, built-ins used as values, `print` without a string literal, too much global data for `la`, and generated code larger than the emulator's 8 KB code section. Warnings: division by a constant zero, unreachable code, unused expression results.

## Running

Requires Node 18 or newer (developed on Node 24). Nothing to install.

```sh
node cli.js examples/hanoi.mc            # print the assembly (-O1)
node cli.js examples/hanoi.mc -O0        # without optimisation
node cli.js examples/hanoi.mc --run      # compile, assemble and run on the emulator
node cli.js examples/gcd.mc --ast        # dump the AST (JSON)
node cli.js examples/gcd.mc --tokens     # dump the tokens
node cli.js examples/gcd.mc -o gcd.asm   # write the assembly, then open it in the emulator
npm run bench                            # the -O0 / -O1 table above
```

`--run` imports the emulator from `../mips-emulator/src`, so keep the two folders side by side.

## Tests

```sh
node --test        # or: npm test
```

91 tests, all passing:

* **Lexer**: tokens, longest-match operators, literals and escapes, positions, every lexical error.
* **Parser**: the full precedence ladder, left-associativity, unary nesting, `-2147483648`, dangling `else`, and syntax errors with their positions (including assignment to a non-lvalue).
* **Semantic**: every error and warning above, scoping and shadowing, and the formatted caret output.
* **Optimiser**: fold results with 32-bit semantics, identities, strength reduction, short-circuit folding, side effects kept, dead code, and that `-O0` really turns it off.
* **Peephole**: each rule on hand-written input, the cases where a rule must not fire, and the liveness analysis.
* **End to end** (on the real emulator, at -O0 and -O1): wrap-around, division semantics, every operator, short-circuit side effects, loops with break / continue, compound assignment on locals, globals and array elements, scoping, recursion (Ackermann, mutual recursion), 4 parameters, calls inside expressions, register spilling, stack balance, strings, 32-bit constants, and that only emulator-supported instructions are generated.
* **Examples**: all 10 programs produce the exact expected output at both levels, with -O1 never slower or larger, and `$sp` restored.
* **Property test**: 200 random expressions from a seeded PRNG (literals up to 2^31-1, locals, a global, and calls to `id()` / `sub2()` mixed in), printed with the minimum parentheses so the parser is tested too, compiled at -O0 and -O1, run on the emulator and compared with an independent JavaScript reference evaluator (`Math.imul`, `| 0`, truncating division; expressions with a division by zero are rejected). Locally it also passed 5,000 deeper expressions over five other seeds.
* **Demo copies**: `demos/minic-compiler/compiler/` and `engine/` are byte-identical to `src/` and to `../mips-emulator/src`.

## Web demo

`demos/minic-compiler/` in the portfolio is a static page that uses byte-identical copies of `src/` (`compiler/`) and of the emulator engine (`engine/`). It has an editor with line numbers, compile-as-you-type, a -O0 / -O1 toggle, tabs for the assembly (clicking a source line highlights the assembly it produced, and the other way round), a collapsible AST (as parsed or after the optimiser) and the tokens, program output, clickable diagnostics, and an **Open in MIPS emulator** button that passes the assembly to the emulator as `?asm=<base64url>` so you can step through it.

## Limitations

* `int` is the only type: no pointers, `char` arrays, structs or `void` functions.
* Arrays are global only, one-dimensional, cannot be passed to functions, and have no run-time bounds check (constant indexes are checked at compile time).
* At most 4 parameters (no stack-passed arguments).
* `++` / `--` and assignment are statements, not expressions. No `?:`, `do`/`while`, `switch` or `goto`.
* Output only (`print_int`, `print_char`, `print`); the emulator has no input syscalls.
* Locals always live in the stack frame; there is no register allocation across statements, no constant propagation and no inlining. Each value loaded from a local costs an `lw`.
* Limits from the emulator: code must fit in 8 KB (2048 words) and data must stay below `0xFFFF` (`la` has a 16-bit address field), so global data is limited to about 56 KB.
* Division by zero stops the program with the emulator's run-time error.

## License

MIT © Aaron Morris Jara. See [LICENSE](LICENSE).
