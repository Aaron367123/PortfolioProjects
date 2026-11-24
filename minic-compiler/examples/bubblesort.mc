// bubblesort.mc - sort a global array in place.
// Shows array initialisers, a[i] = ... stores, nested loops and break.

int data[10] = {64, 25, 12, 22, 11, 90, 3, 47, 75, 38};
int swaps;

int print_array(int n) {
  for (int i = 0; i < n; i++) {
    if (i > 0) print(", ");
    print_int(data[i]);
  }
  print_char('\n');
  return 0;
}

int sort(int n) {
  for (int pass = 0; pass < n - 1; pass++) {
    int swapped = 0;
    for (int i = 0; i < n - 1 - pass; i++) {
      if (data[i] > data[i + 1]) {
        int t = data[i];
        data[i] = data[i + 1];
        data[i + 1] = t;
        swaps++;
        swapped = 1;
      }
    }
    if (!swapped) break;   // already sorted: stop early
  }
  return swaps;
}

int main() {
  print("before: ");
  print_array(10);
  sort(10);
  print("after:  ");
  print_array(10);
  print("swaps:  ");
  print_int(swaps);
  print_char('\n');
  return 0;
}
