// collatz.mc - the 3n + 1 problem: how many steps until n reaches 1?

int steps(int n) {
  int count = 0;
  while (n != 1) {
    if (n % 2 == 0) n = n / 2;
    else n = 3 * n + 1;
    count++;
  }
  return count;
}

int main() {
  int best = 1, most = 0;
  for (int n = 1; n < 30; n++) {
    int s = steps(n);
    if (s > most) {
      best = n;
      most = s;
    }
  }
  print("steps(6) = ");
  print_int(steps(6));
  print("\nlongest below 30: n = ");
  print_int(best);
  print(" (");
  print_int(most);
  print(" steps)\n");
  return 0;
}
