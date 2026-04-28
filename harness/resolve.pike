// resolve.pike — Cross-file resolution introspection for the Pike LSP harness.
//
// For each cross-file reference (inherit/import) in a source file, reports what
// Pike resolves it to: the target file path and available symbols.
//
// Usage:
//   pike resolve.pike [--module-path <path>] <file>
//
// Output: JSON to stdout.

string get_pike_version() {
  string v = version();
  string major, release;
  sscanf(v, "Pike v%s release %s", major, release);
  return major + "." + release;
}

string classify_kind(mixed val) {
  if (programp(val)) return "class";
  if (functionp(val)) return "function";
  return "variable";
}

// Resolve the definition location (file:line) for a symbol value.
// Returns a mapping with "file" and optionally "line".
mapping resolve_def_loc(mixed val, mixed containing_prog, string name) {
  string sym_file;
  int sym_line;

  if (programp(val)) {
    // Class — its program's definition
    string def = Program.defined(val);
    if (def) {
      string f; int l;
      if (sscanf(def, "%s:%d", f, l) == 2) { sym_file = f; sym_line = l; }
      else { sym_file = def; }
    }
  } else if (functionp(val)) {
    // Function — function_program's definition
    mixed fp = function_program(val);
    if (programp(fp)) {
      // Try Program.defined(fp, name) first for line-level precision
      mixed err = catch {
        string def2 = Program.defined(fp, name);
        if (def2) {
          string f2; int l2;
          if (sscanf(def2, "%s:%d", f2, l2) == 2) { sym_file = f2; sym_line = l2; }
          else { sym_file = def2; }
        }
      };
      if (!sym_file) {
        string def = Program.defined(fp);
        if (def) { sym_file = def; }
      }
    }
  } else {
    // Variable — need the actual module program, not the joinnode
    // Find a function in the same module to get the real program
    mixed real_prog = containing_prog;
    if (programp(real_prog)) {
      mixed err = catch {
        string def = Program.defined(real_prog, name);
        if (def) {
          string f; int l;
          if (sscanf(def, "%s:%d", f, l) == 2) { sym_file = f; sym_line = l; }
          else { sym_file = def; }
        }
      };
    }
  }

  mapping m = ([]);
  if (sym_file) m["file"] = sym_file;
  if (sym_line) m["line"] = sym_line;
  return m;
}

// Extract symbols from a module object or program.
array(mapping) extract_symbols(mixed prog_or_obj) {
  array(mapping) result = ({});

  object obj;
  mixed prog;

  if (programp(prog_or_obj)) {
    prog = prog_or_obj;
    mixed err = catch { obj = prog_or_obj(); };
    if (err || !obj) return result;
  } else if (objectp(prog_or_obj)) {
    obj = prog_or_obj;
    prog = object_program(obj);
  } else {
    return result;
  }

  // For joinnode modules, find the actual module program via a function
  mixed module_prog = prog;
  mixed err = catch {
    foreach(indices(obj), string n) {
      mixed v = obj[n];
      if (functionp(v)) {
        mixed fp = function_program(v);
        if (programp(fp)) { module_prog = fp; break; }
      }
    }
  };

  array(string) names = sort(indices(obj));
  foreach(names, string name) {
    if (has_prefix(name, "_")) continue;

    mixed val = obj[name];
    string kind = classify_kind(val);

    mapping loc = resolve_def_loc(val, module_prog, name);

    mapping sym = ([ "name": name, "kind": kind ]);
    if (loc["file"]) sym["defined_file"] = loc["file"];
    if (loc["line"]) sym["line"] = loc["line"];

    // For classes, extract members
    if (kind == "class" && programp(val)) {
      mixed member_err = catch {
        object class_inst = val();
        array(string) member_names = sort(indices(class_inst));
        array(mapping) members = ({});
        foreach(member_names, string mname) {
          if (has_prefix(mname, "_")) continue;
          mixed mval = class_inst[mname];
          members += ({ ([ "name": mname, "kind": classify_kind(mval) ]) });
        }
        if (sizeof(members) > 0) {
          sym["members"] = members;
        }
      };
    }

    result += ({ sym });
  }

  return result;
}

