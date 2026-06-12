# Known Limitations

## Current Limitations

### Formatting (Phase 1)

The `textDocument/formatting` feature uses a three-layer architecture:

1. **`client/language-configuration.json`** — Client-side indentation rules (Enter, Tab, auto-indent). No LSP traffic.
2. **`pike-fmt`** — Standalone formatter library, imported in-process (NOT a subprocess).
3. **`server/src/features/formattingHandler.ts`** — LSP handler that calls pike-fmt functions directly.

| # | Limitation | Impact | Mitigation |
|---|------------|--------|------------|
| 1 | **No semantic formatting** | Formatter operates on tree-sitter parse, not Pike semantics | Phase 1 is indentation-only |
| 2 | **Preprocessor directive formatting** | `#if`/`#endif` blocks may not format correctly if parse tree splits across boundaries | tree-sitter-pike limitation — document in user docs |
| 3 | **No operator spacing** | Phase 1 is indentation normalization only | Future phases may add spacing |
| 4 | **Multiline string/comment bodies preserved** | Formatter only touches leading whitespace | Intentional for Phase 1 |
| 5 | **Range formatting not implemented** | Formatter operates on whole files | Full-document formatting only |
| 6 | **Requires pike-fmt dependency** | Formatter is imported in-process via `pike-fmt` package | Build-time dependency, no runtime PATH requirement |

### Cross-File Resolution (Phase 4)

#### No .so binary module resolution — PERMANENT

The ModuleResolver skips `.so` (compiled C module) files. System modules that are pure C (e.g., `_Stdio`, `__builtin`) cannot be resolved by path lookup. This affects completion and go-to-definition for low-level system types.

**Mitigation**: Most commonly used stdlib modules (Stdio, Array, Mapping, etc.) are implemented in Pike (.pmod files) and resolve correctly. Pure C modules could be handled in a future phase via pike-ai-kb or a pre-built system module map.

**Rationale**: Resolving C modules requires parsing C header files or using libdwarf debugging info — neither is practical for an LSP that needs to stay fast. The mitigation covers 95% of use cases.

#### No joinnode multi-path merge — PERMANENT

Pike's `joinnode` class merges symbols from multiple search paths when the same module name exists in multiple locations. The LSP uses first-match-wins instead. If a workspace contains a module with the same name as a system module, the workspace version takes precedence.

**Impact**: Rare in practice. Workspace modules overriding system modules matches user expectation.

#### Import resolution is scoped to file-system paths — PERMANENT

Import resolution searches workspace and system module paths. It does not query Pike at runtime. Dynamic module behavior (modules that register symbols at compile time) is not captured.

**Impact**: Low for standard Pike code. Dynamic modules are rare in user workspaces.

**Rationale**: Dynamic compilation-time module registration requires running Pike at LSP startup time for every file, which is too slow. File-system path resolution is the practical trade-off.

#### `#include` is textual only — no LSP symbol resolution

The `#include` preprocessor directive is used for textual file inclusion (C-style). It has TextMate scope for syntax highlighting, but the LSP does not resolve included content for go-to-definition, hover, or completion. Decision: [0027](decisions/0027-include-scope-resolution-limitation.md).

**Impact**: Symbols defined in included files are not visible to LSP features when referenced from the including file. Go-to-definition on a symbol in an `#include`-d header file does not navigate to the definition.

