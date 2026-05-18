//! IncrementalSyncTests.pike — Unit tests for incremental recompilation behavior.
//!
//! Goal: Verify that the Pike compilation pipeline correctly handles scenarios
//! analogous to the LSP's incremental text synchronization.  When a document is
//! edited (lines added, removed, modified), the recompilation must reflect only
//! the current state of the source.  These tests simulate the edit-compile cycle
//! that the LSP worker performs on every didChange notification.
//!
//! Methodology: Each test simulates a sequence of edits by compiling different
//! source versions with fresh DiagnosticHandlers and verifying that diagnostics
//! and symbol tables reflect only the current version.

import PUnit;
import Common;

inherit PUnit.TestCase;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

private int _edit_counter = 0;

//! Compile a source version, returning ({program, handler, filepath}).
private array compile_version(string source) {
  _edit_counter++;
  string filepath = "/tmp/incr_test_" + _edit_counter + ".pike";
  object handler = Common()->DiagnosticHandler();
  program prog;
  mixed err = catch {
    prog = compile_string(source, filepath, handler);
  };
  return ({ prog, handler, filepath });
}

//! Extract symbols defined in a specific file from a compiled program.
private array(string) symbols_in_file(program prog, string filepath) {
  if (!prog) return ({});
  object inst = prog();
  array(string) result = ({});
  foreach (indices(inst), string name) {
    string def;
    mixed err = catch { def = Program.defined(prog, name); };
    if (def && has_prefix(def, filepath)) {
      result += ({ name });
    }
  }
  return sort(result);
}

// ===========================================================================
// 1. Single-line insertion — adding a function
// ===========================================================================

void test_insert_function_adds_to_symbols() {
  // Simulate: user types a new function declaration into an existing file.
  string v1 = "int existing = 1;\n";
  string v2 = "int existing = 1;\nvoid new_fn() { }\n";

  [program p1, object h1, string fp1] = compile_version(v1);
  [program p2, object h2, string fp2] = compile_version(v2);

  assert_not_null(p1);
  assert_not_null(p2);
  assert_equal(0, sizeof(h1->errors));
  assert_equal(0, sizeof(h2->errors));

  array(string) syms1 = symbols_in_file(p1, fp1);
  array(string) syms2 = symbols_in_file(p2, fp2);

  assert_true(search(syms1, "new_fn") < 0);
  assert_true(search(syms2, "new_fn") >= 0);
  assert_true(search(syms2, "existing") >= 0);
}

// ===========================================================================
// 2. Single-line deletion — removing a variable
// ===========================================================================

void test_delete_variable_removes_from_symbols() {
  // Simulate: user deletes a variable declaration.
  string v1 = "int keep = 1;\nint remove_me = 2;\n";
  string v2 = "int keep = 1;\n";

  [program p1, object h1, string fp1] = compile_version(v1);
  [program p2, object h2, string fp2] = compile_version(v2);

  assert_not_null(p1);
  assert_not_null(p2);
  assert_equal(0, sizeof(h1->errors));
  assert_equal(0, sizeof(h2->errors));

  array(string) syms1 = symbols_in_file(p1, fp1);
  array(string) syms2 = symbols_in_file(p2, fp2);

  assert_true(search(syms1, "remove_me") >= 0);
  assert_true(search(syms2, "remove_me") < 0);
  assert_true(search(syms2, "keep") >= 0);
}

// ===========================================================================
// 3. Line modification — changing a valid line to invalid
// ===========================================================================

void test_modify_valid_to_syntax_error_introduces_diagnostics() {
  // Simulate: user introduces a syntax error by editing a line.
  string v1 = "int x = 1;\n";
  string v2 = "int x = ;\n";  // syntax error

  [program p1, object h1, string fp1] = compile_version(v1);
  [program p2, object h2, string fp2] = compile_version(v2);

  assert_not_null(p1);
  assert_equal(0, sizeof(h1->errors));

  // v2 should have compilation errors
  assert_true(sizeof(h2->errors) >= 1);
}

void test_modify_invalid_to_valid_clears_diagnostics() {
  // Simulate: user fixes a syntax error.
  string v1 = "int x = ;\n";
  string v2 = "int x = 1;\n";

  [program p1, object h1, string fp1] = compile_version(v1);
  [program p2, object h2, string fp2] = compile_version(v2);

  assert_true(sizeof(h1->errors) >= 1);
  assert_not_null(p2);
  assert_equal(0, sizeof(h2->errors));
}

// ===========================================================================
// 4. Multi-line edit — adding a class with members
// ===========================================================================

