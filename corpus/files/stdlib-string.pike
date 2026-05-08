//! Test String module functions in Pike.
//! Valid file — all String operations are valid.

#pike 7.8
#pragma strict_types

// String.Buffer for efficient concatenation
void test_string_buffer() {
  String.Buffer buf = String.Buffer();
  buf->add("hello");
  buf->add(" ");
  buf->add("world");
  buf->putchar('!'); // add single character
  string result = (string)buf;
}

// String.trim removes whitespace from both ends
void test_string_trim() {
  string s = " hello world ";
  string trimmed = String.trim(s);
  string left_only = String.trim_left(s);
  string right_only = String.trim_right(s);
}

// String.split and join
void test_string_split_join() {
  string s = "one,two,three";
  array(string) parts = s / ","; // split
  parts = String.split(s, ","); // alternative
  string joined = parts * ", "; // join
}

// String functions
void test_string_functions() {
  string upper = String.String0.upper_case("hello"); // "HELLO"
  string lower = String.String0.lower_case("WORLD"); // "world"
  int cmp = String.String0.nicmcmp("a", "b"); // case-insensitive compare

  // String.capitalize
  string cap = String.String0.capitalize("hello world");

  // String.replace
  string replaced = String.replace("hello world", "world", "pike");
}

// String.count
void test_string_count() {
  string s = "hello world";
  int count = String.count(s, "l"); // 3
  int count2 = String.count(s, "o"); // 2
}

// String.pad
void test_string_pad() {
  string s = "42";
  string left_padded = String.sprintf("%5s", ({s})); // " 42"
}
