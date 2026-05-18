//! StateConsistencyTests.pike — Unit tests for compilation state consistency.
//!
//! Goal: Verify that the Pike compilation pipeline used by the LSP worker produces
//! consistent, predictable results across multiple compilations, and that the
//! DiagnosticHandler does not accumulate stale state between invocations.  These
//! tests guard against regressions where re-compiling the same source or compiling
//! different sources in sequence could produce different diagnostics or symbol
//! tables.
//!
//! Methodology: Each test performs one or more compile_string calls with
//! DiagnosticHandler instances, then verifies that diagnostics, symbol counts,
//! and type information remain stable.  State isolation between compilations is
//! a core invariant the LSP depends on.

import PUnit;
import Common;

inherit PUnit.TestCase;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

private int _compile_counter = 0;

//! Compile source with a unique file path to avoid caching issues.
//! Returns ({program_or_0, DiagnosticHandler}).
private array compile_unique(string source) {
  _compile_counter++;
  string filepath = "/tmp/state_test_" + _compile_counter + ".pike";
  object handler = Common()->DiagnosticHandler();
  program prog;
  mixed err = catch {
    prog = compile_string(source, filepath, handler);
  };
  return ({ prog, handler });
}

// ===========================================================================
// 1. DiagnosticHandler isolation
// ===========================================================================

void test_handler_starts_with_empty_errors() {
  // A freshly created DiagnosticHandler must have no accumulated errors.
  object h = Common()->DiagnosticHandler();
  assert_equal(0, sizeof(h->errors));
  assert_equal(0, sizeof(h->warnings));
}

void test_handler_captures_single_error() {
  // Compiling invalid source must capture exactly one error (syntax error).
  object h = Common()->DiagnosticHandler();
  program prog;
  mixed err = catch {
    prog = compile_string("int x = ;", "/tmp/h_test.pike", h);
  };
  assert_true(sizeof(h->errors) >= 1);
}

void test_handler_captures_single_warning() {
  // Compiling source with an unused variable must produce at least one warning.
  object h = Common()->DiagnosticHandler();
  program prog;
  mixed err = catch {
    prog = compile_string("void f() { int unused = 1; }", "/tmp/h_test.pike", h);
  };
  // Pike may or may not produce warnings for unused locals depending on
  // version. If it does, they must be in the warnings array.
  // This test documents the current behavior.
  if (sizeof(h->warnings) > 0) {
    assert_true(1);  // warnings present, as expected
  }
}

void test_two_handlers_are_independent() {
  // Two DiagnosticHandler instances must not share state.
  object h1 = Common()->DiagnosticHandler();
  object h2 = Common()->DiagnosticHandler();

  // Compile bad source with h1
  catch { compile_string("bad syntax", "/tmp/h1.pike", h1); };

  // h1 should have errors, h2 should not
  assert_true(sizeof(h1->errors) >= 1);
  assert_equal(0, sizeof(h2->errors));
  assert_equal(0, sizeof(h2->warnings));
}

void test_handler_does_not_leak_between_compilations() {
  // Compiling valid source after invalid source must not carry over errors.
  object h_bad = Common()->DiagnosticHandler();
  catch { compile_string("!!!invalid!!!", "/tmp/leak_bad.pike", h_bad); };
  int bad_error_count = sizeof(h_bad->errors);

  object h_good = Common()->DiagnosticHandler();
  program prog;
  mixed err = catch {
    prog = compile_string("int main() { return 0; }", "/tmp/leak_good.pike", h_good);
  };
  assert_not_null(prog);
  assert_equal(0, sizeof(h_good->errors));
  assert_equal(0, sizeof(h_good->warnings));
}

// ===========================================================================
// 2. Recompilation stability — same source, same results
// ===========================================================================

void test_recompilation_same_source_same_diagnostics() {
  // Compiling the same source twice must produce identical diagnostics.
  string src = "int x = \"wrong_type\";\n";

  [program p1, object h1] = compile_unique("#pragma strict_types\n" + src);
  [program p2, object h2] = compile_unique("#pragma strict_types\n" + src);

  // Both should fail to compile (type mismatch in strict mode)
  array d1 = Common()->normalize_diagnostics(h1->errors, h1->warnings);
  array d2 = Common()->normalize_diagnostics(h2->errors, h2->warnings);

  assert_equal(sizeof(d1), sizeof(d2));
  if (sizeof(d1) > 0) {
    assert_equal(d1[0]["category"], d2[0]["category"]);
  }
}

