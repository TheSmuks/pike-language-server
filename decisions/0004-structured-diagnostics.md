# Decision 0004: Structured Diagnostics via CompilationHandler

**Date:** 2026-04-26
**Status:** Accepted
**Context:** Phase 0 verification — structured output path discovered

## Decision

Use Pike's `CompilationHandler` interface (`compile_string` with a custom handler) to capture structured diagnostics, instead of parsing stderr text output. This is the primary diagnostics path for the harness and LSP server.

For type information, use `Tools.AutoDoc.PikeExtractor` for documented members and source-level parsing for undocumented members. This does not replace the source parser — it supplements it with oracle-ground-truth for documented declarations.

## Discovery

The Phase 0 investigation concluded "pike has no structured output." This was partially incorrect. While pike has no **command-line flag** for structured output, it exposes a programmatic API:

1. **`compile_string(source, filename, handler)`** accepts a custom `CompilationHandler` object with `compile_error(string file, int line, string msg)` and `compile_warning(string file, int line, string msg)` callbacks. These receive the same data that would be printed to stderr, but in structured form: separate file, line, and message parameters.

2. **`Standards.JSON.encode(data)`** produces valid JSON from Pike data structures. Combined with (1), a Pike script can emit structured diagnostics as JSON.

3. **`Tools.AutoDoc.PikeExtractor`** extracts type information from Pike source as XML, including:
   - Method return types and argument types (with full generics: `array<int>`, `mapping<string:int>`)
   - Inheritance relationships
   - Source positions (file + line)
   - **Limitation: only for members with `//!` doc comments.** Undocumented members are invisible to AutoDoc.

### Proof of Concept

```pike
// Custom handler captures structured diagnostics
object handler = class {
  array diagnostics = ({});
  void compile_error(string file, int line, string msg) {
    diagnostics += ({ (["file": file, "line": line, "message": msg]) });
  }
  void compile_warning(string file, int line, string msg) {
    diagnostics += ({ (["file": file, "line": line, "message": msg, "severity": "warning"]) });
  }
}();

mixed err = catch {
  program p = compile_string("#pragma strict_types\n" + source, filepath, handler);
};
// handler->diagnostics is now a structured array — no stderr parsing needed
write("%s\n", Standards.JSON.encode((["diagnostics": handler->diagnostics])));
```

Output:
```json
{"diagnostics":[
  {"line":5,"message":"Bad type in assignment.","file":"test.pike"},
  {"line":5,"message":"Expected: int.","file":"test.pike"},
  {"line":5,"message":"Got     : string(101..111).","file":"test.pike"}
]}
```

## What This Changes

### Diagnostics (Decision 0001 impact)

| Aspect | Previous (stderr parsing) | New (CompilationHandler) |
|--------|--------------------------|--------------------------|
| Format | Text: parse `<file>:<line>:<msg>` | Structured: handler receives `(file, line, msg)` |
| Reliability | Fragile — depends on format stability | Stable — `CompilationHandler` is documented API since Pike 7.x |
| Column info | No | No (handler still receives line only) |
| Error categorization | Regex on message text | Same — still need to categorize by message text |
| Implementation | Subprocess + stderr capture | Subprocess with Pike introspection script OR pike-ai-kb |

### Type Information (Decision 0002 impact)

AutoDoc provides **oracle-ground-truth** for documented members. This is a new data source that sits between "pike runtime" and "source parser":

| Source | What it covers | What it misses |
|--------|---------------|----------------|
| pike runtime (`typeof()`) | Expression types, local variable types | Object member types (returns `mixed`) |
| AutoDoc (`PikeExtractor`) | Documented method signatures, return types, generics, inheritance | Undocumented members, variables without `//!` |
| Source parser (tree-sitter) | All declarations, all members, all types | No semantic validation — accepts more than pike |

### Harness Design (Phase 1 impact)

The harness now has **three** ground-truth sources, not two:

1. **Diagnostics**: `compile_string` with handler → structured JSON (replaces stderr parsing)
2. **Type ground truth (documented)**: AutoDoc XML → parse to extract type signatures
3. **Type ground truth (all)**: Source file → tree-sitter parse tree → extract declared types

## What This Does NOT Change

- **Object member types at runtime**: `typeof(o->member) → mixed` remains true. AutoDoc only covers documented members. Source parsing is still required for complete coverage.
- **Column information**: Not available from `CompilationHandler`. Still line-only.
- **Cross-file resolution**: Neither `CompilationHandler` nor AutoDoc provides this.
- **The fundamental architecture**: Still oracle + source parser. The oracle just became more reliable.

## Consequences

- Decision 0001 ("pike as oracle") is strengthened: the oracle now produces structured output, reducing harness complexity.
- Decision 0002 ("tier-3 scope") is unchanged in scope but the two-tier strategy gains a third tier for type information.
- Decision 0003 ("pike-ai-kb integration") is unchanged: pike-ai-kb wraps the same APIs.
- The harness uses a Pike introspection script (not raw stderr) as the primary diagnostics path.
- `docs/pike-interface.md` needs updating to document `CompilationHandler`, AutoDoc, and `Standards.JSON`.
- The harness comparison mode compares LSP output against handler-produced JSON, not parsed stderr text.

## Error Format Stability

Only Pike 8.0.1116 is installed on this system. The `CompilationHandler` interface is documented in Pike's official reference manual and is part of the stable API. The error message strings ("Bad type in assignment.", "Expected:", "Got:") are embedded in the C compiler source (`src/program.c`) and have not changed across the Pike 8.0.x series. The `compile_error(string, int, string)` signature is stable.

For the stderr text format specifically: the `<file>:<line>:<message>` format has been unchanged since at least Pike 7.8. The `LONG_PIKE_ERRORS`/`SHORT_PIKE_ERRORS` environment variables control path length but not format structure.
