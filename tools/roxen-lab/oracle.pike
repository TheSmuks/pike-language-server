#!/usr/bin/env pike
//
// Roxen parse oracle.
//
// Answers one question per file: does Pike's own compiler accept this source?
// The tree-sitter grammar is not the authority on what valid Pike is — the
// compiler is (see the project's "pike is the oracle" rule). When the grammar
// and this disagree, the grammar has the defect.
//
// The verdict separates the three outcomes the triage needs to tell apart:
//
//   ok          Pike compiles it. A tree-sitter ERROR node on this file is a
//               grammar gap.
//   cpp_error   The preprocessor failed — a missing include or a bad directive.
//               Raw source is not what the compiler ever sees, so a grammar
//               failure here is a macro-expansion gap, not a syntax gap.
//   syntax      Pike's parser rejects it too. The source is invalid.
//   semantic    Parsed fine; failed on meaning (undefined identifier, bad type).
//               Syntactically valid, so still a grammar gap if tree-sitter
//               reports ERROR. A Roxen module compiled outside the Roxen
//               runtime lands here as a matter of course — `roxen`, `RXML` and
//               the module prototype are simply absent — which is why the
//               verdict, not the error count, is what the triage reads.
//
// Usage:
//   pike oracle.pike [-I dir]... [--json] <file>...

#pike __REAL_VERSION__

constant USAGE = #"Usage: oracle.pike [-I <dir>]... [--json] <file>...

  -I <dir>   Add an include directory (repeatable).
  --json     One JSON object per line instead of human-readable text.
  --help     This message.
";

//! A compilation error or warning as reported by Pike.
class Diagnostic(string file, int line, string message, string severity)
{
  mapping(string:mixed) to_mapping()
  {
    return ([ "file": file, "line": line,
              "message": message, "severity": severity ]);
  }

  protected string _sprintf(int c)
  {
    return sprintf("%s:%d: %s: %s", file, line, severity, message);
  }
}

//! Compilation handler that collects diagnostics instead of throwing.
//!
//! Unresolvable names are left unresolved rather than stubbed out. Stubbing
//! them was tried and rejected: Pike folds constants during compilation, so a
//! stub object reaches operators that then throw at compile time, and a
//! runtime backtrace replaces the compiler's own account of the file. Letting
//! the name stay undefined produces an ordinary semantic diagnostic instead,
//! which the verdict already handles.
class OracleHandler
{
  array(Diagnostic) diagnostics = ({});

  void compile_error(string file, int line, string msg)
  {
    diagnostics += ({ Diagnostic(file, line, msg, "error") });
  }

  void compile_warning(string file, int line, string msg)
  {
    diagnostics += ({ Diagnostic(file, line, msg, "warning") });
  }

  //! Resolve an inherit, falling back to an empty program.
  //!
  //! `inherit "module"` cannot resolve outside Roxen. Failing the inherit
  //! outright would abort the compilation before the parser has seen the rest
  //! of the file, and the rest of the file is the part under examination.
  mixed handle_inherit(string what, string|void current_file, object|void handler)
  {
    mixed resolved;
    if (!catch { resolved = master()->handle_inherit(what, current_file, handler); })
      if (resolved) return resolved;
    return class {};
  }
}

//! True when a compiler message is the parser refusing the input, as opposed
//! to the type checker or the resolver objecting to its meaning.
int(0..1) is_syntax_message(string msg)
{
  return has_value(lower_case(msg), "syntax error")
      || has_value(lower_case(msg), "unexpected end of file")
      || has_value(lower_case(msg), "illegal character")
      || has_value(lower_case(msg), "unterminated string");
}

//! Compile one file and return its verdict.
mapping(string:mixed) examine(string path, array(string) include_paths)
{
  string source = Stdio.read_file(path);
  if (!source)
    return ([ "file": path, "verdict": "unreadable",
              "diagnostics": ({}) ]);

  // Pike's cpp() takes the include path from the master's program path list,
  // so extend it for the duration of this call rather than passing it in.
  array(string) saved = master()->pike_include_path;
  master()->pike_include_path = include_paths + saved;

  OracleHandler handler = OracleHandler();
  string expanded;
  mixed cpp_failure = catch {
    expanded = cpp(source, ([ "current_file": path, "handler": handler ]));
  };
  master()->pike_include_path = saved;

  if (cpp_failure) {
    return ([ "file": path, "verdict": "cpp_error",
              "diagnostics": handler->diagnostics->to_mapping(),
              "detail": describe_error(cpp_failure) ]);
  }

  mixed compile_failure = catch {
    compile_string(expanded, path, handler);
  };

  array(Diagnostic) errors =
    filter(handler->diagnostics, lambda (Diagnostic d) { return d->severity == "error"; });

  string verdict = "ok";
  if (sizeof(filter(errors, lambda (Diagnostic d) { return is_syntax_message(d->message); })))
    verdict = "syntax";
  else if (sizeof(errors) || compile_failure)
    verdict = "semantic";

  mapping(string:mixed) result = ([
    "file": path,
    "verdict": verdict,
    "diagnostics": handler->diagnostics->to_mapping(),
  ]);
  if (compile_failure && verdict != "syntax")
    result->detail = describe_error(compile_failure);
  return result;
}

int main(int argc, array(string) argv)
{
  array(string) include_paths = ({});
  array(string) files = ({});
  int json_output;

  for (int i = 1; i < argc; i++) {
    string arg = argv[i];
    if (arg == "--help" || arg == "-?") { write(USAGE); return 0; }
    if (arg == "--json") { json_output = 1; continue; }
    if (arg == "-I") {
      if (++i >= argc) { werror("-I requires a directory\n"); return 2; }
      include_paths += ({ argv[i] });
      continue;
    }
    if (has_prefix(arg, "-I")) { include_paths += ({ arg[2..] }); continue; }
    files += ({ arg });
  }

  if (!sizeof(files)) { werror(USAGE); return 2; }

  int failures;
  foreach (files, string path) {
    mapping(string:mixed) result = examine(path, include_paths);
    if (result->verdict != "ok") failures++;

    if (json_output) {
      write("%s\n", Standards.JSON.encode(result));
      continue;
    }

    write("%s: %s\n", result->file, result->verdict);
    foreach (result->diagnostics, mapping(string:mixed) d)
      write("    %s:%d: %s: %s\n", d->file, d->line, d->severity, d->message);
    if (result->detail)
      write("    %s\n", replace(String.trim_all_whites(result->detail), "\n", "\n    "));
  }

  return failures ? 1 : 0;
}
