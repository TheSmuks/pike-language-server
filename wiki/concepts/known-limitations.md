---
title: Known Limitations
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - limitations
  - known-issue
  - upstream-issue
sources:
  - raw/articles/known-limitations.md
---

# Known Limitations

Comprehensive catalog of current and resolved limitations in the Pike Language Server, organized by development phase and severity.

Related: [[pike]], [[tree-sitter-pike]], [[pike-ai-kb]], [[tier-3-lsp]], [[type-inference]]

## Severity Classification

### Critical (Blocks core functionality)

*None currently.*

### High (Major features impaired)

*None currently.* Cross-file inherited member completion was resolved (tests US-001, CB-2, US-002 now pass).

### Medium (Known workarounds, tracked for resolution)

| Limitation | Severity | Workaround |
|------------|----------|------------|
| Complex initializer type inference | Medium | `extractInitializerType` handles constructors and ternary. Complex expressions need explicit annotations. |
| pike-fmt formatting scope | Medium | Phase 1: indentation normalization only. Operator spacing is future work. |

### Low (Minor impact, rare occurrence)

| Limitation | Severity | Workaround |
|------------|----------|------------|
| pike-introspect availability | Low | CI installs it. Worker starts without it. Only `resolve` calls fail. |
| pmp module path limitation | Low | Explicit `-M` path in spawn args (TheSmuks/pmp#42) |

---

## Formatting Limitations (Phase 1)

The `textDocument/formatting` feature uses a three-layer architecture:

1. **`client/language-configuration.json`** -- Client-side indentation rules (Enter, Tab, auto-indent). No LSP traffic.
2. **`pike-fmt`** -- Standalone formatter tool (separate repository). Uses tree-sitter-pike.
3. **`server/src/features/formattingHandler.ts`** -- LSP thin wrapper that shells out to `pike-fmt`.

**Current phase 1 limitations:**

| # | Limitation | Impact | Mitigation |
|---|------------|--------|------------|
| 1 | No semantic formatting | Formatter operates on tree-sitter parse, not Pike semantics | Phase 1 is indentation-only |
| 2 | Preprocessor directive formatting | `#if`/`#endif` blocks may not format correctly if parse tree splits across boundaries | tree-sitter-pike limitation -- document in user docs |
| 3 | No operator spacing | Phase 1 is indentation normalization only | Future phases may add spacing |
| 4 | Multiline string/comment bodies preserved | Formatter only touches leading whitespace | Intentional for Phase 1 |
| 5 | Range formatting not implemented | Formatter operates on whole files | Full-document formatting only |
| 6 | Requires pike-fmt installed | LSP handler shells out to `pike-fmt` | Error response if binary not found |

---

## Cross-File Resolution Limitations (Phase 4)

### No .so binary module resolution -- PERMANENT

The ModuleResolver skips `.so` (compiled C module) files. System modules that are pure C (e.g., `_Stdio`, `__builtin`) cannot be resolved by path lookup.

**Mitigation**: Most commonly used stdlib modules (Stdio, Array, Mapping, etc.) are implemented in Pike (.pmod files) and resolve correctly. Pure C modules could be handled in a future phase via pike-ai-kb or a pre-built system module map.

### No joinnode multi-path merge -- PERMANENT

Pike's `joinnode` class merges symbols from multiple search paths. The LSP uses first-match-wins instead. If a workspace contains a module with the same name as a system module, the workspace version takes precedence.

### Import resolution scoped to file-system paths -- PERMANENT

Import resolution searches workspace and system module paths. It does not query Pike at runtime. Dynamic module behavior (modules that register symbols at compile time) is not captured.

---

## Diagnostics and Hover Limitations (Phase 5)

### Diagnostics are real-time with debouncing

Diagnostics from the Pike compiler are triggered on `textDocument/didChange` (debounced at 500ms) and `textDocument/didSave` (immediate). Three modes: realtime, saveOnly, off. Decision 0013.

### Diagnostic column positions are approximate

Pike's `compile_error` handler reports line numbers but not column positions. Added `lineToColumn()` helper that locates the first meaningful token on the diagnostic's line using tree-sitter. The column is approximate -- it points to the first meaningful token on the line, not to the specific error token.

### Stdlib hover: C-level builtins not indexed

The stdlib index (5,471 symbols) covers Pike source files only. C-level builtins (`write`, `werror`, `arrayp`, `all_constants`, etc.) are not indexed. The LSP's predef builtin index (`predef-builtin-index.json`, 283 symbols) covers the gap.

### AutoDoc hover coverage depends on codebase conventions -- BY DESIGN

AutoDoc hover only works for symbols documented with `//!` comments. The fallback to tree-sitter declared types ensures hover always works, even for undocumented symbols.

---

## Type Resolution Limitations (Phase 7)

### Type resolution requires explicit type annotations -- PARTIALLY RESOLVED

The symbol table now captures `assignedType` from simple initializer expressions. Variables initialized by assignment (not declaration) are not covered. Complex expressions that don't reduce to a simple constructor or ternary call still require explicit type annotations.

---

## Rename Limitations (Phase 8)

All major rename limitations have been resolved:
- Arrow/dot access rename uses type-filtered matching via `isReceiverTypeMatch()`
- Rename through function return types works via `type_ref` references
- Generic type refs in `array(Dog)`, `mapping(Dog:int)` etc. are handled

---

## Inlay Hints Limitations

### Parameter name hints -- UNBLOCKED

G2 (parameter name inlay hints at call sites) was blocked because tree-sitter-pike did not produce dedicated AST nodes for function call arguments at statement level. Fixed in tree-sitter-pike v1.2.2 -- bare function calls at statement level now parse as `postfix_expr` with `argument_list`.

**Upstream issue**: [TheSmuks/tree-sitter-pike#18](https://github.com/TheSmuks/tree-sitter-pike/issues/18)

---

## Upstream Issue Tracker

### tree-sitter-pike

| Issue | Status | Description |
|-------|--------|-------------|
| [#1](https://github.com/TheSmuks/tree-sitter-pike/issues/1) | RESOLVED | Unicode identifiers not parsed correctly. Fixed in commit `28a8ae8`. |
| [#2](https://github.com/TheSmuks/tree-sitter-pike/issues/2) | RESOLVED | Missing field names on for_statement children. `for_statement` now has `body`, `condition`, `initializer` fields. |
| [#3](https://github.com/TheSmuks/tree-sitter-pike/issues/3) | RESOLVED | catch expression in assignment context. `catch_expr` now appears in parse tree. |
| [#4](https://github.com/TheSmuks/tree-sitter-pike/issues/4) | RESOLVED | No scope-introducing nodes for while/switch/plain blocks. All now have `body` fields. |
| [#18](https://github.com/TheSmuks/tree-sitter-pike/issues/18) | RESOLVED | Bare function calls parsed as `macro_invocation_stmt`. Fixed in v1.2.2. |

### pike-ai-kb

| Issue | Status | Description |
|-------|--------|-------------|
| [#11](https://github.com/TheSmuks/pike-ai-kb/issues/11) | OPEN | pike-signature cannot resolve C-level predef builtins. `all_constants()` fallback needed. |

### pike-fmt

| Issue | Status | Description |
|-------|--------|-------------|
| [#16](https://github.com/TheSmuks/pike-fmt/issues/16) | RESOLVED | Configurable WASM path. Fixed in v0.1.5 via `--wasm-path` or `PIKE_FMT_WASM` env var. |
| [#17](https://github.com/TheSmuks/pike-fmt/issues/17) | RESOLVED | `.pmod` file discovery. Fixed in v0.1.5. `findPikeFiles()` now matches `.pmod` extension. |

---

## Resolved Limitations

Major resolved limitations include:
- Cross-file inherited member completion (was test structure issue)
- Cross-file class-body identifier inherit resolution
- `.pmod` file discovery and directory introspection
- Hover via Pike runtime type inference (`typeof_()`)
- Chained type inference with `ResolutionCache` caching
- VSCode extension host tree-sitter WASM unavailability (client-side provider removed)
- AutoDoc hover now works on `didOpen`, not just `didSave`
