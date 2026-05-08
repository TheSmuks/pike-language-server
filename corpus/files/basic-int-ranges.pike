//! Test integer ranges and zero types in Pike.
//! Valid file — all int operations are valid.

#pike 7.8
#pragma strict_types

// Integer literal ranges
void test_int_literals() {
  int positive = 42;
  int negative = -17;
  int zero = 0;
  int hex = 0xFF; // hexadecimal (255)
  int octal = 0777; // octal
  int binary = 0b1010; // binary (10) — Pike 7.8+
}

// Int ranges — Pike ints are 64-bit signed
void test_int_ranges() {
  int max_int = 9223372036854775807; // max 64-bit signed
  int min_int = -9223372036854775808; // min 64-bit signed
  int typical = 1; // small positive
}

// Zero type — Pike has no separate zero type; null is distinct
void test_zero_related() {
  int i = 0; // zero as int
  int neg_zero = -0; // zero (same as 0)
  mixed m; // uninitialized mixed
}

// Integer operations
void test_int_operations() {
  int a = 10;
  int b = 3;
  int sum = a + b; // 13
  int diff = a - b; // 7
  int prod = a * b; // 30
  int div = a / b; // 3 (integer division)
  int mod = a % b; // 1
  int neg = -a; // -10
}

// Bit operations
void test_bit_operations() {
  int x = 0x55; // 0101_0101
  int shifted = x << 2; // 0x154
  int masked = x & 0x0F; // 0x05
  int ored = x | 0x0F; // 0x5F
  int xored = x ^ 0x0F; // 0x5A
}

// Comparison operators
void test_comparisons() {
  int a = 5;
  int b = 10;
  if (a < b) { /* true */ }
  if (a > 0 && b > 0) { /* true */ }
  if (a <= 5) { /* true */ }
  if (b >= 10) { /* true */ }
  if (a != b) { /* true */ }
}

// Overflow behavior (Pike wraps around in unpredictable ways)
void test_int_overflow() {
  int big = 9223372036854775807;
  // Adding 1 to max int wraps (undefined behavior in Pike)
  // This is intentionally not tested here as it would cause runtime errors
}
