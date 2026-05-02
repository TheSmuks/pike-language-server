// introspect.pike — Pike introspection script for the language server harness
//
// Compiles a Pike source file using compile_string with a custom
// CompilationHandler, extracts AutoDoc (best-effort), normalizes
// diagnostics, and emits a single JSON object to stdout.
//
// Usage: pike introspect.pike [--strict] [--module-path <path>] [--include-path <path>] <file>

// Import Common module for shared utilities
import Common;

// Backwards-compatible alias - create handler on demand
object make_handler() {
  return Common()->DiagnosticHandler();
}

int main(int argc, array(string) argv) {
  string filepath;
  int strict = 0;
  string pike_binary = "pike";
  array(string) module_paths = ({});
  array(string) include_paths = ({});

  // Parse arguments
  int i = 1;
  while (i < sizeof(argv)) {
    if (argv[i] == "--strict") {
      strict = 1;
      i++;
    } else if (argv[i] == "--pike-binary" && i + 1 < sizeof(argv)) {
      pike_binary = argv[i + 1];
      i += 2;
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
      "pike_version": Common()->get_pike_version(),
      "compilation": ([ "exit_code": 1, "strict_types": strict ? Val.true : Val.false ]),
      "diagnostics": ({}),
      "autodoc": Val.null,
      "symbols": ({}),
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
      "pike_version": Common()->get_pike_version(),
      "compilation": ([ "exit_code": 1, "strict_types": strict ? Val.true : Val.false ]),
      "diagnostics": ({}),
      "autodoc": Val.null,
      "symbols": ({}),
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
  object handler = make_handler();

  // Compile
  int exit_code = 0;
  program compiled_prog;
  mixed compile_err = catch {
    compiled_prog = compile_string(source, filepath, handler);
  };
  if (compile_err) {
    exit_code = 1;
  }

  // Extract AutoDoc (best-effort via pike -x extract_autodoc)
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
    Process.run(({pike_binary, "-x", "extract_autodoc", rel}));
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
  array diagnostics = Common()->normalize_diagnostics(handler->errors, handler->warnings);

  // Extract symbols from compiled program
  array symbols = ({});
  mixed sym_err = catch {
    if (compiled_prog) {
      object instance = compiled_prog();
      array(string) names = sort(indices(instance));
      array(mapping) tmp = ({});

      foreach(names, string name) {
        // Access value via indexing operator (not values()) for correct type predicates
        mixed val = instance[name];

        // Get definition location via Program.defined(program, name)
        string def_loc;
        mixed loc_err = catch {
          def_loc = Program.defined(compiled_prog, name);
        };

        // Skip symbols not defined in this file (inherited/implicit)
        if (!def_loc || !has_prefix(def_loc, filepath)) continue;

        // Skip underscore-prefixed names
        if (has_prefix(name, "_")) continue;

        mapping sym = ([ "name": name ]);

        // Extract line number from location string
        string loc_file;
        int loc_line;
        if (sscanf(def_loc, "%s:%d", loc_file, loc_line) == 2) {
          sym["line"] = loc_line;
        }

        // Classify symbol kind using type predicates on indexed value
        if (programp(val)) {
          // A program value defined in this file with a line -> class
          if (sym->line) {
            sym["kind"] = "class";
            // Extract class body members
            mixed member_err = catch {
              object class_inst = val();
              array(string) member_names = sort(indices(class_inst));
              array(mapping) members = ({});
              foreach(member_names, string mname) {
                // Skip underscore-prefixed and auto-generated names
                if (has_prefix(mname, "_")) continue;
                mixed mval = class_inst[mname];
                mapping msym = ([ "name": mname ]);
                if (programp(mval)) {
                  msym["kind"] = "class";
                } else if (functionp(mval)) {
                  msym["kind"] = "function";
                } else {
                  msym["kind"] = "variable";
                }
                members += ({ msym });
              }
              if (sizeof(members) > 0) {
                sym["members"] = members;
              }
            };
          } else {
            sym["kind"] = "variable";
          }
        } else if (functionp(val)) {
          sym["kind"] = "function";
        } else if (intp(val) || stringp(val) || floatp(val) ||
                   arrayp(val) || mappingp(val) || multisetp(val)) {
          sym["kind"] = "variable";
        } else if (objectp(val)) {
          sym["kind"] = "variable";
        } else {
          sym["kind"] = "unknown";
        }

        tmp += ({ sym });
      }

      // Sort by line number (symbols without line go first), then by name
      sort(tmp->name, tmp);  // pre-sort by name for stable secondary sort
      array line_keys = allocate(sizeof(tmp));
      for (int k = 0; k < sizeof(tmp); k++) {
        line_keys[k] = zero_type(tmp[k]->line) ? 0 : tmp[k]->line;
      }
      sort(line_keys, tmp);
      symbols = tmp;
    }
  };
  if (sym_err) {
    // Symbol extraction failed — leave symbols empty
    symbols = ({});
  }
  mapping result = ([
    "file": filepath,
    "pike_version": Common()->get_pike_version(),
    "compilation": ([ "exit_code": exit_code, "strict_types": strict ? Val.true : Val.false ]),
    "diagnostics": diagnostics,
    "autodoc": autodoc,
    "symbols": symbols,
    "error": Val.null
  ]);

  write("%s\n", Standards.JSON.encode(result));
  return 0;
}