// Corpus: basic-nonstrict.pike
// Exercises: Compilation without #pragma strict_types
// Priority: P0
// Expected: Compiles cleanly without strict mode.
//           Same code would produce type errors under strict_types.
//           This file tests that the harness captures non-strict diagnostics correctly.

// No #pragma strict_types — this file compiles in Pike's default lenient mode

int main() {
  // These assignments would be errors under strict_types but are silently
  // accepted without it. The harness must capture this difference.
  int x = "not an int";
  string s = 42;
  float f = "not a float";

  // Function call with wrong types — also silently accepted without strict
  mixed result = add("wrong", "types");

  return 0;
}

// Typed function — the type annotations here define its contract,
// but without strict_types at the call site, violations are not caught.
int add(int a, int b) {
  return a + b;
}
