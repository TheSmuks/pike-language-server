//! DefinitionTests.pike — Unit tests for symbol definition location resolution.
//!
//! Goal: Verify that Program.defined() and the introspection helpers used by the
//! LSP go-to-definition feature return correct file:line locations for functions,
//! classes, variables, constants, and inherited symbols.  These are the primitives
//! the TypeScript server calls through the worker to answer textDocument/definition.
//!
//! Pike behavior notes:
//!   - Program.defined(prog, name) returns a string for ANY name, even nonexistent
//!     ones — it always returns the file path at minimum.
//!   - Functions and classes get "file:line" precision.
//!   - Variables typically get only "file" (no line number).
//!   - Inherited symbols also return just the file path.
//!
//! Methodology: Each test compiles a Pike source via compile_string with a
//! DiagnosticHandler, then inspects the resulting program using Program.defined,
//! indices(), and type predicates to verify definition locations.

import PUnit;
import Common;

inherit PUnit.TestCase;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

private constant FILE_PATH = "/tmp/definition_test.pike";

//! Compile source and return ({program, handler}).
private array compile_source(string source) {
  object handler = Common()->DiagnosticHandler();
  program prog;
  mixed err = catch {
    prog = compile_string(source, FILE_PATH, handler);
  };
  return ({ prog, handler });
}

//! Get the definition location string for a symbol name from a program.
//! Returns the raw string from Program.defined, or 0 on error.
private string get_def_loc(program prog, string name) {
  mixed err = catch {
    return Program.defined(prog, name);
  };
  return 0;
}

//! Parse a definition location string "file:line" into ({"file", line}).
//! Returns 0 if the string has no line number (just a file path).
private array parse_def_loc(string def_loc) {
  if (!def_loc) return 0;
  string f; int l;
  if (sscanf(def_loc, "%s:%d", f, l) == 2) {
    return ({ f, l });
  }
  return 0;
}

// ===========================================================================
// 1. Function definition locations
// ===========================================================================

void test_function_definition_has_file_and_line() {
  // Functions get line-level precision from Program.defined.
  string src = "int add(int a, int b) { return a + b; }\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);
  assert_equal(0, sizeof(handler->errors));

  string def = get_def_loc(prog, "add");
  assert_not_null(def);
  assert_true(has_prefix(def, FILE_PATH));
  array parsed = parse_def_loc(def);
  assert_not_null(parsed, "Function definition should have line number");
  assert_equal(FILE_PATH, parsed[0]);
  assert_equal(1, parsed[1]);
}

void test_multiple_functions_have_distinct_lines() {
  // Two functions on different lines must produce different line numbers.
  string src =
    "int first() { return 1; }\n"
    "int second() { return 2; }\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  string def1 = get_def_loc(prog, "first");
  string def2 = get_def_loc(prog, "second");
  assert_not_null(def1);
  assert_not_null(def2);

  array p1 = parse_def_loc(def1);
  array p2 = parse_def_loc(def2);
  assert_not_null(p1, "first should have line number");
  assert_not_null(p2, "second should have line number");
  assert_true(p1[1] < p2[1]);
}

void test_function_on_line_three_reports_correct_line() {
  // A function declared on line 3 must report line 3.
  string src =
    "// comment\n"
    "// comment\n"
    "string greet() { return \"hello\"; }\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  string def = get_def_loc(prog, "greet");
  array parsed = parse_def_loc(def);
  assert_not_null(parsed, "greet should have line number");
  assert_equal(3, parsed[1]);
}

void test_void_function_definition_located() {
  // void functions must also be locatable.
  string src = "void noop() { }\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  string def = get_def_loc(prog, "noop");
  assert_not_null(def);
  assert_true(has_prefix(def, FILE_PATH));
  assert_not_null(parse_def_loc(def), "void function should have line number");
}

// ===========================================================================
// 2. Class definition locations
// ===========================================================================

void test_class_definition_has_file_and_line() {
  // A class declared at the top level must be locatable via Program.defined
  // on the class's own program (not the container program).
  string src = "class Point { int x; int y; }\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  object inst = prog();
  mixed val = inst["Point"];
  assert_true(programp(val));

  // Get the definition location of the class program itself
  string class_def = Program.defined(val);
  assert_not_null(class_def);
  assert_true(has_prefix(class_def, FILE_PATH));
  assert_not_null(parse_def_loc(class_def), "Class should have line number");
}

void test_class_member_function_located() {
  // A method inside a class must be locatable within the class's program.
  string src =
    "class Calculator {\n"
    "  int add(int a, int b) { return a + b; }\n"
    "}\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  object inst = prog();
  mixed cls = inst["Calculator"];
  assert_true(programp(cls));

  // The class's own definition should point to the file with line
  string class_def = Program.defined(cls);
  assert_not_null(class_def);
  assert_true(has_prefix(class_def, FILE_PATH));

  // Get the definition location of the add method within the class
  object class_inst = cls();
  mixed add_fn = class_inst["add"];
  assert_true(functionp(add_fn));

  // Try to get line-level location for the method via function_program
  mixed fp = function_program(add_fn);
  if (programp(fp)) {
    string method_def = get_def_loc(fp, "add");
    if (method_def) {
      assert_true(has_prefix(method_def, FILE_PATH));
    }
  }
}

void test_nested_class_located() {
  // A nested class must still have a definition location.
  string src =
    "class Outer {\n"
    "  class Inner { int x; }\n"
    "}\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  object inst = prog();
  mixed outer = inst["Outer"];
  assert_true(programp(outer));

  object outer_inst = outer();
  mixed inner = outer_inst["Inner"];
  assert_true(programp(inner));

  string inner_def = Program.defined(inner);
  assert_not_null(inner_def);
  assert_true(has_prefix(inner_def, FILE_PATH));
}