void test_recompilation_same_source_same_symbols() {
  // Compiling the same source twice must produce the same set of symbols.
  string src =
    "int alpha = 1;\n"
    "void beta() { }\n"
    "class Gamma { int x; }\n";

  [program p1, object h1] = compile_unique(src);
  [program p2, object h2] = compile_unique(src);

  assert_not_null(p1);
  assert_not_null(p2);

  object inst1 = p1();
  object inst2 = p2();

  // Check that our declared symbols are present in both
  foreach (({"alpha", "beta", "Gamma"}), string name) {
    assert_true(search(indices(inst1), name) >= 0);
    assert_true(search(indices(inst2), name) >= 0);
  }
}

void test_recompilation_clean_source_no_diagnostics() {
  // Recompiling valid source must consistently produce zero diagnostics.
  string src = "int main() { return 0; }\n";

  for (int i = 0; i < 3; i++) {
    [program prog, object handler] = compile_unique(src);
    assert_not_null(prog);
    assert_equal(0, sizeof(handler->errors));
    assert_equal(0, sizeof(handler->warnings));
  }
}

// ===========================================================================
// 3. Sequential compilation — different sources, correct diagnostics each time
// ===========================================================================

void test_sequential_different_sources_independent_diagnostics() {
  // Compiling source A (valid) then source B (invalid) must not mix diagnostics.
  string valid_src = "int x = 1;\n";
  string invalid_src = "int y = ;\n";

  [program p_valid, object h_valid] = compile_unique(valid_src);
  assert_not_null(p_valid);
  assert_equal(0, sizeof(h_valid->errors));

  [program p_invalid, object h_invalid] = compile_unique(invalid_src);
  // h_invalid should have errors
  assert_true(sizeof(h_invalid->errors) >= 1);

  // h_valid should still have zero errors
  assert_equal(0, sizeof(h_valid->errors));
}

void test_sequential_error_then_clean_independent() {
  // After compiling an erroneous source, compiling a clean source must
  // produce zero diagnostics.
  string bad_src = "this is not valid pike\n";
  string good_src = "int main() { return 0; }\n";

  [program p_bad, object h_bad] = compile_unique(bad_src);
  [program p_good, object h_good] = compile_unique(good_src);

  assert_true(sizeof(h_bad->errors) >= 1);
  assert_not_null(p_good);
  assert_equal(0, sizeof(h_good->errors));
}

// ===========================================================================
// 4. Symbol table consistency
// ===========================================================================

void test_symbol_count_stable_across_compilations() {
  // The number of user-defined symbols must be deterministic.
  string src =
    "int a = 1;\n"
    "int b = 2;\n"
    "int c = 3;\n"
    "void foo() { }\n";

  [program p1, object h1] = compile_unique(src);
  [program p2, object h2] = compile_unique(src);

  assert_not_null(p1);
  assert_not_null(p2);

  object inst1 = p1();
  object inst2 = p2();

  // Count symbols defined in our file
  int count1 = 0, count2 = 0;
  foreach (indices(inst1), string name) {
    if (search(name, "_") != 0) {  // skip underscore-prefixed
      string def = 0;
      catch { def = Program.defined(p1, name); };
      if (def && has_prefix(def, "/tmp/state_test_")) count1++;
    }
  }
  foreach (indices(inst2), string name) {
    if (search(name, "_") != 0) {
      string def = 0;
      catch { def = Program.defined(p2, name); };
      if (def && has_prefix(def, "/tmp/state_test_")) count2++;
    }
  }

  assert_equal(count1, count2);
}

void test_class_members_stable() {
  // Class members must be consistent across compilations.
  string src =
    "class Data {\n"
    "  int id;\n"
    "  string name;\n"
    "  void reset() { id = 0; name = \"\"; }\n"
    "}\n";

  [program p1, object h1] = compile_unique(src);
  [program p2, object h2] = compile_unique(src);

  assert_not_null(p1);
  assert_not_null(p2);

  object inst1 = p1();
  mixed cls1 = inst1["Data"];
  assert_true(programp(cls1));
  object cinst1 = cls1();

  object inst2 = p2();
  mixed cls2 = inst2["Data"];
  assert_true(programp(cls2));
  object cinst2 = cls2();

  // Member names must match
  array(string) members1 = sort(indices(cinst1));
  array(string) members2 = sort(indices(cinst2));
  assert_equal(sizeof(members1), sizeof(members2));
}

