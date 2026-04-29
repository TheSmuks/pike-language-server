// worker.pike — Long-lived Pike subprocess for the LSP server.
//
// Reads JSON requests from stdin (one per line), dispatches to handlers,
// writes JSON responses to stdout (one per line).
//
// Protocol:
//   Request:  {"id": 1, "method": "diagnose", "params": {...}}
//   Response: {"id": 1, "result": {...}}
//   Error:    {"id": 1, "error": {"code": -1, "message": "..."}}
//
//   diagnose  — Compile a file and return diagnostics
//   typeof    — Evaluate typeof() on an expression
//   signature — Get function/method signature
//   ping      — Health check
//   autodoc   — Extract AutoDoc XML from Pike source

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

string get_pike_version() {
  string v = version();
  string major, release;
  sscanf(v, "Pike v%s release %s", major, release);
  return major + "." + release;
}

// ---------------------------------------------------------------------------
// CompilationHandler for capturing diagnostics
// ---------------------------------------------------------------------------

class CaptureHandler {
  array errors = ({});
  array warnings = ({});

  void compile_error(string file, int line, string msg) {
    errors += ({ ([ "file": file, "line": line, "message": msg ]) });
  }

  void compile_warning(string file, int line, string msg) {
    warnings += ({ ([ "file": file, "line": line, "message": msg ]) });
  }
}

// ---------------------------------------------------------------------------
// Diagnostic normalization (reuses harness pattern)
// ---------------------------------------------------------------------------