// Parse inherit/import references from source text.
array(mapping) parse_references(string source) {
  array(mapping) refs = ({});
  array(string) lines = source / "\n";

  for (int i = 0; i < sizeof(lines); i++) {
    string trimmed = String.trim_all_whites(lines[i]);
    int lineno = i + 1;

    string path, alias, ident;

    // inherit "path" [: alias];
    if (sscanf(trimmed, "inherit \"%s\" : %s;", path, alias) == 2) {
      refs += ({ ([
        "kind": "inherit", "reference": path,
        "is_string_path": Val.true,
        "alias": String.trim_all_whites(alias), "line": lineno,
      ]) });
    } else if (sscanf(trimmed, "inherit \"%s\";", path) == 1) {
      refs += ({ ([
        "kind": "inherit", "reference": path,
        "is_string_path": Val.true,
        "alias": Val.null, "line": lineno,
      ]) });
    } else if (sscanf(trimmed, "inherit %s : %s;", ident, alias) == 2) {
      ident = String.trim_all_whites(ident);
      if (sizeof(ident) > 0 && (ident[0] >= 'A' && ident[0] <= 'Z' || ident[0] >= 'a' && ident[0] <= 'z')) {
        refs += ({ ([
          "kind": "inherit", "reference": ident,
          "is_string_path": Val.false,
          "alias": String.trim_all_whites(alias), "line": lineno,
        ]) });
      }
    } else if (sscanf(trimmed, "inherit %s;", ident) == 1) {
      ident = String.trim_all_whites(ident);
      if (sizeof(ident) > 0 && (ident[0] >= 'A' && ident[0] <= 'Z' || ident[0] >= 'a' && ident[0] <= 'z')) {
        refs += ({ ([
          "kind": "inherit", "reference": ident,
          "is_string_path": Val.false,
          "alias": Val.null, "line": lineno,
        ]) });
      }
    }

    // import module_name;
    string mod_name;
    if (sscanf(trimmed, "import %s;", mod_name) == 1) {
      mod_name = String.trim_all_whites(mod_name);
      if (sizeof(mod_name) > 0 && mod_name[0] != '.') {
        refs += ({ ([ "kind": "import", "reference": mod_name, "line": lineno ]) });
      }
    }
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

int main(int argc, array(string) argv) {
  string filepath;
  array(string) module_paths = ({});

  int i = 1;
  while (i < sizeof(argv)) {
    if (argv[i] == "--module-path" && i + 1 < sizeof(argv)) {
      module_paths += ({ argv[i + 1] });
      i += 2;
    } else {
      filepath = argv[i];
      i++;
    }
  }

  if (!filepath || !sizeof(filepath)) {
    write("%s\n", Standards.JSON.encode(([
      "file": "", "pike_version": get_pike_version(),
      "resolutions": ({}), "error": "No file path provided"
    ])));
    return 0;
  }

  // Resolve to absolute path
  filepath = combine_path(getcwd(), filepath);

  // Add module and program paths
  foreach(module_paths, string mp) {
    string abs = combine_path(getcwd(), mp);
    add_module_path(abs);
    add_program_path(abs);
  }

  // Read source
  string source;
  mixed read_err = catch { source = Stdio.read_file(filepath); };
  if (read_err || !source) {
    write("%s\n", Standards.JSON.encode(([
      "file": filepath, "pike_version": get_pike_version(),
      "resolutions": ({}),
      "error": sprintf("Could not read file: %O", filepath),
    ])));
    return 0;
  }

  // Parse cross-file references from source
  array(mapping) refs = parse_references(source);
  string dirpath = dirname(filepath);
  array resolutions = ({});

  foreach(refs, mapping ref) {
    string reference = ref["reference"];
    string kind = ref["kind"];
    int is_string_path = zero_type(ref["is_string_path"]) ? 0 : (ref["is_string_path"] == Val.true);

    mapping resolution = ([
      "reference": reference, "kind": kind, "line": ref["line"],
    ]);

    if (kind == "inherit" && is_string_path) {
      resolution["alias"] = ref["alias"];
      mixed prog;
      mixed resolve_err = catch {
        prog = master()->cast_to_program(reference, dirpath);
      };
      if (programp(prog)) {
        resolution["target_file"] = Program.defined(prog);
        resolution["symbols"] = extract_symbols(prog);
      } else {
        resolution["target_file"] = Val.null;
        resolution["resolve_error"] = "NOT FOUND";
      }
    } else if (kind == "inherit" && !is_string_path) {
      resolution["alias"] = ref["alias"];
      mixed mod = master()->resolv(reference);
      if (objectp(mod)) {
        mixed prog = object_program(mod);
        resolution["target_file"] = Program.defined(prog);
        resolution["symbols"] = extract_symbols(mod);
      } else if (programp(mod)) {
        resolution["target_file"] = Program.defined(mod);
        resolution["symbols"] = extract_symbols(mod);
      } else {
        resolution["target_file"] = Val.null;
        resolution["resolve_error"] = "NOT FOUND";
      }
    } else if (kind == "import") {
      mixed mod = master()->resolv(reference);
      if (objectp(mod)) {
        mixed prog = object_program(mod);
        string prog_def = Program.defined(prog);
        // For directory modules (joinnode), Program.defined returns master.pike.
        // Find the actual module directory on disk.
        if (prog_def && has_prefix(prog_def, "/usr/local/pike")) {
          string found_path;
          foreach(master()->pike_module_path, string mp) {
            string dir_path = combine_path(mp, reference + ".pmod");
            if (file_stat(dir_path) && file_stat(dir_path)->isdir) {
              found_path = dir_path;
              break;
            }
          }
          resolution["target_file"] = found_path || prog_def;
        } else {
          resolution["target_file"] = prog_def;
        }
        resolution["symbols"] = extract_symbols(mod);
      } else {
        resolution["target_file"] = Val.null;
        resolution["resolve_error"] = "NOT FOUND";
      }
    }

    resolutions += ({ resolution });
  }

  write("%s\n", Standards.JSON.encode(([
    "file": filepath, "pike_version": get_pike_version(),
    "resolutions": resolutions, "error": Val.null,
  ])));
  return 0;
}
