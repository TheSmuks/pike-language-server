// Exercises: Variadic arguments, mixed ... args, args array access
#pragma strict_types

string join_strings(string sep, string ... parts) {
  return parts * sep;
}

int sum_ints(int ... nums) {
  int total = 0;
  foreach (nums; ; int n) {
    total += n;
  }
  return total;
}

mixed first_of(mixed ... args) {
  if (sizeof(args) == 0) return 0;
  return args[0];
}

int count_args(mixed ... args) {
  return sizeof(args);
}

int main() {
  write("join = %s\n", join_strings(", ", "a", "b", "c"));
  write("sum = %d\n", sum_ints(10, 20, 30));
  write("first = %O\n", first_of("x", "y", "z"));
  write("count = %d\n", count_args(1, 2, 3, 4, 5));
  return 0;
}
