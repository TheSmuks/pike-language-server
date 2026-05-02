//! CompilationHandlerTests.pike — Unit tests for DiagnosticHandler class

import PUnit;
import PUnit.TestRunner;

// Import Common module
import Common;

inherit PUnit.TestCase;

// Helper to create a fresh handler for each test
object create_handler() {
  return DiagnosticHandler();
}

void test_handler_initializes_with_empty_errors() {
  object handler = create_handler();
  assert_equal(0, sizeof(handler->errors));
}

void test_handler_initializes_with_empty_warnings() {
  object handler = create_handler();
  assert_equal(0, sizeof(handler->warnings));
}

void test_handler_compile_error_records_error() {
  object handler = create_handler();
  handler->compile_error("test.pike", 10, "Test error message.");
  assert_equal(1, sizeof(handler->errors));
  assert_equal("test.pike", handler->errors[0]["file"]);
  assert_equal(10, handler->errors[0]["line"]);
  assert_equal("Test error message.", handler->errors[0]["message"]);
}

void test_handler_compile_warning_records_warning() {
  object handler = create_handler();
  handler->compile_warning("test.pike", 20, "Test warning message.");
  assert_equal(1, sizeof(handler->warnings));
  assert_equal("test.pike", handler->warnings[0]["file"]);
  assert_equal(20, handler->warnings[0]["line"]);
  assert_equal("Test warning message.", handler->warnings[0]["message"]);
}

void test_handler_multiple_errors_accumulate() {
  object handler = create_handler();
  handler->compile_error("test.pike", 10, "Error 1.");
  handler->compile_error("test.pike", 20, "Error 2.");
  handler->compile_error("test.pike", 30, "Error 3.");
  assert_equal(3, sizeof(handler->errors));
}

void test_handler_multiple_warnings_accumulate() {
  object handler = create_handler();
  handler->compile_warning("test.pike", 5, "Warning 1.");
  handler->compile_warning("test.pike", 15, "Warning 2.");
  assert_equal(2, sizeof(handler->warnings));
}

void test_handler_errors_and_warnings_are_independent() {
  object handler = create_handler();
  handler->compile_error("test.pike", 10, "Error message.");
  handler->compile_warning("test.pike", 5, "Warning message.");
  assert_equal(1, sizeof(handler->errors));
  assert_equal(1, sizeof(handler->warnings));
}

void test_handler_error_contains_all_fields() {
  object handler = create_handler();
  handler->compile_error("myfile.pike", 42, "Type mismatch error.");
  mapping error = handler->errors[0];
  assert_true(error->file != Val.null);
  assert_true(error->line != Val.null);
  assert_true(error->message != Val.null);
}

void test_handler_warning_contains_all_fields() {
  object handler = create_handler();
  handler->compile_warning("myfile.pike", 15, "Unused variable.");
  mapping warning = handler->warnings[0];
  assert_true(warning->file != Val.null);
  assert_true(warning->line != Val.null);
  assert_true(warning->message != Val.null);
}

void test_handler_zero_line_is_valid() {
  object handler = create_handler();
  handler->compile_error("test.pike", 0, "Error at line 0.");
  assert_equal(0, handler->errors[0]["line"]);
}

void test_handler_high_line_numbers_are_valid() {
  object handler = create_handler();
  handler->compile_error("test.pike", 10000, "Error at high line.");
  assert_equal(10000, handler->errors[0]["line"]);
}

void test_handler_special_characters_in_message() {
  object handler = create_handler();
  handler->compile_error("test.pike", 10, "Error with 'quotes' and \"double quotes\".");
  assert_true(has_value(handler->errors[0]["message"], "'"));
  assert_true(has_value(handler->errors[0]["message"], "\""));
}

void test_handler_empty_message_is_valid() {
  object handler = create_handler();
  handler->compile_error("test.pike", 10, "");
  assert_equal("", handler->errors[0]["message"]);
}