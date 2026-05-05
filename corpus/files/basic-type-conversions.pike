//! Test implicit and explicit type conversions in Pike.
//! Valid file — all conversions are valid Pike.

#pike 7.8
#pragma strict_types

// Explicit casts with (type) syntax
int test_explicit_casts() {
  float f = 3.14;
  int i = (int)f;        // float -> int: truncates to 3
  string s = (string)i;  // int -> string
  float f2 = (float)s;   // string -> float
  int i2 = (int)f2;      // float -> int: truncates
  return i2;
}

// Implicit numeric promotions (Pike does not silently widen types in strict mode)
// In Pike, arithmetic between mixed types is allowed but may warn or cast.
// The compiler handles this at runtime in non-strict mode.

// int + float produces float in Pike
float test_arithmetic() {
  int a = 10;
  float b = 2.5;
  mixed result = a + b;  // runtime: int + float -> float
  return result;
}

// String conversions
string test_string_conversions() {
  int i = 42;
  float f = 3.14;
  string from_int = (string)i;    // "42"
  string from_float = (string)f;  // "3.14"
  int parsed = (int)from_int;     // back to int
  return from_float;
}

// Array element type consistency
array(int) test_array_int() {
  array(int) arr = ({ 1, 2, 3 });
  return arr;
}

array(string) test_array_string() {
  array(string) arr = ({ "a", "b", "c" });
  return arr;
}

// Constant expressions
constant PI = 3.14159;
constant INT_MAX = (int)"9223372036854775807";  // max int from string