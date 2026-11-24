// fibonacci.mc - Fibonacci numbers two ways.
// fib_rec is the classic exponential recursion (lots of jal / jr and stack
// frames); fib_iter is a loop with three locals.

int fib_rec(int n) {
  if (n < 2) return n;
  return fib_rec(n - 1) + fib_rec(n - 2);
}

int fib_iter(int n) {
  int a = 0, b = 1;
  for (int i = 0; i < n; i++) {
    int next = a + b;
    a = b;
    b = next;
  }
  return a;
}

int main() {
  for (int i = 0; i <= 10; i++) {
    print_int(fib_rec(i));
    print_char(' ');
  }
  print("\nfib_iter(40) = ");
  print_int(fib_iter(40));
  print_char('\n');
  return 0;
}
