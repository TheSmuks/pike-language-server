// Test file for unused variable/parameter lint detection
//
// Expected lint diagnostics:
// - P3001: 'unused_local' is unused
// - P3002: 'unused_param' is unused
// - P3002: '_intentionally_unused' is unused? No — _ prefix excludes it
// - No warning for 'used_var' (it IS used)
// - No warning for 'msg' parameter (it IS used)

string test_function(string msg, int unused_param, int _intentionally_unused) {
  string used_var = "hello";
  string unused_local = "world";

  write(msg + used_var);
  return used_var;
}

// Local function that's unused — should NOT trigger (file scope)
void helper_fn() {
  // But variables inside it should still be checked
  int inner_unused = 42;
}

// Class with unused members — should NOT trigger (may be external)
class Animal {
  string name;
  int age;

  void create(string n, int a) {
    name = n;
    age = a;
  }
}
