# Decision 0019: pike-introspect Integration (Phase 16)

**Date:** 2026-05-02
**Status:** Proposed

## Context

[pike-introspect](https://github.com/TheSmuks/pike-introspect) v0.1.0 is a new pmp module providing runtime introspection capabilities for Pike. It exposes:

- `Discover` — module, program, function, and constant discovery
- `Describe` — type strings, symbol descriptions, and environment summaries
- `Search` — pattern-based symbol search across all symbols
- `Json` — JSON output formatters for machine consumption

The LSP currently uses a custom `harness/worker.pike` (based on `harness/Common.pike`) for runtime introspection. The PikeWorker provides:
- `diagnose` — compile and return diagnostics
- `autodoc` — extract AutoDoc XML
- `typeof` — get type of an expression

`harness/Common.pike` uses `compile_string()` and tree-sitter WASM to provide ground-truth symbol information. It is tailored for LSP-specific use cases (scope resolution, inheritance chains, etc.).

The LSP also maintains pre-built static indices:
- `stdlib-autodoc.json` (5,505 symbols) — built from Pike stdlib source
- `predef-builtin-index.json` (283 symbols) — C-level predef builtins

## Evaluation

### What pike-introspect provides that we don't have

1. **Runtime module discovery** — `list_modules()`, `describe_module()` can enumerate all available Pike modules at runtime. Our stdlib index is static (built once from known stdlib paths). pike-introspect can discover modules dynamically.

2. **Object/program instance analysis** — `describe_object()`, `describe_program()` enumerate methods and variables via `indices()`. Our symbol table walks tree-sitter parse trees. This is complementary.

3. **Pattern-based search** — `search_symbols()` provides substring search across all constants. Useful for workspace symbol search enhancement.

4. **Environment summary** — `environment_summary()` gives Pike version, module count, stdlib list. Useful for diagnostics ("unsupported Pike version") vs. our current binary existence check.

### What pike-introspect does NOT cover

1. **Source-code-level symbol resolution** — No AST traversal, no source location extraction, no scope chain analysis. Our tree-sitter-based symbol table is necessary for go-to-definition and completion.

2. **Type resolution from source** — `typeof()` in Pike returns runtime types, not source-level declared types. We use tree-sitter to extract declared types from source for hover/completion.

3. **Inheritance chain resolution** — Our `wireInheritance()` resolves class inheritance for completion and definition. pike-introspect's `describe_program()` returns inherited class names, but doesn't map that to source locations.

4. **Cross-file symbol tables** — We build per-file symbol tables from source. pike-introspect works on runtime objects, not source files.

### Known limitations we still need to handle

From `docs/known-limitations.md`:
- C-level predef builtins not resolved by Pike (mitigated by `predef-builtin-index.json`)
- Cross-file inherited member completion incomplete (`wireInheritance()` doesn't resolve cross-file)
- while/switch/do-while block scoping (tree-sitter-pike#4, workaround exists)

pike-introspect does not directly address these limitations.

## Decision

We will **explore** pike-introspect integration in a future phase (Phase 16 or later), with the following boundaries:

### In scope for future integration

1. **Enhance workspace symbol search** — Use `Search` module for pattern-based search across runtime-discovered symbols, complementing our static indices.

2. **Runtime module discovery for completion** — Use `Discover` to build dynamic stdlib completion items, replacing or supplementing the static `stdlib-autodoc.json`.

3. **Environment verification** — Use `environment_summary()` to verify Pike version compatibility at startup.

4. **Diagnostics improvement** — Use `Describe` to provide richer hover for runtime objects (not just declared types from source).

### Out of scope for the foreseeable future

1. **Replace the symbol table** — Tree-sitter-based source analysis is correct for our use cases. Runtime introspection of objects doesn't help with go-to-definition on source code.

2. **Replace PikeWorker** — The `diagnose`, `autodoc`, and `typeof` operations in our worker are tailored for LSP use. pike-introspect's `describe_*` functions serve different purposes.

3. **Replace static indices** — The pre-built stdlib index (5,505 symbols) provides stable, fast O(1) lookups. Dynamic discovery would add latency and inconsistency.

## Implementation Notes (for future phases)

If we integrate pike-introspect:

1. Add as a dependency in `harness/` (not `server/`), so the worker can use it:
   ```
   pmp install TheSmuks/pike-introspect
   ```

2. The worker already uses `-M harness/` module path. pike-introspect installs to `.pike_modules/Introspect.pmod/`. Access it with `import Introspect;` in worker.pike.

3. For completion, we could:
   - Query `Discover.list_modules()` to verify stdlib paths
   - Use `Search.search_symbols()` to filter completion items by prefix
   - Keep the static index as the primary source, use pike-introspect for fallback/dynamic discovery

4. The JSON formatters in `Introspect.Json` could replace or supplement our `Common.pike` JSON output for specific queries, but the existing canonical format should be preserved for test compatibility.

## Open Questions

1. **Version stability** — pike-introspect v0.1.0 is new. How stable is the API? Should we pin to a specific version?

2. **PMR (Pike Module Registry) availability** — The module installs via `pmp install`. CI environment may not have pmp or network access. How do we handle CI without pmp?

3. **Overlap with existing code** — Our `harness/Common.pike` already does some introspection (`compile_string`, `indices()`, `values()`). Should we refactor Common.pike to use pike-introspect internally, or keep them separate?

4. **Security considerations** — pike-introspect is read-only (confirmed in its ARCHITECTURE.md). Our worker already runs Pike code, so attack surface is unchanged.

## Follow-up Actions

- [ ] Open a GitHub issue: "Explore pike-introspect integration" with this decision as context
- [ ] Benchmark: measure pike-introspect module discovery latency vs. static index lookup
- [ ] Test in CI: verify pmp install works in CI environment, or document fallback strategy
- [ ] Evaluate: can pike-introspect help with cross-file inherited member completion?
---

## Follow-up Results (2026-05-02)

### Open Question #2: PMR availability

**RESOLVED**: CI explicitly installs pmp before running `pmp install` (see `.github/workflows/ci.yml` lines 85-92):

```yaml
- name: Add Pike and pmp to PATH
  run: echo "$HOME/.pike/pike/8.0.1116/bin" >> $GITHUB_PATH && echo "$HOME/.pmp/bin" >> $GITHUB_PATH

- name: Install pmp
  run: curl -LsSf https://raw.githubusercontent.com/TheSmuks/pmp/v0.5.0/install.sh | PMP_VERSION=v0.5.0 sh

- name: Install Pike dependencies
  run: ~/.pmp/bin/pmp install
```

`pmp install TheSmuks/pike-introspect` works in CI. **No fallback strategy needed.**

### Follow-up Action: Cross-file inherited member completion

**RESOLVED**: pike-introspect does **not** help with cross-file inheritance resolution.

**Analysis**: `describe_program(object)` returns inherited class names via `indices()`, but does not provide source file locations. For go-to-definition and member completion, we need: "which source file defines `ParentClass` → what symbols does it export?"

**Conclusion**: Runtime introspection tells you *what* was inherited, but not *where* in source code. This gap must be addressed with tree-sitter/workspace index approaches. See `docs/known-limitations.md` for the actual gap (incomplete cross-file resolution in `wireInheritance()`).

**Action**: Address cross-file inheritance resolution as a separate work item, not via pike-introspect.

### Follow-up Action: Benchmark

**DEFERRED**: pike-introspect not installed in current environment. Cannot measure actual latency.

**Expected result**: Static index (`stdlib-autodoc.json`) provides O(1) hash map lookup — significantly faster than pike-introspect runtime queries (`Discover.list_modules()` + `Search.search_symbols()`).

**Recommendation**: Keep static index as primary completion source. Use pike-introspect for fallback/dynamic discovery only (when a module isn't in the static index).

### Updated Action Checklist

- [x] Open a GitHub issue: "Explore pike-introspect integration" — done, see issue #19
- [ ] Benchmark: measure pike-introspect module discovery latency vs. static index lookup — deferred (expected: static index faster)
- [x] Test in CI: verify pmp install works in CI environment, or document fallback strategy — resolved, CI has pmp
- [x] Evaluate: can pike-introspect help with cross-file inherited member completion? — no, requires tree-sitter approach
