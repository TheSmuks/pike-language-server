//! Test string types and operations in Pike.
//! Valid file — all string operations are valid.

#pike 7.8
#pragma strict_types

// String literal types
void test_string_literals() {
  string s1 = "hello";           // simple ASCII string
  string s2 = "你好";            // UTF-8 string (wide)
  string s3 = "line1\nline2";    // with escape
  string s4 = `foo`;            // backtick string
}

// String operations
void test_string_ops() {
  string s = "hello world";
  int len = sizeof(s);           // string length
  string upper = String.trim(s);  // trim whitespace
  array(string) parts = s / " "; // split
  string joined = parts * ",";   // join
}

// String.Buffer for concatenation
void test_string_buffer() {
  String.Buffer buf = String.Buffer();
  buf->add("hello");
  buf->add(" ");
  buf->add("world");
  string result = (string)buf;
}

// String trimming and manipulation
void test_string_functions() {
  string s = "  hello  ";
  string trimmed = String.trim(s);           // "hello"
  string upper = String.string_to_utf8(s);    // encode
  string lower = String.lowercase("HELLO");   // to lower
  array(string) chars = String.chars("abc");  // character array
}

// String ranges (substring operations)
void test_string_ranges() {
  string s = "hello world";
  string substring = s[0..4];        // "hello"
  string tail = s[6..];             // "world"
  string middle = s[0..<1];         // "hello worl"
}

// Index access
void test_string_index() {
  string s = "hello";
  int first_char = s[0];            // (int)'h'
  string slice = s[1..3];           // "ell"
}