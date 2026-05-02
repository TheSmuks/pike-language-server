//! DiagnosticsTests.pike — Unit tests for normalize_diagnostics function

import PUnit;
import PUnit.TestRunner;

// Import Common module
import Common;

inherit PUnit.TestCase;

// Access Common module object
object get_common() { return Common(); }

void test_normalize_empty_input() {
  array result = get_common()->normalize_diagnostics(({}), ({}));
  assert_equal(0, sizeof(result));
}

void test_normalize_error_only() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Undefined identifier foo." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal(1, sizeof(result));
  assert_equal("error", result[0]["severity"]);
  assert_equal(10, result[0]["line"]);
  assert_equal("undefined_identifier", result[0]["category"]);
}

void test_normalize_warning_only() {
  array warnings = ({
    ([ "file": "test.pike", "line": 5, "message": "Unused local variable x." ])
  });
  array result = get_common()->normalize_diagnostics(({}), warnings);
  assert_equal(1, sizeof(result));
  assert_equal("warning", result[0]["severity"]);
  assert_equal("unused_variable", result[0]["category"]);
}

void test_normalize_mixed_errors_and_warnings() {
  array errors = ({
    ([ "file": "test.pike", "line": 20, "message": "Syntax error." ])
  });
  array warnings = ({
    ([ "file": "test.pike", "line": 5, "message": "Unused local variable." ])
  });
  array result = get_common()->normalize_diagnostics(errors, warnings);
  // Should be sorted by line number
  assert_equal(2, sizeof(result));
  assert_equal(5, result[0]["line"]);
  assert_equal(20, result[1]["line"]);
}

void test_normalize_continuation_expected_line() {
  array errors = ({
    ([ "file": "test.pike", "line": 15, "message": "Bad type in assignment." ]),
    ([ "file": "test.pike", "line": 15, "message": "Expected: int." ]),
    ([ "file": "test.pike", "line": 15, "message": "Got     : string." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  // Should have 1 diagnostic with expected_type and actual_type attached
  assert_equal(1, sizeof(result));
  assert_equal("int", result[0]["expected_type"]);
  assert_equal("string", result[0]["actual_type"]);
}

void test_normalize_type_mismatch_category() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Bad type in assignment to x." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal("type_mismatch", result[0]["category"]);
}

void test_normalize_wrong_return_type_category() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Wrong return type for foo." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal("wrong_return_type", result[0]["category"]);
}

void test_normalize_undefined_identifier_category() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Undefined identifier 'x'." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal("undefined_identifier", result[0]["category"]);
}

void test_normalize_wrong_arity_too_few() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Too few arguments to foo." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal("wrong_arity", result[0]["category"]);
}

void test_normalize_wrong_arity_too_many() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Too many arguments to foo." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal("wrong_arity", result[0]["category"]);
}

void test_normalize_syntax_error_category() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "syntax error at '}'." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal("syntax_error", result[0]["category"]);
}

void test_normalize_bad_argument_category() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Bad argument 2 to foo." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal("bad_argument", result[0]["category"]);
}

void test_normalize_unused_variable_category() {
  array warnings = ({
    ([ "file": "test.pike", "line": 10, "message": "Unused local variable x." ])
  });
  array result = get_common()->normalize_diagnostics(({}), warnings);
  assert_equal("unused_variable", result[0]["category"]);
}

void test_normalize_unknown_category() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Something unexpected." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal("unknown", result[0]["category"]);
}

void test_normalize_sorting_by_line_number() {
  array errors = ({
    ([ "file": "test.pike", "line": 30, "message": "Error at 30." ]),
    ([ "file": "test.pike", "line": 10, "message": "Error at 10." ]),
    ([ "file": "test.pike", "line": 20, "message": "Error at 20." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal(10, result[0]["line"]);
  assert_equal(20, result[1]["line"]);
  assert_equal(30, result[2]["line"]);
}

void test_normalize_multiple_on_same_line() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Error 1." ]),
    ([ "file": "test.pike", "line": 10, "message": "Error 2." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal(2, sizeof(result));
}

void test_normalize_strips_trailing_dot_from_expected() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Bad type in assignment." ]),
    ([ "file": "test.pike", "line": 10, "message": "Expected: int." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal("int", result[0]["expected_type"]);
}

void test_normalize_strips_trailing_dot_from_actual() {
  array errors = ({
    ([ "file": "test.pike", "line": 10, "message": "Bad type in assignment." ]),
    ([ "file": "test.pike", "line": 10, "message": "Got     : string." ])
  });
  array result = get_common()->normalize_diagnostics(errors, ({}));
  assert_equal("string", result[0]["actual_type"]);
}