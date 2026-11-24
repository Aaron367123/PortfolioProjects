# MIPS Emulator

A two-pass MIPS assembler and a step-through CPU emulator, written in plain JavaScript (ES modules, no dependencies, no build step). It runs in Node for testing and in the browser with a visual debugger: source with a current-line highlight, the machine-code listing, registers, and a hex/ASCII memory view that highlights what changed.

## Background

This project extends my **CENG356** (Computer Engineering Technology) lab series. In those labs I wrote, in C:

- **Lab 6** `memory.c`: 1 MB of byte-addressed memory, `write_dword` / `read_byte` / `read_dword`, and a hex + ASCII `memory_dump` with 16 bytes per line.
- **Lab 7** `lab7.c`: the bit packers `buildIInstruction` / `buildJInstruction` / `buildRInstruction` and encoders for `la`, `lb`, `bge`, `lw`, `sw`, `add`, `addi` and `j`. Data was loaded at `0x2000` and code at `0x0000`. These built on the course's two-pass parser (`parser.c`).
- **Lab 8** `lab8.c`: the start of a CPU, with `CPU_fetchCode`, `CPU_Decode` (opcode only) and a register printout. **Execution was never finished.** `CPU_Execution` only had the `la` example.

This repository finishes the CPU with a real execute stage, R-type `funct` decoding, more instructions, error checking and tests. It is ported to JavaScript so it can run in a browser. The module boundaries follow the C labs, so each JS function can be traced back to the C function it replaces.

| C lab (original)                         | JavaScript (this repo)                         |
| ---------------------------------------- | ---------------------------------------------- |
| `parser.c` `parse_MIPS` (two passes)     | `src/assembler.js` `assemble()`                |
| `lab7.c` `build[I/J/R]Instruction`       | `src/encoder.js` (same names, same bit layout) |
| `memory.c` `write_dword`, `read_byte`, `memory_dump` | `src/memory.js` `Memory` class      |
| `lab8.c` `CPU`, `CPU_fetchCode`, `CPU_Decode` | `src/cpu.js` `CPU.step()`, `decode()`      |
| `lab8.c` `CPU_Execution` (unfinished)    | `src/cpu.js` `CPU.execute()`                   |
| `lab8.c` `printRegisterFiles`            | `CPU.registerDump()`                           |
| `MIPS.asm` (course test program)         | `examples/swap.asm` (unchanged)                |

## Features

- **Two-pass assembler.** Labels (including forward references), `.text` / `.data`, `.byte .half .word .ascii .asciiz .space .align`, `#` comments, register names or numbers (`$t0` or `$8`), and decimal, hex, binary and `'c'` literals.
- **Pseudo-instructions.** `li` (1 or 2 words), `move`, `b`, `beqz`, `bnez`, `nop`.
- **CPU.** 32 general registers plus `hi`, `lo` and `PC`. `$zero` is hard-wired to 0. The loop is fetch → PC += 4 → decode → execute, with `step()` and `run(maxSteps)`.
- **Syscalls.** `$v0` = 1 prints an int, 4 a string, 11 a char; 10 exits.
- **Errors with line numbers.** Unknown instruction or directive, bad register, undefined or duplicate label, immediate out of range, wrong operand count, misaligned word access, address outside memory, PC out of range, arithmetic overflow (`add`, `addi`, `sub`), division by zero, unsupported syscall, step limit.
- **Disassembler.** Turns machine words back into text, using label names, for the listing.
- **Web UI.** Assemble, Step, Run / Pause with a speed slider, Reset, and breakpoints. It highlights the current line and changed registers and bytes, and has data / code / stack memory views and a console. Dark and light themes, and it works on phones.
- **CLI.** `node cli.js file.asm` prints the same reports as the C program: machine code, register file and a data memory dump.

## Supported instructions

