//! TestBootstrap.pmod — Shared test helpers for PUnit-based Pike tests
//!
//! Provides common utilities for testing LSP components in isolation:
//! - Creating mock compilation handlers
//! - Building diagnostic fixtures
//! - String/mapping comparison helpers
//!
//! Usage: import TestBootstrap; from any test file in tests/pike/

import PUnit;

//! Create a fresh DiagnosticHandler for capturing compiler output.
//! Wraps the Common.DiagnosticHandler from the harness module.
object create_diagnostic_handler() {
  return Common.DiagnosticHandler();
}

//! Build a single error diagnostic mapping.
//! @param file    Source file path
//! @param line    Line number
//! @param msg     Error message
//! @returns A diagnostic mapping with severity "error"
mapping make_error_diagnostic(string file, int line, string msg) {
  return ([
    "file": file,
    "line": line,
    "message": msg,
  ]);
}

//! Build a single warning diagnostic mapping.
//! @param file    Source file path
//! @param line    Line number
//! @param msg     Warning message
//! @returns A diagnostic mapping with severity "warning"
mapping make_warning_diagnostic(string file, int line, string msg) {
  return ([
    "file": file,
    "line": line,
    "message": msg,
  ]);
}

//! Assert that a result array contains a diagnostic with the given severity and line.
//! @param result      Normalized diagnostics array
//! @param severity    Expected severity ("error" or "warning")
//! @param line        Expected line number
//! @param category    Optional expected category string
void assert_has_diagnostic(array result, string severity, int line,
                           void|string category) {
  int found = 0;
  foreach (result, mapping d) {
    if (d["severity"] == severity && d["line"] == line) {
      found = 1;
      if (category && d["category"] != category) {
        assert_fail("Found diagnostic at line %d with severity %s, "
                    "but category was '%s' (expected '%s')\n",
                    line, severity, d["category"], category);
      }
      break;
    }
  }
  if (!found) {
    assert_fail("No diagnostic found with severity '%s' at line %d\n",
                severity, line);
  }
}

//! Fail the current test with a formatted message.
//! Delegates to PUnit's assert_fail.
void assert_fail(string fmt, mixed ... args) {
  PUnit.Assertions.assert_fail(sprintf(fmt, @args));
}
