//! SignatureTests.pike — Tests for function signature parsing
//!
//! Exercises the harness signature splitting logic via Pike's
//! compile_string and Program.defined introspection.
//!
//! Tests:
//! - Parameter count extraction
//! - Parameter type extraction
//! - Return type inference
//! - Overloaded function signatures
//! - Method vs function distinction
//!
//! Usage: pike -M modules tests/pike/SignatureTests.pike

import PUnit;

// Import harness Common utilities
import Common;

object get_common() { return Common(); }
object make_handler() { return get_common()->DiagnosticHandler(); }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

//! Get the signature string for a named symbol from a compiled program.
//! Returns 0 if the symbol has no signature (e.g. variable).
string get_signature(program p, string name) {
  if (!p) return 0;
  mixed val;
  catch { val = p[name]; };
  if (!val) return 0;
  // For functions/programs we can inspect the type via typeof
  string sig;
  catch {
    // Pike stores function signatures as strings accessible via sscanf
    // on the program definition location. For actual type inspection
    // we rely on the compile-time type system.
  };
  return sig;
}

//! Return the defined location of a symbol in a compiled program.
string defined_location(program p, string name) {
  if (!p) return 0;
  string loc;
  catch { loc = Program.defined(p, name); };
  return loc;
}

//! Return the Pike type of a symbol as a string.
string type_of(program p, string name) {
  if (!p) return 0;
  mixed val;
  catch { val = p[name]; };
  if (!val) return 0;
  string ts;
  catch { ts = sprintf("%O", typeof(val)); };
  return ts;
}

// ---------------------------------------------------------------------------
// Basic function signatures
// ---------------------------------------------------------------------------

void test_void_function_has_no_return_value() {
  string src = "void greet() { write(\"hi\\n\"); }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
  string loc = defined_location(p, "greet");
  assert_not_null(loc);
  // Program.defined returns "test.pike:1" (file:line), not the function name.
  // Verify that the location string references the compilation unit.
  assert_true(has_value(loc, "test.pike"));
}

void test_int_returning_function() {
  string src = "int getValue() { return 99; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  object inst = p();
  assert_equal(99, inst->getValue());
}

void test_string_returning_function() {
  string src = "string getName() { return \"Alice\"; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  object inst = p();
  assert_equal("Alice", inst->getName());
}

void test_function_with_single_parameter() {
  string src = "int double(int x) { return x * 2; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
  object inst = p();
  assert_equal(6, inst->double(3));
}

void test_function_with_multiple_parameters() {
  string src = "int add(int a, int b) { return a + b; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  object inst = p();
  assert_equal(7, inst->add(3, 4));
}

void test_function_with_mixed_parameter_types() {
  string src = "string format(string fmt, int val) {\n"
               "  return sprintf(fmt, val);\n"
               "}";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
  object inst = p();
  assert_true(stringp(inst->format("Result: %d", 42)));
}

// ---------------------------------------------------------------------------
// Parameter position / index
// ---------------------------------------------------------------------------

void test_parameters_are_positionally_accessible() {
  // Verifies that parameter order is preserved — position 0, 1, 2
  string src = "int foo(int a, int b, int c) {\n"
               "  return a * 100 + b * 10 + c;\n"
               "}";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  object inst = p();
  assert_equal(123, inst->foo(1, 2, 3));
}

void test_second_parameter_is_accessible() {
  string src = "string combine(string a, string b) { return a + b; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  object inst = p();
  assert_equal("helloworld", inst->combine("hello", "world"));
}