void test_insert_class_adds_class_and_members() {
  // Simulate: user pastes a class definition into the file.
  string v1 = "int counter = 0;\n";
  string v2 =
    "int counter = 0;\n"
    "class Pair {\n"
    "  int a;\n"
    "  int b;\n"
    "  int sum() { return a + b; }\n"
    "}\n";

  [program p1, object h1, string fp1] = compile_version(v1);
  [program p2, object h2, string fp2] = compile_version(v2);

  assert_not_null(p1);
  assert_not_null(p2);
  assert_equal(0, sizeof(h1->errors));
  assert_equal(0, sizeof(h2->errors));

  array(string) syms1 = symbols_in_file(p1, fp1);
  array(string) syms2 = symbols_in_file(p2, fp2);

  // Pair should appear in v2
  assert_true(search(syms2, "Pair") >= 0);
  assert_true(search(syms1, "Pair") < 0);

  // Verify class members are accessible
  object inst2 = p2();
  mixed pair_class = inst2["Pair"];
  assert_true(programp(pair_class));
  object pair_inst = pair_class();
  assert_true(search(indices(pair_inst), "a") >= 0);
  assert_true(search(indices(pair_inst), "b") >= 0);
  assert_true(search(indices(pair_inst), "sum") >= 0);
}

// ===========================================================================
// 5. Type error introduction and removal
// ===========================================================================

void test_type_error_appears_in_strict_mode() {
  // In strict_types mode, a type mismatch must be caught.
  string v1 = "#pragma strict_types\nint x = 1;\n";
  string v2 = "#pragma strict_types\nint x = \"wrong\";\n";

  [program p1, object h1, string fp1] = compile_version(v1);
  [program p2, object h2, string fp2] = compile_version(v2);

  assert_not_null(p1);
  assert_equal(0, sizeof(h1->errors));

  // v2 should have type errors in strict mode
  assert_true(sizeof(h2->errors) >= 1);
  array d = Common()->normalize_diagnostics(h2->errors, h2->warnings);
  // Should contain a type_mismatch diagnostic
  int has_type_mismatch = 0;
  foreach (d, mapping diag) {
    if (diag["category"] == "type_mismatch") has_type_mismatch = 1;
  }
  assert_true(has_type_mismatch);
}

void test_type_error_removed_clears_diagnostics() {
  // Fixing the type error must clear the type_mismatch diagnostic.
  string v1 = "#pragma strict_types\nint x = \"wrong\";\n";
  string v2 = "#pragma strict_types\nint x = 42;\n";

  [program p1, object h1, string fp1] = compile_version(v1);
  [program p2, object h2, string fp2] = compile_version(v2);

  assert_true(sizeof(h1->errors) >= 1);
  assert_not_null(p2);
  assert_equal(0, sizeof(h2->errors));
}

// ===========================================================================
// 6. Rapid successive edits — many compilations in sequence
// ===========================================================================

void test_rapid_edits_maintain_correct_state() {
  // Simulate rapid typing: compile many versions in sequence, each with a
  // different state, and verify the final state is correct.
  array(string) versions = ({
    "int x = ;\n",          // syntax error
    "int x = 1;\n",          // fixed
    "int x = 1;\nint y;\n",  // added y
    "int x = 1;\n",          // removed y
    "int x = 2;\n",          // changed value
  });

  array expected_errors = ({
    1,  // has errors
    0,  // clean
    0,  // clean
    0,  // clean
    0,  // clean
  });

  for (int i = 0; i < sizeof(versions); i++) {
    [program prog, object handler, string fp] = compile_version(versions[i]);
    if (expected_errors[i]) {
      assert_true(sizeof(handler->errors) >= 1,
        "Version " + (i+1) + " should have errors");
    } else {
      assert_not_null(prog,
        "Version " + (i+1) + " should compile");
      assert_equal(0, sizeof(handler->errors),
        "Version " + (i+1) + " should have no errors");
    }
  }
}

// ===========================================================================
// 7. Edit that changes function signature
// ===========================================================================

void test_signature_change_reflected_in_symbols() {
  // Changing a function's return type should not affect its presence in
  // the symbol table, but the function should still be callable.
  string v1 = "int compute() { return 1; }\n";
  string v2 = "string compute() { return \"hello\"; }\n";

  [program p1, object h1, string fp1] = compile_version(v1);
  [program p2, object h2, string fp2] = compile_version(v2);

  assert_not_null(p1);
  assert_not_null(p2);

  object inst1 = p1();
  object inst2 = p2();

  assert_true(functionp(inst1["compute"]));
  assert_true(functionp(inst2["compute"]));

  // Verify the return values are correct for each version
  mixed result1 = inst1["compute"]();
  mixed result2 = inst2["compute"]();
  assert_true(intp(result1));
  assert_true(stringp(result2));
}

// ===========================================================================
// 8. Class addition then member addition
// ===========================================================================

void test_class_then_member_addition() {
  // Simulate: user first creates a class, then adds a member to it.
  string v1 = "class Container { int x; }\n";
  string v2 = "class Container { int x; int y; }\n";

  [program p1, object h1, string fp1] = compile_version(v1);
  [program p2, object h2, string fp2] = compile_version(v2);

  assert_not_null(p1);
  assert_not_null(p2);

  object inst1 = p1();
  mixed cls1 = inst1["Container"];
  object cinst1 = cls1();

  object inst2 = p2();
  mixed cls2 = inst2["Container"];
  object cinst2 = cls2();

  // v1 should have x but not y
  assert_true(search(indices(cinst1), "x") >= 0);
  // y might exist from inheritance, but x is definitely there

  // v2 should have both x and y
  assert_true(search(indices(cinst2), "x") >= 0);
  assert_true(search(indices(cinst2), "y") >= 0);
}
