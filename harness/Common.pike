//! Common.pike — Shared Pike utilities for the LSP harness

//! Get the Pike version in "X.Y.ZZZZ" format
string get_pike_version() {
  string v = version();
  string major, release;
  sscanf(v, "Pike v%s release %s", major, release);
  return major + "." + release;
}

//! CompilationHandler for capturing Pike compiler diagnostics
class DiagnosticHandler {
  array errors = ({});
  array warnings = ({});

  void compile_error(string file, int line, string msg) {
    errors += ({ ([ "file": file, "line": line, "message": msg ]) });
  }

  void compile_warning(string file, int line, string msg) {
    warnings += ({ ([ "file": file, "line": line, "message": msg ]) });
  }
}

//! Normalize raw diagnostics with category classification
array normalize_diagnostics(array raw_errors, array raw_warnings) {
  array all = ({});

  foreach (raw_errors, mapping e) {
    all += ({ ([
      "line": e["line"],
      "severity": "error",
      "message": e["message"]
    ]) });
  }

  foreach (raw_warnings, mapping w) {
    all += ({ ([
      "line": w["line"],
      "severity": "warning",
      "message": w["message"]
    ]) });
  }

  sort(all->line, all);

  array result = ({});
  int j = 0;

  while (j < sizeof(all)) {
    mapping d = all[j];
    string msg = d["message"];

    if (has_prefix(msg, "Expected: ") && sizeof(result) > 0) {
      string expected = msg[10..];
      if (sizeof(expected) > 0 && expected[-1] == '.')
        expected = expected[..sizeof(expected)-2];
      result[-1]["expected_type"] = expected;
      j++;
      continue;
    }

    if (has_prefix(msg, "Got     : ") && sizeof(result) > 0) {
      string actual = msg[10..];
      if (sizeof(actual) > 0 && actual[-1] == '.')
        actual = actual[..sizeof(actual)-2];
      result[-1]["actual_type"] = actual;
      j++;
      continue;
    }

    string category = "unknown";
    if (has_value(msg, "Bad type in assignment"))
      category = "type_mismatch";
    else if (has_value(msg, "Wrong return type"))
      category = "wrong_return_type";
    else if (has_value(msg, "Undefined identifier"))
      category = "undefined_identifier";
    else if (has_value(msg, "Too few arguments"))
      category = "wrong_arity";
    else if (has_value(msg, "Too many arguments"))
      category = "wrong_arity";
    else if (has_value(msg, "syntax error"))
      category = "syntax_error";
    else if (has_value(msg, "Bad argument"))
      category = "bad_argument";
    else if (has_value(msg, "Unused local variable"))
      category = "unused_variable";

    d["category"] = category;

    int k = j + 1;
    while (k < sizeof(all) && all[k]["line"] == d["line"]) {
      string next_msg = all[k]["message"];
      if (has_prefix(next_msg, "Expected: ")) {
        string expected = next_msg[10..];
        if (sizeof(expected) > 0 && expected[-1] == '.')
          expected = expected[..sizeof(expected)-2];
        d["expected_type"] = expected;
        k++;
      } else if (has_prefix(next_msg, "Got     : ")) {
        string actual = next_msg[10..];
        if (sizeof(actual) > 0 && actual[-1] == '.')
          actual = actual[..sizeof(actual)-2];
        d["actual_type"] = actual;
        k++;
      } else if (has_value(next_msg, "Function type:")) {
        k++;
      } else {
        break;
      }
    }

    result += ({ d });
    j = k;
  }

  return result;
}