| Type | Instructions | Notes |
| ---- | ------------ | ----- |
| R arithmetic | `add addu sub subu` | `add` / `sub` trap on signed overflow |
| R logic | `and or xor nor` | |
| R compare | `slt sltu` | |
| R shifts | `sll srl sra sllv srlv srav` | |
| Multiply / divide | `mult multu div divu mfhi mflo mul` | `mul` is MIPS32 (opcode `0x1C`) |
| Jumps | `j jal jr` | |
| I arithmetic | `addi addiu slti sltiu` | signed 16-bit immediate |
| I logic | `andi ori xori lui` | zero-extended 16-bit immediate |
| Loads / stores | `lw sw lb lbu sb` | `lw` / `sw` must be 4-byte aligned |
| Branches | `beq bne` | standard MIPS |
| Course branches | `bge` (`0x32`), `blt` (`0x33`), `bgt` (`0x36`), `ble` (`0x37`) | signed compare, one word each |
| Course `la` | `la` (`0x2F`) | 16-bit address in the immediate field |
| System | `syscall` | services 0, 1, 4, 10, 11 |
| Pseudo | `li move b beqz bnez nop` | expanded by the assembler |

All standard instructions use the real MIPS32 opcode and funct values, so the machine code matches MARS / SPIM for those instructions.

## Memory map

```
0x00000 +--------------------------+  TEXT_BASE  - code, loaded word by word (PC starts here)
        |  code (max 8 KB)         |
0x02000 +--------------------------+  DATA_BASE  - .data section, in source order
        |  data                    |
        |          ...             |
        |  free                    |
        |          ...             |
        |  stack (grows down)      |
0xFFFFC +--------------------------+  STACK_TOP  - initial $sp
0xFFFFF                               end of the 1 MB memory (little-endian)
```

## Architecture

```
            source text
                 |
                 v
   +----------------------------+     isa.js: opcodes, functs, registers,
   | assembler.js               |<--- operand patterns, memory map
   |  pass 1: labels + sizes    |
   |  pass 2: data + encoding --+---> encoder.js: buildI / buildJ / buildR
   +----------------------------+
                 | program { text[], data[], labels, listing }
                 v
   +----------------------------+     +-----------------------------+
   | cpu.js  CPU                |<--->| memory.js  Memory (1 MB)    |
   |  load(): code @0, data @2000|     |  readByte/readWord/write..  |
   |  step(): fetch -> PC+=4 ->  |     |  dump() hex + ASCII         |
   |          decode -> execute  |     +-----------------------------+
   |  run(maxSteps)             |
   +----------------------------+
                 |  registers, memory, lastStep, lastWrite, output
                 v
   +----------------------------+     disassembler.js: word -> "bge $s0, $a1, exit"
   | web UI (app.js) or cli.js  |<--- errors.js: MipsError { message, line }
   +----------------------------+
```

## Running the tests

Requires Node 18 or newer (developed on Node 24). There is nothing to install.

```sh
node --test          # or: npm test
```

The 61 tests cover:

- **Encoding.** Hand-computed words for every instruction in `MIPS.asm`, plus a check against a literal port of the C `build*Instruction` functions over 2000 random field sets.
- **Assembler.** Label addresses, forward and backward branch offsets (checked against the lab7.c `immediate -= (i + 1)` rule), data directives and alignment, pseudo-instruction expansion, and every error message with its line number.
- **Memory.** Endianness, alignment and range checks, and the dump format.
- **CPU.** The behaviour of every instruction, `$zero`, syscalls, and run-time errors with line numbers.
- **End to end.** `swap.asm` is run and the test asserts that `testdata1` and `testdata2` are swapped. The other examples are run and their printed output is checked.

Run a program from the terminal:

```sh
node cli.js examples/swap.asm
```

## Web UI

The browser version is a static page (`index.html`, `app.js`, `style.css`) that imports these same modules from an `engine/` folder. ES modules need to be served over HTTP, not opened as `file://`:

```sh
# from the folder that contains index.html and engine/
python -m http.server 8000
# open http://localhost:8000/
```

URL options: `?example=swap|sum|factorial|strlen`, `?autorun=1` (run to the end on load), `?steps=N` (run N instructions on load), `?theme=light|dark`.

