// worker.pike — Long-lived Pike subprocess for the LSP server.
//
// Reads JSON requests from stdin (one per line), dispatches to handlers,
// writes JSON responses to stdout (one per line).
//
//   Request:  {"id": 1, "method": "diagnose", "params": {...}}
//   Response: {"id": 1, "result": {...}}
//   Error:    {"id": 1, "error": {"code": -1, "message": "..."}}
//
//   diagnose  — Compile a file and return diagnostics
//   typeof    — Evaluate typeof() on an expression
//   signature — Get function/method signature
//   ping      — Health check
//   autodoc   — Extract AutoDoc XML from Pike source
//   resolve   — Resolve a symbol to its kind, source location, and inheritance chain

// Import Common module for shared utilities
import Common;

// Create handler on demand for backwards compatibility
object make_handler() {
  return Common()->DiagnosticHandler();
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

  object handler = make_handler();
  program compiled_prog;
  mixed compile_err = catch {
    compiled_prog = compile_string(source, filepath, handler);
  };

  array diagnostics = Common()->normalize_diagnostics(handler->errors, handler->warnings);

  return ([ "diagnostics": diagnostics, "exit_code": compile_err ? 1 : 0 ]);
}

// ---------------------------------------------------------------------------
// Method: ping
// ---------------------------------------------------------------------------

mapping handle_ping(mapping params) {
  return ([ "status": "ok", "pike_version": Common()->get_pike_version() ]);
}

// ---------------------------------------------------------------------------
// Method: typeof
//
// Decision 0018: evaluates typeof(expr) safely by compiling the user's
// source into a program, then using Pike's reflection API to inspect the
// expression type.  The expression is interpolated into compiled code, so
// we validate it strictly: character whitelist, balanced parens, dangerous
// identifier rejection, and length limit.
// ---------------------------------------------------------------------------

mapping handle_typeof(mapping params) {
  string source = params["source"] || "";
  string expr = params["expression"] || "";

  if (!sizeof(source) || !sizeof(expr)) {
    return ([ "type": "mixed", "error": "Missing source or expression" ]);
  }

  // Length limit
  if (sizeof(expr) > 200) {
    return ([ "type": "mixed", "error": "Expression too long (max 200 chars)" ]);
  }

  // Reject statement separators (prevents trivial multi-statement injection)
  if (search(expr, ";") != -1 ||
      search(expr, "\n") != -1 ||
      search(expr, "\r") != -1) {
    return ([ "type": "mixed", "error": "Expression contains invalid characters" ]);
  }

  // Character whitelist: only allow safe expression characters
  // Allowed: a-z A-Z 0-9 _ . -> :: ( ) [ ] { } , space + - * / % & | ^ ~ ! < > = ?
  for (int i = 0; i < sizeof(expr); i++) {
    int c = expr[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '_' || c == '.' ||
          c == '-' || c == '>' || c == ':' || c == '(' || c == ')' ||
          c == '[' || c == ']' || c == '{' || c == '}' || c == ',' ||
          c == ' ' || c == '+' || c == '-' || c == '*' || c == '/' ||
          c == '%' || c == '&' || c == '|' || c == '^' || c == '~' ||
          c == '!' || c == '<' || c == '>' || c == '=' || c == '?')) {
      return ([ "type": "mixed", "error": sprintf("Expression contains disallowed character: %c", c) ]);
    }
  }

  // Balanced parentheses check
  int depth = 0;
  for (int i = 0; i < sizeof(expr); i++) {
    if (expr[i] == '(') depth++;
    else if (expr[i] == ')') {
      depth--;
      if (depth < 0) {
        return ([ "type": "mixed", "error": "Unbalanced parentheses in expression" ]);
      }
    }
  }
  if (depth != 0) {
    return ([ "type": "mixed", "error": "Unbalanced parentheses in expression" ]);
  }

  // Reject dangerous identifiers that could cause side effects during
  // compilation (e.g., exit, destruct, throw are compile-time evaluable)
  array(string) dangerous = ({
    "exit", "destruct", "throw", "catch", "gauge",
    "aggregate", "aggregate_list", "allocate", "mkmapping",
  });
  foreach(dangerous, string danger) {
    // Check for identifier boundary: the dangerous word must appear as
    // a standalone identifier followed by '('
    if (search(expr, danger + "(") != -1) {
      // Allow sizeof() — it's pure and safe for typeof queries
      if (danger == "sizeof") continue;
      return ([ "type": "mixed", "error": "Expression contains disallowed function: " + danger ]);
    }
  }

  // Compile a wrapper that evaluates typeof(expr) in the context of
  // the original source. typeof() is evaluated at compile time and
  // returns a type string — the expression can only produce a type,
  // not execute arbitrary runtime code beyond what the compiler
  // already does during compilation.
  //
  // Security relies on the character whitelist and dangerous-identifier
  // checks above, not on typeof() itself being safe.
  string typeof_wrapper =
    "#pragma strict_types\n"
    + source + "\n"
    + "mixed _typeof_get() { return typeof(" + expr + "); }\n";

  object handler = make_handler();
  program prog;
  mixed err = catch {
    prog = compile_string(typeof_wrapper, "<typeof-query>", handler);
  };

  if (err || !prog) {
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
// Method: resolve
// ---------------------------------------------------------------------------

mapping handle_resolve(mapping params) {
  string symbol = params["symbol"] || "";
  if (!sizeof(symbol))
    return ([ "resolved": Val.false, "error": "Missing symbol name" ]);

  mixed err = catch {
    import Introspect;
    mapping info = Introspect.Discover.resolve_symbol(symbol);
    if (!info)
      return ([ "resolved": Val.false, "symbol": symbol ]);

    // Strip program object — not JSON-serializable
    m_delete(info, "program");

    // If it's a class, also get inheritance info
    if (info["kind"] == "class") {
      program p = Introspect.Discover.resolve_program(symbol);
      if (p) {
        mapping desc = Introspect.Describe.describe_program(p);
        if (desc["methods"])
          info["methods"] = desc["methods"];
        if (desc["constants"])
          info["constants"] = desc["constants"];
        if (sizeof(desc["inherits"] || ({})))
          info["inherits"] = desc["inherits"];
        if (sizeof(desc["inherited_methods"] || ({})))
          info["inherited_methods"] = desc["inherited_methods"];
        if (sizeof(desc["inherited_constants"] || ({})))
          info["inherited_constants"] = desc["inherited_constants"];
      }
    }

    return ([ "resolved": Val.true ]) + info;
  };

  if (err)
    return ([ "resolved": Val.false, "error": sprintf("resolve failed: %O", err) ]);
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

// ---------------------------------------------------------------------------
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
      } else if (method == "resolve") {
        mapping result = handle_resolve(params);
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