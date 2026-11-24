// fizzbuzz.mc - if / else chains, % and print_char with char literals.

int main() {
  for (int i = 1; i <= 15; i++) {
    if (i % 15 == 0) print("FizzBuzz");
    else if (i % 3 == 0) print("Fizz");
    else if (i % 5 == 0) print("Buzz");
    else print_int(i);
    if (i < 15) print_char(' ');
  }
  print_char('\n');

  // Characters are just ints: 'A' + 1 == 'B'.
  for (int c = 'A'; c <= 'Z'; c += 5) print_char(c);
  print_char('\n');
  return 0;
}
