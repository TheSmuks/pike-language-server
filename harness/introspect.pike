// Get the full Pike version string (e.g. "8.0.1116")
string get_pike_version() {
  string v = version();
  string major, release;
  sscanf(v, "Pike v%s release %s", major, release);
  return major + "." + release;
}

// introspect.pike — Pike introspection script for the language server harness
//
// Compiles a Pike source file using compile_string with a custom
// CompilationHandler, extracts AutoDoc (best-effort), normalizes
// diagnostics, and emits a single JSON object to stdout.
//
// Usage: pike introspect.pike [--strict] [--module-path <path>] [--include-path <path>] <file>

int main(int argc, array(string) argv) {
  string filepath;
  int strict = 0;
  array(string) module_paths = ({});
  array(string) include_paths = ({});

  // Parse arguments
  int i = 1;
  while (i < sizeof(argv)) {
    if (argv[i] == "--strict") {
      strict = 1;
      i++;
    } else if (argv[i] == "--module-path" && i + 1 < sizeof(argv)) {
      module_paths += ({ argv[i + 1] });
      i += 2;
    } else if (argv[i] == "--include-path" && i + 1 < sizeof(argv)) {
      include_paths += ({ argv[i + 1] });
      i += 2;
    } else {
      filepath = argv[i];
      i++;
    }
  }

  if (!filepath || !sizeof(filepath)) {
    mapping result = ([
      "file": "",
      "pike_version": get_pike_version(),
      "compilation": ([ "exit_code": 1, "strict_types": strict ? Val.true : Val.false ]),
      "diagnostics": ({}),
      "autodoc": Val.null,
      "error": "No file path provided"
    ]);
    write("%s\n", Standards.JSON.encode(result));
    return 0;
  }

  // Read the source file
  string source;
  mixed read_err = catch {
    source = Stdio.read_file(filepath);
  };
  if (read_err || !source) {
    mapping result = ([
      "file": filepath,
      "pike_version": get_pike_version(),
      "compilation": ([ "exit_code": 1, "strict_types": strict ? Val.true : Val.false ]),
      "diagnostics": ({}),
      "autodoc": Val.null,
      "error": sprintf("Could not read file: %O", filepath)
    ]);
    write("%s\n", Standards.JSON.encode(result));
    return 0;
  }

  // Add -M and -I paths
  foreach (module_paths, string mp) {
    add_module_path(mp);
  }
  foreach (include_paths, string ip) {
    add_include_path(ip);
  }

  // Prepend strict_types pragma if requested
  if (strict && !has_prefix(source, "#pragma strict_types")) {
    source = "#pragma strict_types\n" + source;
  }

  // Create compilation handler
  object handler = CompilationHandler();

  // Compile
  int exit_code = 0;
  mixed compile_err = catch {
    program p = compile_string(source, filepath, handler);
  };
  if (compile_err) {
    exit_code = 1;
  }

  // Extract AutoDoc (best-effort via pike -x extract_autodoc)
  // extract_autodoc prepends ./ to its output path, so we must
  // pass a relative path and construct xml_path accordingly.
  mixed autodoc = Val.null;
  mixed ad_err = catch {
    string rel = filepath;
    string cwd = getcwd();
    if (has_prefix(filepath, cwd + "/")) {
      rel = filepath[sizeof(cwd) + 1..];
    }
    string xml_path = "./" + rel + ".xml";
    string stamp_path = "./" + rel + ".xml.stamp";
    // Clean up any stale artifacts
    rm(xml_path);
    rm(stamp_path);
    Process.run(({"pike", "-x", "extract_autodoc", rel}));
    if (file_stat(xml_path)) {
      string raw = Stdio.read_file(xml_path);
      if (raw && sizeof(String.trim_all_whites(raw)) > 0) {
        autodoc = raw;
      }
      rm(xml_path);
      rm(stamp_path);
    }
  };

  // Build diagnostics
  array diagnostics = normalize_diagnostics(handler->errors, handler->warnings);

  mapping result = ([
    "file": filepath,
    "pike_version": get_pike_version(),
    "compilation": ([ "exit_code": exit_code, "strict_types": strict ? Val.true : Val.false ]),
    "diagnostics": diagnostics,
    "autodoc": autodoc,
    "error": Val.null
  ]);

  write("%s\n", Standards.JSON.encode(result));
  return 0;
}

// Compilation handler class
class CompilationHandler {
  array errors = ({});
  array warnings = ({});

  void compile_error(string file, int line, string msg) {
    errors += ({ ([ "file": file, "line": line, "message": msg ]) });
  }

  void compile_warning(string file, int line, string msg) {
    warnings += ({ ([ "file": file, "line": line, "message": msg ]) });
  }
}

// Normalize raw diagnostics into structured form
array(mapping) normalize_diagnostics(array raw_errors, array raw_warnings) {
  // Combine all diagnostics, tracking severity
  array(mapping) all = ({});

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

  // Sort by line number for consistent ordering
  // Sort by line number for consistent ordering
  sort(all->line, all);

  // Post-process: extract expected/actual types and categories
  array(mapping) result = ({});
  int j = 0;

  while (j < sizeof(all)) {
    mapping d = all[j];
    string msg = d["message"];

    // Check if this is a continuation line (Expected:/Got:)
    // These should be attached to the previous diagnostic, not standalone
    if (has_prefix(msg, "Expected: ") && sizeof(result) > 0) {
      // Attach to previous diagnostic
      string expected = msg[10..]; // strip "Expected: "
      if (sizeof(expected) > 0 && expected[-1] == '.')
        expected = expected[..sizeof(expected)-2];
      result[-1]["expected_type"] = expected;
      j++;
      continue;
    }

    if (has_prefix(msg, "Got     : ") && sizeof(result) > 0) {
      // Attach to previous diagnostic
      string actual = msg[10..]; // strip "Got     : "
      if (sizeof(actual) > 0 && actual[-1] == '.')
        actual = actual[..sizeof(actual)-2];
      result[-1]["actual_type"] = actual;
      j++;
      continue;
    }

    // Determine category from message
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

    // Look ahead for Expected:/Got: lines on the same line number
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
        // Skip secondary info line for arity errors
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