// ===========================================================================
// 3. Variable definition locations
// ===========================================================================

void test_global_variable_definition_in_file() {
  // A top-level variable's definition points to the compilation file.
  // Note: Pike may return only the file path (without line) for variables.
  string src = "int counter = 0;\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  string def = get_def_loc(prog, "counter");
  assert_not_null(def);
  assert_true(has_prefix(def, FILE_PATH));
}

void test_string_variable_definition_in_file() {
  // String variables must also be locatable in the file.
  string src = "string name = \"Pike\";\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  string def = get_def_loc(prog, "name");
  assert_not_null(def);
  assert_true(has_prefix(def, FILE_PATH));
}

void test_multiple_variables_all_in_file() {
  // Multiple variables on different lines must all resolve to our file.
  string src =
    "int x = 1;\n"
    "int y = 2;\n"
    "int z = 3;\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  foreach (({"x", "y", "z"}), string name) {
    string def = get_def_loc(prog, name);
    assert_not_null(def);
    assert_true(has_prefix(def, FILE_PATH),
      "Variable " + name + " should be in " + FILE_PATH);
  }
}

// ===========================================================================
// 4. Constant definition locations
// ===========================================================================

void test_constant_definition_in_file() {
  // A constant must resolve to the compilation file.
  string src = "constant VERSION = \"1.0\";\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  string def = get_def_loc(prog, "VERSION");
  assert_not_null(def);
  assert_true(has_prefix(def, FILE_PATH));
}

void test_constant_integer_definition_in_file() {
  // Integer constants must also resolve to the file.
  string src = "constant MAX_SIZE = 1024;\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  string def = get_def_loc(prog, "MAX_SIZE");
  assert_not_null(def);
  assert_true(has_prefix(def, FILE_PATH));
}

// ===========================================================================
// 5. Distinguishing user-defined from inherited symbols
// ===========================================================================

void test_user_symbol_has_file_prefix() {
  // User-defined symbols must have definitions starting with the compile path.
  string src = "int my_var = 42;\nvoid my_func() { }\nclass MyClass { }\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  foreach (({"my_var", "my_func", "MyClass"}), string name) {
    string def = get_def_loc(prog, name);
    assert_not_null(def);
    assert_true(has_prefix(def, FILE_PATH),
      "Symbol " + name + " should be in " + FILE_PATH);
  }
}

void test_inherited_symbol_also_in_file_but_distinguishable() {
  // Pike's Program.defined returns the file path for ALL symbols including
  // inherited ones.  The LSP uses indices() membership + definition comparison
  // to distinguish.  This test documents the behavior.
  string src = "int x = 1;\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  // create is auto-generated / inherited but Program.defined still returns file
  string def = get_def_loc(prog, "create");
  // It returns a string (not 0) — this is Pike's behavior
  assert_not_null(def);
  assert_true(has_prefix(def, FILE_PATH));

  // The distinction must be made by other means (e.g. checking if the symbol
  // appears in source text, or using the introspect.pike harness which filters
  // by prefix match on the file path).
}

// ===========================================================================
// 6. Symbols visible via indices() match expectations
// ===========================================================================

void test_defined_symbols_are_in_indices() {
  // Every symbol we defined in the source must appear in the program's indices.
  string src =
    "int alpha = 1;\n"
    "int beta() { return 2; }\n"
    "class Gamma { }\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  object inst = prog();
  array(string) names = indices(inst);

  assert_true(search(names, "alpha") >= 0);
  assert_true(search(names, "beta") >= 0);
  assert_true(search(names, "Gamma") >= 0);
}

void test_symbol_kind_via_type_predicates() {
  // We can classify symbols using type predicates on the instance values.
  string src =
    "int my_var = 42;\n"
    "void my_func() { }\n"
    "class MyClass { int x; }\n";
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  object inst = prog();

  // Variable: int value
  assert_true(intp(inst["my_var"]));
  // Function: function value
  assert_true(functionp(inst["my_func"]));
  // Class: program value
  assert_true(programp(inst["MyClass"]));
}

// ===========================================================================
// 7. Function line precision
// ===========================================================================

void test_functions_on_known_lines_report_correct_lines() {
  // Functions at specific line numbers must report those lines.
  string src =
    "void f1() { }\n"     // line 1
    "\n"                   // line 2
    "void f2() { }\n"     // line 3
    "\n"                   // line 4
    "void f3() { }\n";    // line 5
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  array p1 = parse_def_loc(get_def_loc(prog, "f1"));
  array p3 = parse_def_loc(get_def_loc(prog, "f2"));
  array p5 = parse_def_loc(get_def_loc(prog, "f3"));

  assert_not_null(p1); assert_not_null(p3); assert_not_null(p5);
  assert_equal(1, p1[1]);
  assert_equal(3, p3[1]);
  assert_equal(5, p5[1]);
}

void test_class_on_known_line_reports_correct_line() {
  // A class definition must report its line number via Program.defined
  // on the class program.
  string src =
    "// line 1\n"
    "class Foo {\n"          // line 2
    "  void m() { }\n"       // line 3
    "}\n";                   // line 4
  [program prog, object handler] = compile_source(src);
  assert_not_null(prog);

  object inst = prog();
  mixed cls = inst["Foo"];
  assert_true(programp(cls));

  string class_def = Program.defined(cls);
  assert_not_null(class_def);
  array parsed = parse_def_loc(class_def);
  assert_not_null(parsed, "Class should have line number");
  assert_equal(2, parsed[1]);
}
