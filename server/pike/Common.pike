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

//! Base name of a path, so a reported origin is machine-independent.
protected string base_name(string path) {
  if (!path) return 0;
  array parts = path / "/";
  return sizeof(parts) ? parts[-1] : path;
}

//! Origin filename, but ONLY when it differs from the file being compiled.
//!
//! A diagnostic raised inside an #include'd file carries THAT file's line
//! number. Dropping the filename left the server to publish it at that line of
//! the open document — unrelated code, or past the end of the file entirely.
//! Local diagnostics carry no "file" key at all, which keeps the common case
//! (and its golden snapshots) free of absolute, machine-specific paths.
protected string foreign_origin(mixed raw, string compiled_file) {
  string origin = base_name(raw["file"]);
  if (!origin || !compiled_file) return 0;
  return origin == base_name(compiled_file) ? 0 : origin;
}

//! Normalize raw diagnostics with category classification
array normalize_diagnostics(array raw_errors, array raw_warnings,
                            string|void compiled_file) {
  array all = ({});

  foreach (raw_errors, mapping e) {
    mapping d = ([
      "line": e["line"],
      "severity": "error",
      "message": e["message"]
    ]);
    string origin = foreign_origin(e, compiled_file);
    if (origin) d["file"] = origin;
    all += ({ d });
  }

  foreach (raw_warnings, mapping w) {
    mapping d = ([
      "line": w["line"],
      "severity": "warning",
      "message": w["message"]
    ]);
    string origin = foreign_origin(w, compiled_file);
    if (origin) d["file"] = origin;
    all += ({ d });
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