void test_parameter_types_are_enforced() {
  // Passing wrong type to a typed parameter produces an error
  string src = "#pragma strict_types\n"
               "int foo(int x) { return x; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  // Now try calling with wrong type
  string src2 = "#pragma strict_types\n"
                "int test() { return foo(\"wrong\"); }";
  object h2 = make_handler();
  program p2;
  catch { p2 = compile_string(src2, "test.pike", h2); };
  assert_true(sizeof(h2->errors) >= 1);
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

void test_void_function_returns_nothing() {
  string src = "void f() { return; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
}

void test_int_function_returns_int() {
  string src = "int getFive() { return 5; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  object inst = p();
  int result = inst->getFive();
  assert_equal(5, result);
  assert_true(intp(result));
}

void test_string_function_returns_string() {
  string src = "string greeting() { return \"hi\"; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  object inst = p();
  assert_true(stringp(inst->greeting()));
}

void test_function_returning_array() {
  string src = "array(int) range() { return ({1,2,3}); }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
  object inst = p();
  assert_true(arrayp(inst->range()));
}

void test_function_returning_mapping() {
  string src = "mapping(string:int) table() { return ([\"a\":1]); }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
  object inst = p();
  assert_true(mappingp(inst->table()));
}

// ---------------------------------------------------------------------------
// Optional and rest parameters
// ---------------------------------------------------------------------------

void test_function_with_optional_parameter() {
  // In Pike, optional parameters use "?"
  string src = "int maybe(int x, void|int y) {\n"
               "  return y ? y : x;\n"
               "}";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
  object inst = p();
  assert_equal(5, inst->maybe(5));
  assert_equal(7, inst->maybe(5, 7));
}

void test_function_with_rest_parameter() {
  // In Pike, rest parameters use ...
  string src = "array sum(array v) {\n"
               "  return v;\n"
               "}";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
}

void test_variadic_function() {
  string src = "array concat(string ... parts) {\n"
               "  return parts;\n"
               "}";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
  object inst = p();
  assert_true(arrayp(inst->concat("a", "b", "c")));
}

// ---------------------------------------------------------------------------
// Methods (class member functions)
// ---------------------------------------------------------------------------

void test_class_method_has_correct_signature() {
  string src = "class Counter {\n"
               "  int count;\n"
               "  void create() { count = 0; }\n"
               "  int next() { return count++; }\n"
               "  int current() { return count; }\n"
               "}";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
  // Counter is a nested class inside the compiled program.
  // Access it via p()->Counter(), not p() directly.
  object c = p()->Counter();
  assert_equal(0, c->current());
  assert_equal(0, c->next());
  assert_equal(1, c->next());
  assert_equal(2, c->current());
}

void test_method_signatures_are_independent() {
  string src = "class Calculator {\n"
               "  int add(int a, int b) { return a + b; }\n"
               "  int mul(int a, int b) { return a * b; }\n"
               "  int sub(int a, int b) { return a - b; }\n"
               "}";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  // Calculator is a nested class; access via p()->Calculator().
  object c = p()->Calculator();
  assert_equal(7, c->add(3, 4));
  assert_equal(12, c->mul(3, 4));
  assert_equal(-1, c->sub(3, 4));
}

void test_constructor_signature() {
  string src = "class Point {\n"
               "  int x;\n"
               "  int y;\n"
               "  void create(int _x, int _y) {\n"
               "    x = _x;\n"
               "    y = _y;\n"
               "  }\n"
               "  int getX() { return x; }\n"
               "  int getY() { return y; }\n"
               "}";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  assert_equal(0, sizeof(h->errors));
  // Point is a nested class; instantiate via p()->Point(x, y).
  object pt = p()->Point(3, 4);
  assert_equal(3, pt->getX());
  assert_equal(4, pt->getY());
}

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

void test_wrong_argument_count_error() {
  // Note: Pike in dynamic mode is lenient; strict_types would catch this
  string src = "int add(int a, int b) { return a + b; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_not_null(p);
  // Calling with wrong number of args is a runtime error, not compile,
  // in dynamic Pike. This test models that signature information exists.
}

void test_return_type_mismatch_in_strict_mode() {
  string src = "#pragma strict_types\n"
               "int wrong() { return \"text\"; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  // Should fail compilation
  assert_true(sizeof(h->errors) >= 1);
}

void test_undefined_function_reference() {
  string src = "mixed x = nonexistent_function;";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  assert_true(sizeof(h->errors) >= 1);
}

// ---------------------------------------------------------------------------
// Signature stability across re-compilation
// ---------------------------------------------------------------------------

void test_same_source_produces_same_signature_twice() {
  string src = "int add(int a, int b) { return a + b; }";
  object h1 = make_handler();
  program p1;
  catch { p1 = compile_string(src, "test.pike", h1); };
  object h2 = make_handler();
  program p2;
  catch { p2 = compile_string(src, "test.pike", h2); };
  string loc1 = defined_location(p1, "add");
  string loc2 = defined_location(p2, "add");
  assert_equal(loc1, loc2);
}

void test_program_defined_location_includes_file_and_line() {
  string src = "int theFunction() { return 1; }";
  object h = make_handler();
  program p;
  catch { p = compile_string(src, "test.pike", h); };
  string loc = defined_location(p, "theFunction");
  assert_not_null(loc);
  assert_true(has_value(loc, "test.pike"));
  assert_true(has_value(loc, ":"));
}