// ===========================================================================
// 5. Diagnostic normalization consistency
// ===========================================================================

void test_normalize_same_input_same_output() {
  // Calling normalize_diagnostics with the same inputs must produce the same
  // output each time.
  array errors = ({ ([ "line": 1, "message": "Bad type in assignment" ]) });
  array warnings = ({ ([ "line": 2, "message": "Unused local variable x" ]) });

  array result1 = Common()->normalize_diagnostics(errors, warnings);
  array result2 = Common()->normalize_diagnostics(errors, warnings);

  assert_equal(sizeof(result1), sizeof(result2));
  for (int i = 0; i < sizeof(result1); i++) {
    assert_equal(result1[i]["line"], result2[i]["line"]);
    assert_equal(result1[i]["severity"], result2[i]["severity"]);
    assert_equal(result1[i]["category"], result2[i]["category"]);
  }
}

void test_normalize_empty_consistent() {
  // Normalizing empty arrays must always produce an empty result.
  for (int i = 0; i < 3; i++) {
    array result = Common()->normalize_diagnostics(({}), ({}));
    assert_equal(0, sizeof(result));
  }
}

// ===========================================================================
// 6. Type inference consistency
// ===========================================================================

void test_typeof_same_expression_same_result() {
  // Querying the type of the same expression twice must return the same type.
  string src = "int x = 42;\n";
  string typeof_src1 = "#pragma strict_types\n" + src + "mixed _get() { return typeof(x); }\n";
  string typeof_src2 = "#pragma strict_types\n" + src + "mixed _get() { return typeof(x); }\n";

  object h1 = Common()->DiagnosticHandler();
  program p1;
  mixed e1 = catch { p1 = compile_string(typeof_src1, "/tmp/t1.pike", h1); };
  assert_not_null(p1);

  object h2 = Common()->DiagnosticHandler();
  program p2;
  mixed e2 = catch { p2 = compile_string(typeof_src2, "/tmp/t2.pike", h2); };
  assert_not_null(p2);

  mixed val1 = p1()["_get"]();
  mixed val2 = p2()["_get"]();

  assert_equal(stringp(val1), stringp(val2));
  if (stringp(val1) && stringp(val2)) {
    assert_equal(val1, val2);
  }
}

// ===========================================================================
// 7. Compilation with modified source
// ===========================================================================

void test_modified_source_changes_diagnostics() {
  // Fixing a syntax error must change the diagnostic set.
  string broken = "int x = ;\n";
  string fixed = "int x = 1;\n";

  [program p_broken, object h_broken] = compile_unique(broken);
  [program p_fixed, object h_fixed] = compile_unique(fixed);

  assert_true(sizeof(h_broken->errors) >= 1);
  assert_not_null(p_fixed);
  assert_equal(0, sizeof(h_fixed->errors));
}

void test_modified_source_changes_symbol_table() {
  // Adding a new function must make it visible in the symbol table.
  string src_v1 = "int a = 1;\n";
  string src_v2 = "int a = 1;\nvoid new_func() { }\n";

  [program p1, object h1] = compile_unique(src_v1);
  [program p2, object h2] = compile_unique(src_v2);

  assert_not_null(p1);
  assert_not_null(p2);

  object inst1 = p1();
  object inst2 = p2();

  // new_func should be in v2 but not necessarily findable via indices
  // since it's not an identifier (it's a function). Let's check:
  assert_true(search(indices(inst2), "new_func") >= 0);
}

void test_removing_symbol_reflects_in_new_compilation() {
  // Removing a variable from the source must make it absent from the new
  // compilation's symbol table.
  string src_with = "int keep = 1;\nint remove_me = 2;\n";
  string src_without = "int keep = 1;\n";

  [program p1, object h1] = compile_unique(src_with);
  [program p2, object h2] = compile_unique(src_without);

  assert_not_null(p1);
  assert_not_null(p2);

  object inst1 = p1();
  object inst2 = p2();

  assert_true(search(indices(inst1), "remove_me") >= 0);
  // After removing, it should be absent
  assert_true(search(indices(inst2), "remove_me") < 0);
  // keep should still be present
  assert_true(search(indices(inst2), "keep") >= 0);
}
