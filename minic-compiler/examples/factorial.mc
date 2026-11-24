// factorial.mc - recursive factorial and 32-bit wrap-around.
// int is 32 bits, so 13! no longer fits and wraps, exactly like C on MIPS.

int fact(int n) {
  if (n <= 1) return 1;
  return n * fact(n - 1);
}

int main() {
  for (int n = 0; n <= 12; n++) {
    print_int(n);
    print("! = ");
    print_int(fact(n));
    print_char('\n');
  }
  print("13! wraps to ");
  print_int(fact(13));
  print_char('\n');
  return 0;
}
