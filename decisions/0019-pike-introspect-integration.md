# Decision 0019: pike-introspect Integration

**Date:** 2026-05-02
**Status:** Integrated (Phase 16)
**Updated:** 2026-05-03 (v0.2.0 integration)

## Context

[pike-introspect](https://github.com/TheSmuks/pike-introspect) is a pmp module providing runtime introspection capabilities for Pike. It exposes:

- `Discover` — module, program, function, and constant discovery with `resolve_symbol()` and `resolve_program()`
- `Describe` — type strings, symbol descriptions, program analysis with inheritance chains
- `Search` — pattern-based symbol search across all symbols
- `Json` — JSON output formatters for machine consumption

v0.2.0 (2026-05-03) shipped with three critical features:

1. **`resolve_symbol(name)`** — Cross-file identifier resolution returning `kind`, `source_file`, `source_line`
2. **`describe_program(p)` with source locations** — Methods/constants now include `source_file` and `source_line`
3. **`describe_program(p)` with inheritance** — `inherits` array, `inherited_methods`, `inherited_constants`

The LSP currently uses a custom `harness/worker.pike` (based on `harness/Common.pike`) for runtime introspection. The PikeWorker provides:
- `diagnose` — compile and return diagnostics
- `autodoc` — extract AutoDoc XML
- `typeof` — get type of an expression
- `resolve` (Phase 16) — cross-file symbol resolution with source locations and inheritance chains

The LSP also maintains pre-built static indices:
- `stdlib-autodoc.json` (5,505 symbols) — built from Pike stdlib source
- `predef-builtin-index.json` (283 symbols) — C-level predef builtins

## Evaluation (v0.2.0)

### What pike-introspect provides that we didn't have before v0.2.0

1. **Cross-file symbol resolution with source locations** — `resolve_symbol()` resolves `Stdio.File` to `kind: "class"`, `source_file: "/path/to/Stdio.pmod"`, `source_line: 181`. This directly addresses the gap identified in the original Decision 0019 where pike-introspect "does not help with cross-file inheritance resolution." With source location extraction, it now can.

2. **Inheritance chain enumeration** — `describe_program()` now returns `inherits`, `inherited_methods`, `inherited_constants`. For `Stdio.File`, this includes the `_Stdio.Fd` inheritance with source locations.

3. **Runtime module discovery** — `list_modules()`, `describe_module()` can enumerate all available Pike modules at runtime. Our stdlib index is static (built once from known stdlib paths). pike-introspect can discover modules dynamically.

4. **Object/program instance analysis** — `describe_object()`, `describe_program()` enumerate methods and variables via `indices()`. Our symbol table walks tree-sitter parse trees. This is complementary.

### What pike-introspect does NOT cover (unchanged from v0.1.0)

1. **Source-code-level symbol resolution** — No AST traversal, no scope chain analysis. Our tree-sitter-based symbol table is necessary for go-to-definition and completion within user code.

2. **Type resolution from source** — `typeof()` in Pike returns runtime types, not source-level declared types. We use tree-sitter to extract declared types from source for hover/completion.

3. **Cross-file symbol tables** — We build per-file symbol tables from source. pike-introspect works on runtime objects, not source files.

## Decision

We integrate pike-introspect v0.2.0 into the LSP harness and worker:

### What was integrated in Phase 16

1. **`resolve` method in worker.pike** — Uses `Introspect.Discover.resolve_symbol()` and `Introspect.Describe.describe_program()` for runtime-backed symbol resolution with source locations and inheritance chains.

2. **`PikeWorker.resolve()` in TypeScript** — Exposes the new `resolve` method to callers. The method is async (subprocess IPC) with 5s timeout.

3. **Worker spawn args updated** — Added `-M modules/Introspect/src/` so the Pike worker can find the Introspect module.

### In scope for future phases

1. **Background indexing of cross-file inheritance chains** — `describe_program()` can enumerate inherited methods/constants, but building a background index from this data requires a persistence layer and invalidation strategy.

2. **Pre-warming the scope builder with pike-introspect data** — The scope builder currently builds scopes from tree-sitter + stdlib index. Augmenting it with runtime data from pike-introspect is a design decision that depends on having the resolve infrastructure in place first.

3. **Fallback resolution when tree-sitter can't resolve a symbol** — The `resolve` method is infrastructure for future phases to build on.

### Out of scope for the foreseeable future

1. **Replacing the static stdlib index (5,505 symbols)** — The stdlib index provides O(1) lookups for known symbols. pike-introspect requires a subprocess round-trip per query. The index remains the primary lookup; pike-introspect is a supplement for symbols the index doesn't cover.

2. **Replacing the symbol table** — Tree-sitter-based source analysis is correct for go-to-def within user code. pike-introspect resolves at runtime, which is complementary but not a replacement for static analysis.

3. **Wiring completion/definition providers to call pike-introspect at runtime** — The completion provider is synchronous and tree-sitter-based; PikeWorker calls are async (subprocess IPC) with a 5s timeout. Wiring these together requires architectural changes (background indexing, caching layer, or pre-warming).

4. **Replacing `harness/Common.pike`** — Its CompilationHandler is used by the worker for diagnose/typeof/autodoc, distinct from what pike-introspect provides.

5. **Refactoring `harness/resolve.pike` to use pike-introspect internally** — resolve.pike does source-level reference parsing (inherit/import extraction from source text) which pike-introspect doesn't provide. The refactoring would replace `extract_symbols()` and `resolve_def_loc()` with pike-introspect calls, but this requires careful comparison of output equivalence and is deferred.

## Implementation Notes

### Module path discovery

pmp symlinks: `modules/Introspect -> ~/.pike/store/github.com-TheSmuks-pike-introspect-v0.2.0-...`
The actual module is at `modules/Introspect/src/Introspect.pmod`.
Pike needs `-M modules/Introspect/src/` to resolve `import Introspect`.

Note: `.pike-env/bin/pike` wrapper sets `PIKE_MODULE_PATH=modules/` but this doesn't work because the symlink layout doesn't match Pike's `.pmod` convention. The worker must use `-M modules/Introspect/src/` explicitly.

### Program serialization

`resolve_symbol()` returns `program` objects that can't be JSON-serialized. Must strip with `m_delete` before encoding response.

### Conditional import

`import Introspect;` is inside the handler function, not at file top-level. This way the worker starts even if Introspect isn't installed; only `resolve` calls fail gracefully.

### CI

CI already runs `pmp install` after installing pmp. pike-introspect is in `pike.json` so it will be installed. The `modules/` directory needs to exist before the worker spawns.

## Follow-up Actions

- [x] ~~Open a GitHub issue: "Explore pike-introspect integration"~~ — done, issue #19
- [x] ~~Benchmark: measure pike-introspect module discovery latency vs. static index lookup~~ — deferred (expected: static index faster)
- [x] ~~Test in CI: verify pmp install works in CI environment, or document fallback strategy~~ — resolved, CI has pmp
- [x] ~~Evaluate: can pike-introspect help with cross-file inherited member completion?~~ — now: partially, v0.2.0 provides inheritance info but completion is sync and worker is async
- [x] **Phase 16: Integrate pike-introspect v0.2.0** — DONE (2026-05-03)
  - [x] Add `resolve` method to worker.pike
  - [x] Add `ResolveResult` type and `resolve()` method to PikeWorker TypeScript
  - [x] Update worker spawn args to include `-M modules/Introspect/src/`
  - [x] Add tests for resolve method
  - [x] Run full test suite

---

## Historical

### Follow-up Results (2026-05-02, v0.1.0 evaluation)

#### Open Question #2: PMR availability — RESOLVED

CI explicitly installs pmp before running `pmp install` (see `.github/workflows/ci.yml` lines 85-92):

```yaml
- name: Add Pike and pmp to PATH
  run: echo "$HOME/.pike/pike/8.0.1116/bin" >> $GITHUB_PATH && echo "$HOME/.pmp/bin" >> $GITHUB_PATH

- name: Install pmp
  run: curl -LsSf https://raw.githubusercontent.com/TheSmuks/pmp/v0.5.0/install.sh | PMP_VERSION=v0.5.0 sh

- name: Install Pike dependencies
  run: ~/.pmp/bin/pmp install
```

`pmp install TheSmuks/pike-introspect` works in CI. **No fallback strategy needed.**

#### Follow-up Action: Cross-file inherited member completion — UPDATED

**v0.1.0 assessment**: pike-introspect does **not** help with cross-file inheritance resolution. `describe_program(object)` returns inherited class names via `indices()`, but does not provide source file locations.

**v0.2.0 update**: `describe_program()` now returns `inherits` with `source_file` and `source_line`. This enables:
- Listing inherited methods/constants
- Finding the source location of inherited base classes

However, the **completion provider is synchronous and tree-sitter-based**. PikeWorker calls are async (subprocess IPC) with a 5s timeout. Wiring these together requires architectural changes.

**Conclusion**: pike-introspect v0.2.0 provides the data but the completion pipeline is not yet wired to consume it. Future phases can build on the `resolve` infrastructure for background indexing and pre-warming.

#### Follow-up Action: Benchmark — DEFERRED

**Expected result**: Static index (`stdlib-autodoc.json`) provides O(1) hash map lookup — significantly faster than pike-introspect runtime queries (`Discover.list_modules()` + `Search.search_symbols()`).

**Recommendation**: Keep static index as primary completion source. Use pike-introspect for fallback/dynamic discovery only (when a module isn't in the static index).