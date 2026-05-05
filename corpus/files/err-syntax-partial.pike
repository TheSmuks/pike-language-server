//! Test partial/incomplete programs (should produce Pike errors).
//! Error file — intentionally incomplete code.

#pike 7.8
#pragma strict_types

// Missing closing brace / incomplete block
void test_incomplete_block() {
  if (true) {
    // file ends here without closing brace

// Missing semicolon after statement
void test_missing_semicolon() {
  int x = 42
  int y = 10;
}

// Incomplete expression
void test_incomplete_expr() {
  int x = 5 +
}

// Missing function body
int incomplete_function(