#pragma strict_types
int add(int left, int right) { return left + right; }
int main() {
  int unused = 42;
  int wrong = "not an int";
  return add(1);
}
