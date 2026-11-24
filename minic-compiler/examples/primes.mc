// primes.mc - sieve of Eratosthenes on a global array.
// Global arrays live in the .data section (zero-initialised .space).

int limit = 100;
int composite[101];

int main() {
  for (int i = 2; i * i <= limit; i++) {
    if (!composite[i]) {
      for (int j = i * i; j <= limit; j += i) composite[j] = 1;
    }
  }

  int count = 0;
  for (int i = 2; i <= limit; i++) {
    if (!composite[i]) {
      print_int(i);
      print_char(' ');
      count++;
    }
  }
  print("\n");
  print_int(count);
  print(" primes up to 100\n");
  return 0;
}