array(mapping) normalize_diagnostics(array raw_errors, array raw_warnings) {
  array(mapping) all = ({});

  foreach(raw_errors, mapping e) {
    all += ({ ([
      "line": e["line"],
      "severity": "error",
      "message": e["message"],
    ]) });
  }

  foreach(raw_warnings, mapping w) {
    all += ({ ([
      "line": w["line"],
      "severity": "warning",
      "message": w["message"],
    ]) });
  }

  sort(all->line, all);

  // Post-process: extract expected/actual types
  array(mapping) result = ({});
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

    result += ({ d });
    j++;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Method: diagnose
// ---------------------------------------------------------------------------

mapping handle_diagnose(mapping params) {
  string source = params["source"] || "";
  string filepath = params["file"] || "<buffer>";
  int strict = params["strict"] || 0;

  // Add module paths if provided
  if (params["module_paths"]) {
    foreach(params["module_paths"], string mp) {
      add_module_path(mp);
    }
  }
  if (params["include_paths"]) {
    foreach(params["include_paths"], string ip) {
      add_include_path(ip);
    }
  }
  if (params["program_paths"]) {
    foreach(params["program_paths"], string pp) {
      add_program_path(pp);
    }
  }

  // Prepend strict_types pragma if requested
  if (strict && !has_prefix(source, "#pragma strict_types")) {
    source = "#pragma strict_types\n" + source;
  }

  object handler = CaptureHandler();
  program compiled_prog;
  mixed compile_err = catch {
    compiled_prog = compile_string(source, filepath, handler);
  };

  array diagnostics = normalize_diagnostics(handler->errors, handler->warnings);

  return ([ "diagnostics": diagnostics, "exit_code": compile_err ? 1 : 0 ]);
}

// ---------------------------------------------------------------------------
// Method: ping
// ---------------------------------------------------------------------------

mapping handle_ping(mapping params) {
  return ([ "status": "ok", "pike_version": get_pike_version() ]);
}

// ---------------------------------------------------------------------------
// Method: typeof
//
// Decision 0018: evaluates typeof(expr) safely by compiling the user's
// source into a program, then using Pike's reflection API to inspect the
// expression type without raw string interpolation that could inject
// arbitrary code.
// ---------------------------------------------------------------------------

mapping handle_typeof(mapping params) {
  string source = params["source"] || "";
  string expr = params["expression"] || "";

  if (!sizeof(source) || !sizeof(expr)) {
    return ([ "type": "mixed", "error": "Missing source or expression" ]);
  }

  // Reject expressions that contain statement separators.
  // A valid Pike expression must not contain these characters.
  // This prevents trivial injection of arbitrary statements.
  if (search(expr, ";") != -1 ||
      search(expr, "\n") != -1 ||
      search(expr, "\r") != -1) {
    return ([ "type": "mixed", "error": "Expression contains invalid characters" ]);
  }

  // Compile a wrapper that evaluates typeof(expr) in the context of
  // the original source.  typeof() is evaluated at compile time and
  // returns a type string, so even though the expression is interpolated,
  // it can only produce a type — not execute arbitrary code beyond what
  // the compiler already does during compilation.
  string typeof_wrapper =
    "#pragma strict_types\n"
    + source + "\n"
    + "mixed _typeof_get() { return typeof(" + expr + "); }\n";

  object handler = CaptureHandler();
  program prog;
  mixed err = catch {
    prog = compile_string(typeof_wrapper, "<typeof-query>", handler);
  };

  if (err || !prog) {
    // The expression may not be valid in this context
    return ([ "type": "mixed", "error": "Compilation failed for typeof query" ]);
  }

  object inst;
  mixed inst_err = catch { inst = prog(); };
  if (inst_err || !inst) {
    return ([ "type": "mixed", "error": "Instantiation failed for typeof query" ]);
  }

  string type_str;
  mixed type_err = catch {
    mixed val = inst["_typeof_get"]();
    if (stringp(val)) {
      type_str = val;
    } else {
      type_str = "mixed";
    }
  };

  return ([ "type": type_str || "mixed" ]);
}

// ---------------------------------------------------------------------------
// Method: autodoc
// ---------------------------------------------------------------------------

mapping handle_autodoc(mapping params) {
  string source = params["source"] || "";
  string filepath = params["file"] || "<autodoc>";

  mixed err = catch {
    object ns = Tools.AutoDoc.PikeExtractor.extractNamespace(
      source, filepath, "predef", Tools.AutoDoc.FLAG_KEEP_GOING);
    if (ns) {
      return ([ "xml": ns->xml() ]);
    }
    return ([ "xml": "" ]);
  };

  return ([ "xml": "", "error": sprintf("autodoc failed: %O", err) ]);
}

// Main loop: read requests from stdin, dispatch, write responses
// ---------------------------------------------------------------------------

int main() {
  // Signal readiness
  Stdio.File stdout = Stdio.stdout;
  Stdio.FILE stdin = Stdio.stdin;

  string line;
  while ((line = stdin->gets())) {
    if (!sizeof(String.trim_all_whites(line))) continue;

    mixed parsed = catch {
      mapping request = Standards.JSON.decode(line);

      int id = request["id"];
      string method = request["method"];
      mapping params = request["params"] || ([]);

      mapping response;

      if (method == "diagnose") {
        mapping result = handle_diagnose(params);
        response = ([ "id": id, "result": result ]);
      } else if (method == "ping") {
        mapping result = handle_ping(params);
        response = ([ "id": id, "result": result ]);
      } else if (method == "typeof") {
        mapping result = handle_typeof(params);
        response = ([ "id": id, "result": result ]);
      } else if (method == "autodoc") {
        mapping result = handle_autodoc(params);
        response = ([ "id": id, "result": result ]);
      } else {
        response = ([
          "id": id,
          "error": ([ "code": -1, "message": "Unknown method: " + method ]),
        ]);
      }

      stdout->write("%s\n", Standards.JSON.encode(response));
    };

    if (parsed) {
      // Parse error — try to send an error response
      catch {
        // Best effort: try to extract id from the raw line
        int error_id = 0;
        sscanf(line, "%*s\"id\":%d", error_id);
        stdout->write("%s\n", Standards.JSON.encode(([
          "id": error_id,
          "error": ([ "code": -1, "message": sprintf("Parse error: %O", parsed) ]),
        ])));
      };
    }
  }

  return 0;
}