**TODO [#126](https://github.com/TheSmuks/pike-language-server/issues/126)**: Implement include-aware scope merging. When a file uses `#include "foo.h.pi"`, the LSP would need to merge scopes from both the host file and the included file. This requires tracking include directives during parsing and building a combined symbol table scope. Without this, `#include` works for Pike's own preprocessor (which handles it at compile time) but not for LSP features.

### Diagnostics and Hover (Phase 5/6)

#### Diagnostics are real-time with debouncing (Phase 6 P2)

Diagnostics from the Pike compiler are triggered on `textDocument/didChange` (debounced at 500ms) and `textDocument/didSave` (immediate). Three modes: realtime, saveOnly, off. Decision 0013.

**Configuration**: `initializationOptions.diagnosticMode` in the `initialize` request. Default: `realtime`.

**Verified**: 50 rapid didChange events produce ≤ 3 diagnose invocations. Hover latency unaffected during in-flight diagnose. See `decisions/0013-verification.md`.

#### Diagnostic column positions use message-aware resolution

Pike's `compile_error` handler reports line numbers but not column positions.

**Phase 20b**: Added `lineToColumn()` helper that locates the first meaningful token on the diagnostic's line using tree-sitter.

**Phase 20c (current)**: Added `messageAwareColumn()` in `diagnosticUtils.ts` that parses Pike error messages for identifier names (e.g., `"Undefined identifier: bark."` → `bark`) and locates the matching token on the diagnostic line. This provides column precision that points to the specific error token rather than the first token on the line.

**Remaining gap**: For Pike messages that don't contain an identifiable token (e.g., `"Bad type in assignment."`), the column falls back to the first meaningful token on the line. Parse diagnostics (tree-sitter errors) already have precise column positions.

#### Stdlib hover: C-level builtins not indexed

The stdlib index (5,471 symbols) covers Pike source files only. C-level builtins (`write`, `werror`, `arrayp`, `all_constants`, etc.) are not in Pike source files and are not indexed. These symbols return null hover from Tier 2.

**Fallback path**: pike-ai-kb `pike-signature` tool — blocked on [TheSmuks/pike-ai-kb#11](https://github.com/TheSmuks/pike-ai-kb/issues/11) (C-level predef resolution gap). The LSP's predef builtin index (283 symbols from runtime introspection) covers the gap for now.

**Resolution**: Build a supplementary index from Pike's C source or Pike reference documentation.

**Current state**: `predef-builtin-index.json` (283 symbols) is a temporary workaround. When [TheSmuks/pike-ai-kb#11](https://github.com/TheSmuks/pike-ai-kb/issues/11) ships its `all_constants()` fallback, evaluate removing the predef index in favor of kb queries.

#### AutoDoc hover coverage depends on codebase conventions — BY DESIGN

AutoDoc hover only works for symbols documented with `//!` comments. PikeExtractor produces XML only for documented symbols. In codebases without documentation conventions, hover falls through to tree-sitter declared types.

**Corpus coverage**: 5 docgroups across 2 files — only `autodoc-documented.pike` and `compat-pike78.pike` have `//!` comments.

**Rationale**: AutoDoc is opt-in documentation. The fallback to tree-sitter declared types ensures hover always works, even for undocumented symbols.

### Type Resolution (Phase 7)

#### Type resolution requires explicit type annotations — PARTIALLY RESOLVED (US-008)

**US-008 update**: The symbol table now captures `assignedType` from simple initializer expressions. When a variable is declared as `mixed x = Dog()`, `assignedType` is set to `Dog`, enabling type resolution through the existing `resolveType()` pipeline.

**Phase 20c**: Variable alias propagation is now handled by `propagateAssignedTypes()` (pass 2.5 in symbol table build). When `Dog d2 = d1;` is encountered, `d2` gets `assignedType = "Dog"` (resolved from `d1`'s type) instead of `assignedType = "d1"`. Multi-hop chains are handled iteratively (max 5 passes).

**Remaining gap**: Complex expressions beyond constructors, ternaries, and variable aliases still require explicit type annotations (e.g., method chains, array construction).

**Impact**: Arrow/dot member completion and go-to-definition now work for
variables initialized with simple constructors or ternary expressions, even when
declared as `mixed`. Other complex initializers still require explicit annotations.

### Design-Level Concerns (Documented, Not Bugs)

These are architectural decisions or simplifications that are known limitations
but are not bugs. They are documented in code comments and here for completeness.

| Concern | Location | Impact | Rationale |
|---------|----------|--------|-----------|
| Synthetic ID counter not thread-safe | `typeResolver.ts:nextSyntheticId` | None in Node.js single-threaded runtime | Safe under event loop concurrency. Would need atomic increment only if runtime changes to shared-memory multi-threading. |
| Name-only cross-file reference matching | `workspaceResolution.ts:getCrossFileReferences` | Reduced: arrow/dot access now filtered by receiver type. Bare identifier refs still name-only | Source-file filter + type-aware receiver matching for arrow/dot access. Bare identifier refs are conservative (included, user reviews in preview). |
| ~~No transitive inherit resolution~~ | ~~Resolved~~ | ~~N/A~~ | ~~Transitive inherit resolution now follows inherit chains recursively with cycle detection (MAX_DEPTH=10). See Resolved section.~~ |
| Scope boundary inclusion (`>=` not `>`) | `scope-helpers.ts:containsRange` | None — intentional | Tree-sitter ranges for Pike blocks include the closing `}` character. Using `>=` ensures positions on the closing brace are considered inside the scope. |

### Severity Classification

#### Critical (Blocks core functionality)

*None currently.*

#### High (Major features impaired)

*None currently — cross-file inherited member completion was resolved (tests US-001, CB-2, US-002 now pass).*

#### Medium (Known workarounds, tracked for resolution)

|| Limitation | Severity | Workaround ||
|------------|----------|------------||
| Complex initializer type inference | Medium | `extractInitializerType` handles constructors and ternary. Complex expressions need explicit annotations. |
| pike-fmt formatting | Medium | Phase 1: indentation normalization only. Operator spacing future work. |

#### Low (Minor impact, rare occurrence)

| Limitation | Severity | Workaround |
|------------|----------|------------|
| pike-introspect availability | Low | CI installs it. Worker starts without it. Only `resolve` calls fail. |
| pmp module path limitation | Low | Explicit `-M` path in spawn args (TheSmuks/pmp#42) |

### pike-introspect Availability Dependency

The `PikeWorker.resolve()` method depends on pike-introspect v0.2.0 being installed via `pmp install`.
The worker spawns with `-M modules/Introspect/src/` to find the module. If pike-introspect is not
installed, `resolve` calls will fail with an error message.

**Mitigation**: The worker starts successfully without pike-introspect — only `resolve` calls fail.
CI installs pike-introspect via `pmp install` after the pmp step in `.github/workflows/ci.yml`.

**pmp module path limitation**: pmp symlinks `modules/Introspect -> store-root` but Pike needs
`-M modules/Introspect/src/`. Filed as TheSmuks/pmp#42. Workaround: explicit `-M` path in spawn args.

### Current Upstream Issues

#### pike-ai-kb: pike-signature cannot resolve C-level predef builtins

**Upstream issue**: [TheSmuks/pike-ai-kb#11](https://github.com/TheSmuks/pike-ai-kb/issues/11)

The `pike-signature` MCP tool uses `master()->resolv()` for symbol lookup, which does not find C-level predef builtins (`write`, `werror`, `arrayp`, `all_constants`, etc.). The fix requires adding an `all_constants()` fallback to `pikeResolvePreamble()` in `src/pike-helpers.ts`.

**LSP impact**: None currently. The LSP's predef builtin index (`predef-builtin-index.json`, 283 symbols) provides hover coverage for these symbols. When pike-ai-kb adds the fallback, the LSP could route additional type queries through it for richer signatures.

---

## Resolved Limitations

### Call hierarchy outgoing calls always return empty — RESOLVED

**Problem**: The call hierarchy provider searched for `call_expression` nodes in the tree-sitter AST, but tree-sitter-pike represents function calls as `postfix_expr` nodes with `(` children (and optional `argument_list` when arguments are present). `getOutgoingCalls` always returned an empty array.

**Fix**: Rewrote the detection pipeline in `callHierarchy.ts`:
- `isCallPostfixExpr()` detects `postfix_expr` with `(` child
- `extractCalleeName()` + `extractCalleeFromChain()` walk nested `postfix_expr` chains to extract the callee identifier (handles `obj->method()`, `getDog()->bark()`, bare `helper()`)
- `findCalleeIdentifierNode()` returns the precise AST node for accurate `fromRanges` reporting

**Verified by**: `bun test tests/lsp/callHierarchy.test.ts` — 14 tests pass including new adversarial tests for nested calls, deduplication, and method chains.

### Transitive inherit resolution — RESOLVED

**Problem**: `resolveUnresolvedReference()` only checked direct inherit targets (one-hop). A chain like A→B→C where C references a symbol from A (grandparent) failed because resolution stopped at B.

**Fix**: Made `resolveUnresolvedReference()` recursive with `visited: Set<string>` (cycle detection) and `MAX_DEPTH = 10` (depth limit). Each target's own inherits are followed transitively.

**Verified by**: `bun test tests/lsp/crossFile.test.ts` — 21 tests pass including new test for grandparent resolution through 3-level chain.

### Cross-file rename: scope-aware filtering — RESOLVED

**Problem**: `getCrossFileReferences()` matched references by name only. Renaming `Dog.speak()` would catch `cat->speak()` references where `cat` is a `Cat`, not a `Dog`.

**Fix**: Added scope-aware filtering in `getCrossFileReferences()` for arrow/dot access references. For class members, the LHS variable's type is resolved and compared against the target's owning class name. Non-matching references are excluded.

**Remaining gap**: Bare identifier references (no receiver) are still name-only. This is conservative by design — false negatives (missing renames) are worse than false positives (extra renames the user can reject in preview).

### Variable alias type propagation — RESOLVED

**Problem**: `Dog d2 = d1;` set `assignedType = "d1"` (the variable name, not a type). Downstream type resolution would fail because `"d1"` is not a type name.

**Fix**: Added `propagateAssignedTypes()` pass (2.5) in symbol table build. Builds a map of variable name → resolved type, then iteratively replaces variable-name `assignedType` values with the actual type. Handles chains: `Dog d3 = d2 = d1 = Dog()`.

### Diagnostic column: message-aware precision — RESOLVED

**Problem**: Diagnostic columns pointed to the first meaningful token on the line, not the specific error token. For `"Undefined identifier: bark"` on `  d->bark()`, the column pointed to `d` instead of `bark`.

**Fix**: Added `messageAwareColumn()` in `diagnosticUtils.ts` that parses Pike error messages for identifier names using pattern matching (`"Undefined identifier: X"`, `"Too few arguments to X"`, etc.) and locates the matching token on the diagnostic line via source text search or tree-sitter DFS. Falls back to `lineToColumn()` when no identifier is found in the message.

### Cross-file inherited member completion — RESOLVED

**Problem**: When class `Dog` inherits from class `Animal` defined in a different file, typing `Dog d; d->` only returned `Dog`'s own members. Inherited members from `Animal` (e.g., `speak`, `get_name`) were missing from completions.

**Root cause**: The test file `tests/lsp/completion.test.ts` had two structural syntax errors that prevented the cross-file inherit completion tests from running:
1. Missing `});` closing brace on the `US-001` test (line ~988), causing it to merge with the next test.
2. An extra `});` at the end of the file (line ~1286), causing a parse error.

**Resolution**: The cross-file inheritance completion was already fully implemented in the server code — `WorkspaceIndex.resolveInheritTarget()` correctly resolves cross-file inherit targets, and the completion pipeline uses it. The tests were simply unable to run due to syntax errors. Fixed the test structure and removed the `describe.skip` placeholder.

**Verified by**: `bun test tests/lsp/completion.test.ts` — all cross-file inheritance tests pass:
- US-001: Dog d-> shows Animal members (speak, get_name, fetch)
- CB-2: 3-level chain End e-> shows Base.identify()
- US-002: No duplicate entries when child overrides parent member
- US-007: Function return type completion (makeDog()-> shows Dog members)
- US-008: Assignment inference (Dog d = makeDog(); d-> shows Dog members)

### Unicode identifiers not parsed correctly — RESOLVED

**Upstream issue**: [TheSmuks/tree-sitter-pike#1](https://github.com/TheSmuks/tree-sitter-pike/issues/1)

**Fixed in**: tree-sitter-pike commit `28a8ae8` — identifier grammar now uses `\p{L}` and `\p{N}` Unicode property escapes.

**LSP update**: WASM binary updated, test updated from "expects truncation" to "expects full Unicode identifier." No workaround code was needed — the LSP already handled partial results gracefully.

### catch expression in assignment context — RESOLVED

**Upstream issue**: [TheSmuks/tree-sitter-pike#3](https://github.com/TheSmuks/tree-sitter-pike/issues/3)

**Fixed in**: WASM binary updated 2026-05-03 — `catch_expr` now appears in the parse tree
in both standalone and assignment contexts (`mixed err = catch { ... };`).
The node has field `value` pointing to the block.

**LSP impact**: Catch-block variable scoping now works. Variables declared in catch
blocks are correctly scoped (not leaking to enclosing scope). Reference resolution and
go-to-definition work for catch-block variables.

**Implementation**: `collectCatchExpr()` in `declarationCollector.ts` pushes a `'catch'`
scope for the block. References inside catch blocks are resolved correctly via the
scope stack.

### Missing field names on for_statement children — RESOLVED

**Upstream issue**: [TheSmuks/tree-sitter-pike#2](https://github.com/TheSmuks/tree-sitter-pike/issues/2)

**Fixed in**: WASM binary updated — `for_statement` now has `body`, `condition`, and
`initializer` fields. `collectForStatement()` uses `childForFieldName('initializer')`,
`childForFieldName('condition')`, and `childForFieldName('body')` directly. No positional
scans remain.

### No scope-introducing nodes for while/switch/plain blocks — RESOLVED

**Upstream issue**: [TheSmuks/tree-sitter-pike#4](https://github.com/TheSmuks/tree-sitter-pike/issues/4)

**Fixed in**: WASM binary updated (tree-sitter-pike v1.1.1+) — `while_statement`,
`do_while_statement`, and `switch_statement` all have `body` fields.
`collectWhileStatement()`, `collectDoWhileStatement()`, and `collectSwitchStatement()`
all use `childForFieldName('body')` directly. No positional scans remain for any of these.

### Cross-file class-body identifier inherit not resolved — RESOLVED

**Problem**: wireCrossFileInheritance() only searched file-level inherit/import declarations to find the target file for a class-body inherit Animal statement. Bare identifier inherits resolved to resolve_error NOT FOUND in oracle tests.

**Fix**: Added a second resolution path in wireCrossFileInheritance() (scopeBuilder.ts) that resolves the inherit name directly via ModuleResolver when no file-level match is found. Extended warmResolverCache() (workspaceIndex.ts) to pre-warm class-body identifier inherits during async cache warmup, ensuring the sync cache adapter can find them during symbol table building. Also updated resolveInheritTarget() (workspaceIndex.ts) to correctly handle identifier inherits to .pike files by looking for a matching class declaration.

**Verification**: bun test tests/lsp/crossFileOracle.test.ts — all 5 tests pass. Identifier inherits to cross-file classes now resolve correctly.

### `.pmod` file discovery — RESOLVED

**Upstream issue**: [TheSmuks/pike-fmt#17](https://github.com/TheSmuks/pike-fmt/issues/17)

**Fixed in**: pike-fmt v0.1.5 — `findPikeFiles()` now matches `.pmod` extension.

**LSP update**: `scripts/fmt.sh` no longer needs workarounds for `.pmod` discovery.
Row 7 in the formatting table above is now marked RESOLVED.

### Configurable WASM path — RESOLVED

**Upstream issue**: [TheSmuks/pike-fmt#16](https://github.com/TheSmuks/pike-fmt/issues/16)

**Fixed in**: pike-fmt v0.1.5 — accepts `--wasm-path <path>` or `PIKE_FMT_WASM` env var.

**LSP workaround**: `scripts/fmt.sh` sets `PIKE_FMT_WASM` to point to
`dist/tree-sitter-pike.wasm`. The bundled `cli.js` has a hardcoded `__dirname`
pointing to the build machine's source path, so auto-detection fails. The env var
bypasses the broken search paths. A `postinstall` script (`scripts/postinstall-pike-fmt.js`)
also symlinks `web-tree-sitter.wasm` into `dist/` so the bundled tree-sitter runtime can find it.

### .pmod directory contents not individually introspected by harness — RESOLVED

The harness now recurses into directory-based `.pmod` modules via `listCorpusFiles()`.
Snapshot names use `--` to flatten directory separators (e.g., `cross_pmod_dir.pmod/module.pmod`
becomes `cross_pmod_dir.pmod--module`). Both child files of `cross_pmod_dir.pmod/` now have
snapshots: `cross_pmod_dir.pmod--module.json` and `cross_pmod_dir.pmod--helpers.json`.

**Implementation**: `listCorpusFiles()` in `harness/src/runner.ts` checks for `.pmod` suffix
and recurses if the path is a directory. `snapshotNameForFile()` flattens `/` to `--`.

**Verified by**: `bun test harness/__tests__/` — all snapshot tests pass for the new entries.

### Tree-sitter WASM unavailability in VSCode extension host — RESOLVED

The client-side `TreeSitterSyntacticProvider` was removed entirely. The LSP server
provides semantic tokens via the standard `textDocument/semanticTokens` protocol,
and VSCode's TextMate grammar (`pike.tmLanguage.json`) handles syntactic highlighting.
Neither requires WASM in the extension host.

**Deleted**: `client/treeSitterProvider.ts` (no longer imported by `extension.ts`).

**Impact**: No change to user-visible highlighting. Server-side semantic tokens and
TextMate grammar already covered all cases.

### Hover does not use Pike runtime for type inference — RESOLVED

**US-009 update**: The `typeof_()` method is wired into the hover provider
(`server.ts`), completion provider (`navigationHandler.ts`), and definition
provider (`navigationHandler.ts`). Member access on `mixed`-typed variables
now resolves through runtime inference.

**Impact**: Hover, completion, and definition are type-aware for `mixed`
variables when a runtime inferrer is available.

### AutoDoc hover requires save for cache population — RESOLVED

AutoDoc XML is now extracted on `textDocument/didOpen` with content-hash dedup,
not just on `textDocument/didSave`. Hover shows AutoDoc content immediately when
a file is opened, without requiring a save.

**Implementation**: `ctx.documents.onDidOpen()` handler in `navigationHandler.ts`
extracts AutoDoc on open using the same fire-and-forget pattern as didSave.

### Type resolution is same-file-only for direct class lookup — RESOLVED

`resolveCrossFileType()` in `typeResolver.ts` now uses `getOrIndexSymbolTable()`
instead of the sync `getSymbolTable()`. When the target file is not yet indexed,
this triggers on-demand indexing (same mechanism used by `resolveInheritTarget()`)
so that cross-file type resolution works even for files not yet opened in the
editor. Combined with background indexing at startup and `onDidChangeWatchedFiles`
re-indexing, the staleness window is effectively eliminated.

### No inference through function return types — RESOLVED

When `resolveMemberAccess()` encounters a call expression where the callee
resolves to a function with a `declaredType` (return type annotation), it uses
that as the type for member access. `f()->speak()` now resolves correctly when
`f()` is declared to return `Dog`.

### Arrow/dot access rename uses name-based matching for unresolved references — RESOLVED

When renaming `Dog.bark()`, cross-file `->bark` call sites are now type-filtered
via `isReceiverTypeMatch()`. References where the LHS resolves to a different
class are excluded.

**Implementation**: `getRenameLocations()` (rename.ts:255-258) applies the same
`isReceiverTypeMatch()` check for same-file refs and cross-file refs (when
`lhsName` is present in the reference).

### Rename does not rename through function return types — RESOLVED

The reference collector already produces `type_ref` references for function return
types, variable type annotations, and parameter types. `getRenameLocations()` picks
them up and includes them in the rename edit.

**Additional fix**: `collectTypeRefsRecursive()` in `referenceCollector.ts` was
extended to recurse into `array_type`, `mapping_type`, `multiset_type`,
`generic_type`, and `function_type` child nodes — bringing the generic type ref
collector to parity with `collectReturnTypeIdRecursive()`. This means renaming
`Dog` inside `array(Dog)` or `mapping(Dog:int)` now works correctly.

**Verified by**: `bun test tests/lsp/rename.test.ts` — all tests pass including:
- Renames a class and updates function return type annotations
- Renames a class inside array(Dog) variable type
- Renames a class inside mapping(Dog:int) variable type
- Renames a class and updates parameter type annotation

### Type Inference (US-008/009/010) — RESOLVED

`extractInitializerType()` in `scope-helpers.ts` now handles `cond_expr` (ternary
operator). When a ternary is encountered, both branches are examined and the
first non-primitive identifier is returned. Variables like `mixed x = condition ? Dog() : Cat();`
now get `assignedType = Dog`.

### typeof_() is only called for hover, not completion or definition — RESOLVED

`typeof_()` is wired into the hover provider (`server.ts`), completion provider
(`navigationHandler.ts`), and definition provider (`navigationHandler.ts`).
Member access on `mixed`-typed variables now resolves through runtime inference.

### PRIMITIVE_TYPES centralization is incomplete — RESOLVED

`PRIMITIVE_TYPES` is defined once in `scope-helpers.ts` and re-exported through
`symbolTable.ts`. All consumers import from the single canonical source. The
pattern duplication issue is resolved.

### Chained inference requires multiple resolveType hops with no caching — RESOLVED

`resolveType()` now uses an optional `ResolutionCache` to memoize type resolution
results within a single resolution chain. Each resolution hop checks the cache
before doing work and stores results after. Caches are created per-request
(completion/definition) and are not persisted.

### Parameter name hints blocked — tree-sitter-pike AST structure — UNBLOCKED

G2 (parameter name inlay hints at call sites) was blocked because tree-sitter-pike
did not produce dedicated AST nodes for function call arguments at statement level.
Bare function calls like `greet("Rex", 5)` were parsed as `macro_invocation_stmt`
instead of `postfix_expr` with `argument_list`.

**Fixed in**: tree-sitter-pike v1.2.2 — bare function calls at statement level now
parse as `postfix_expr` with `argument_list`. All call sites now have proper AST
structure for argument extraction.

**Upstream issue**: [TheSmuks/tree-sitter-pike#18](https://github.com/TheSmuks/tree-sitter-pike/issues/18)
