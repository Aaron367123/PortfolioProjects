// hanoi.mc - towers of Hanoi with 4 parameters (all of $a0-$a3) and
// globals shared between the recursive calls.

int moves;
int verbose;

int hanoi(int n, int from, int to, int via) {
  if (n == 0) return 0;
  hanoi(n - 1, from, via, to);
  moves++;
  if (verbose) {
    print("disk ");
    print_int(n);
    print(": ");
    print_char('A' + from);
    print(" -> ");
    print_char('A' + to);
    print_char('\n');
  }
  hanoi(n - 1, via, to, from);
  return moves;
}

int main() {
  verbose = 1;
  hanoi(3, 0, 2, 1);

  verbose = 0;
  for (int n = 1; n <= 10; n++) {
    moves = 0;
    hanoi(n, 0, 2, 1);
    print_int(n);
    print(" disks: ");
    print_int(moves);
    print(" moves\n");
  }
  return 0;
}
