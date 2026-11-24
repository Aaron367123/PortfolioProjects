// gcd.mc - Euclid's algorithm, recursive and iterative, plus lcm.

int gcd(int a, int b) {
  if (b == 0) return a;
  return gcd(b, a % b);
}

int gcd_loop(int a, int b) {
  while (b != 0) {
    int t = b;
    b = a % b;
    a = t;
  }
  return a;
}

int lcm(int a, int b) {
  return a / gcd(a, b) * b;
}

int main() {
  print("gcd(1071, 462) = ");
  print_int(gcd(1071, 462));
  print("\ngcd_loop(270, 192) = ");
  print_int(gcd_loop(270, 192));
  print("\nlcm(21, 6) = ");
  print_int(lcm(21, 6));
  print_char('\n');
  return 0;
}
