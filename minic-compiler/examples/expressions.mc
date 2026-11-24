// expressions.mc - operator precedence, short-circuit evaluation and
// constant folding. Compare the assembly at -O0 and -O1.

int calls;

int noisy(int x) {
  calls++;
  return x;
}

int main() {
  int x = 7;
  print_int(2 + 3 * 4);            // 14: * binds tighter than +
  print_char(' ');
  print_int(100 - 10 - 1);         // 89: - is left-associative
  print_char(' ');
  print_int((1 << 4) | 3 & 6);     // 18: & binds tighter than |
  print_char(' ');
  print_int(-7 / 2);               // -3: division truncates toward zero
  print_char(' ');
  print_int(-7 % 2);               // -1: remainder has the sign of the dividend
  print_char(' ');
  print_int(x * 8 + 0);            // 56: becomes x << 3 at -O1
  print_char('\n');

  // && and || stop as soon as the answer is known.
  if (x > 5 || noisy(1)) print("short-circuit: ");
  if (x < 5 && noisy(1)) print("never printed");
  print_int(calls);                // 0: noisy() was never called
  print_char('\n');
  return 0;
}