## Examples

| File | What it shows |
| ---- | ------------- |
| `examples/swap.asm` | The original course program, unchanged. It swaps two 8-word arrays using `la lb bge lw sw addi j`. |
| `examples/sum.asm` | Sums an array and prints `Sum = 200`, using `blt`-style loops, `li`, `move` and syscalls. |
| `examples/factorial.asm` | Recursive `fact(6) = 720` using `jal` / `jr`, the stack and `mul`. |
| `examples/strlen.asm` | Walks a string with `lb`, upper-cases it in place with `sb`, and prints its length. |

## Design decisions

- **The course encodings are kept.** `la = 0b101111`, `bge = 0b110010`, `lb = 0b100000`, `lw = 0b100011`, `sw = 0b101011`, `addi = 0b001000`, `j = 0b000010` and `add` (funct `0b100000`) come straight from `lab7.c`. `blt`, `bgt` and `ble` are added in the same style, on opcodes this emulator does not use for anything else. A test checks that no two instructions share an encoding.
- **Branch offsets.** The C lab stored the target's instruction index and did `immediate -= (i + 1)`. The JS assembler computes `(target - (PC + 4)) / 4`, which gives the same number. The CPU applies it to the already-incremented PC, like real MIPS.
- **`la` loads the real address.** In the C parser, data labels were offsets from the start of the data section (`DATA_SEGMENT_BASE = 0`), so `la` would have loaded `0x0004` while the data actually lives at `0x2004`. The following `lw` would then have read from the code section. Here `la` stores `0x2000 + offset`, so the register holds a pointer you can actually use. It is still a single course-defined instruction with a 16-bit immediate, so `la` can only reach addresses up to `0xFFFF`. The assembler reports an error otherwise.
- **`.word` is aligned to 4 bytes.** `MIPS.asm` starts with `counter: .byte 32`, which in the C parser put `testdata1` at the unaligned offset 1. Like MARS and SPIM, `.half` is aligned to 2 and `.word` to 4, so `testdata1` is at `0x2004` and `testdata2` at `0x2024`. The CPU then enforces aligned `lw` / `sw`, as real MIPS hardware does, instead of silently allowing unaligned access.
- **R-type decoding.** `CPU_Decode` only returned the opcode, which is 0 for every R-type instruction. `decode()` extracts every field, and `execute()` switches on `funct` when the opcode is 0.
- **How a program ends.** The C loop stopped when it fetched the word `0x00000000`. That word is a valid `nop`, so instead a program halts on `syscall` with `$v0` = 10, or when the PC reaches the end of the code. `MIPS.asm` calls `syscall` without setting `$v0`, so `$v0` = 0 is also treated as "end of program", matching how the lab used it.
- **Bit packing.** The packers are faithful ports, with two fixes. Each field is masked to its real width (the C code used `0xFF`, which could spill into the next field). The J-type target is masked to 26 bits instead of 24 bits. Both give identical results for valid inputs in 1 MB of memory, and a test checks this.
- **Readable over clever.** Registers live in a `Uint32Array`, so writes wrap to 32 bits automatically, and `| 0` gives the signed view. 64-bit `mult` uses `BigInt`. There are no dependencies.

## Known limitations

- No branch delay slots, pipeline or caches. Each instruction completes in one step.
- No floating point (coprocessor 1), no exceptions or interrupts (errors stop the program), and no `lh` / `sh` / `jalr` / `bltz`-family instructions.
- `la` is limited to addresses `<= 0xFFFF`, because of the course's single-word encoding.
- `.text` / `.data` with an address argument, macros, `.eqv` and `.include` are not supported.
- Labels are case-sensitive. Mnemonics and register names are not.
- Syscalls are output-only (1, 4, 10, 11). There is no input.
- The code section is limited to 8 KB (2048 instructions), because data starts at `0x2000`.

## License

MIT © Aaron Morris Jara. See [LICENSE](LICENSE).
