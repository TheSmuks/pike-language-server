# Known Limitations

## Resolved Upstream Issues

### ~~Unicode identifiers not parsed correctly~~ — RESOLVED

**Upstream issue**: [TheSmuks/tree-sitter-pike#1](https://github.com/TheSmuks/tree-sitter-pike/issues/1)

**Fixed in**: tree-sitter-pike commit `28a8ae8` — identifier grammar now uses `\p{L}` and `\p{N}` Unicode property escapes.

**LSP update**: WASM binary updated, test updated from "expects truncation" to "expects full Unicode identifier." No workaround code was needed — the LSP already handled partial results gracefully.

## Current Upstream Limitations

### ~~catch expression in assignment context~~ — RESOLVED

**Upstream issue**: [TheSmuks/tree-sitter-pike#3](https://github.com/TheSmuks/tree-sitter-pike/issues/3)

**Fixed in**: WASM binary updated 2026-05-03 — `catch_expr` now appears in the parse tree
in both standalone and assignment contexts (`mixed err = catch { ... };`).
The node has field `value` pointing to the block.

**LSP impact**: Catch-block variable scoping now works. Variables declared in catch
blocks are correctly scoped (not leaking to enclosing scope). Reference resolution and
go-to-definition work for catch-block variables.

**Implementation**: `collectCatchExpr()` in `declarationCollector.ts` pushes a `'catch'`
scope for the block. `'catch_expr'` added to `BLOCK_SCOPES` for nested reference resolution.

### pike-ai-kb: pike-signature cannot resolve C-level predef builtins

**Upstream issue**: [TheSmuks/pike-ai-kb#11](https://github.com/TheSmuks/pike-ai-kb/issues/11)

The `pike-signature` MCP tool uses `master()->resolv()` for symbol lookup, which does not find C-level predef builtins (`write`, `werror`, `arrayp`, `all_constants`, etc.). The fix requires adding an `all_constants()` fallback to `pikeResolvePreamble()` in `src/pike-helpers.ts`.

**LSP impact**: None currently. The LSP's predef builtin index (`predef-builtin-index.json`, 283 symbols) provides hover coverage for these symbols. When pike-ai-kb adds the fallback, the LSP could route additional type queries through it for richer signatures.

### ~~Missing field names on for_statement children~~ — PARTIALLY RESOLVED

**Upstream issue**: [TheSmuks/tree-sitter-pike#2](https://github.com/TheSmuks/tree-sitter-pike/issues/2)

**Fixed in**: WASM binary updated 2026-05-03 — `for_statement` now has `body` and
`condition` fields. `childForFieldName('body')` and `childForFieldName('condition')` work.

**Still present**: `for_statement` has no `initializer` field. The positional child scan for
`for_init_decl` in `collectForStatement()` is still required.

**Workaround**: `collectForStatement()` walks `node.children` directly, checking
`child.type === 'for_init_decl'`. For `for_init_decl`, `childrenForFieldName('name')` correctly
extracts variable name identifiers.

### ~~No scope-introducing nodes for while/switch/plain blocks~~ — MOSTLY RESOLVED

**Upstream issue**: [TheSmuks/tree-sitter-pike#4](https://github.com/TheSmuks/tree-sitter-pike/issues/4)

**Fixed in**: WASM binary updated 2026-05-03 — `while_statement` and `do_while_statement`
now have `body` fields. `collectWhileStatement()` and `collectDoWhileStatement()` use
`childForFieldName('body')` directly. No more positional scans needed for these two.

**Still present**: `switch_statement` has no `body` field. The positional scan for the
block in `collectSwitchStatement()` is still required. The `value` field (switch expression)
works correctly.

**Workaround**: `collectWhileStatement()` and `collectDoWhileStatement()` use field names
directly. `collectSwitchStatement()` uses a positional scan for the block.


### ~~Cross-file class-body identifier inherit not resolved~~ — RESOLVED

**Problem**: wireCrossFileInheritance() only searched file-level inherit/import declarations to find the target file for a class-body inherit Animal statement. Bare identifier inherits resolved to resolve_error NOT FOUND in oracle tests.

**Fix**: Added a second resolution path in wireCrossFileInheritance() (scopeBuilder.ts) that resolves the inherit name directly via ModuleResolver when no file-level match is found. Extended warmResolverCache() (workspaceIndex.ts) to pre-warm class-body identifier inherits during async cache warmup, ensuring the sync cache adapter can find them during symbol table building. Also updated resolveInheritTarget() (workspaceIndex.ts) to correctly handle identifier inherits to .pike files by looking for a matching class declaration.

**Verification**: bun test tests/lsp/crossFileOracle.test.ts — all 5 tests pass. Identifier inherits to cross-file classes now resolve correctly.

## Cross-File Resolution Limitations (Phase 4)

### No .so binary module resolution

The ModuleResolver skips `.so` (compiled C module) files. System modules that are pure C (e.g., `_Stdio`, `__builtin`) cannot be resolved by path lookup. This affects completion and go-to-definition for low-level system types.

**Mitigation**: Most commonly used stdlib modules (Stdio, Array, Mapping, etc.) are implemented in Pike (.pmod files) and resolve correctly. Pure C modules could be handled in a future phase via pike-ai-kb or a pre-built system module map.

### No joinnode multi-path merge

Pike's `joinnode` class merges symbols from multiple search paths when the same module name exists in multiple locations. The LSP uses first-match-wins instead. If a workspace contains a module with the same name as a system module, the workspace version takes precedence.

**Impact**: Rare in practice. Workspace modules overriding system modules matches user expectation.

### Import resolution is scoped to file-system paths

Import resolution searches workspace and system module paths. It does not query Pike at runtime. Dynamic module behavior (modules that register symbols at compile time) is not captured.

**Impact**: Low for standard Pike code. Dynamic modules are rare in user workspaces.

### .pmod directory contents not individually introspected by harness

The harness has snapshots for file-based `.pmod` modules (`cross_import_a.pmod`, `cross_lib_module.pmod`) with full symbol extraction from Pike. However, directory-based `.pmod` modules (`cross_pmod_dir.pmod/`) are not individually introspected.

**Corpus .pmod inventory:**
- `cross_import_a.pmod` — FILE (26 lines). Harness snapshot: YES. Ground truth: Pike oracle.
- `cross_lib_module.pmod` — FILE (22 lines). Harness snapshot: YES. Ground truth: Pike oracle.
- `cross_pmod_dir.pmod/` — DIRECTORY (2 entries: `module.pmod`, `helpers.pike`). Harness snapshot: NO. Not introspected.
- `cross_pmod_dir.pmod/module.pmod` — child of directory module. Harness snapshot: NO.
- `cross_pmod_dir.pmod/helpers.pike` — child of directory module. Harness snapshot: NO.

**What works:** File-based `.pmod` modules are fully tested via harness snapshots. The LSP's documentSymbol output for `cross_import_a.pmod` is compared against Pike's introspection.

**What's missing:** Directory module member enumeration. The LSP's cross-file tests only verify that `cross-pmod-user.pike` indexes successfully. They don't verify that the LSP discovers the same members from `cross_pmod_dir.pmod/` that Pike resolves. This is a semantic correctness gap.

**Phase 5 prerequisite:** Build `harness/resolve.pike` to introspect directory modules and cross-file member availability.
## Phase 5: Diagnostics and Hover Limitations

### Diagnostics are real-time with debouncing (Phase 6 P2)

Diagnostics from the Pike compiler are triggered on `textDocument/didChange` (debounced at 500ms) and `textDocument/didSave` (immediate). Three modes: realtime, saveOnly, off. Decision 0013.

**Configuration**: `initializationOptions.diagnosticMode` in the `initialize` request. Default: `realtime`.

**Verified**: 50 rapid didChange events produce ≤ 3 diagnose invocations. Hover latency unaffected during in-flight diagnose. See `decisions/0013-verification.md`.

### Diagnostic column positions are approximate

Pike's `compile_error` handler reports line numbers but not column positions. When Pike emits a diagnostic, the `character` field was always 0, making underlines span the entire line.

**Resolution (Phase 20b)**: Added `lineToColumn()` helper that locates the first meaningful token on the diagnostic's line using tree-sitter and returns its column offset. Both `mergeDiagnostics` call sites now pass the parsed tree.

**Remaining gap**: The column is approximate — it points to the first meaningful token on the line, not to the specific error token. For Pike compiler diagnostics, this is the best available signal. Parse diagnostics (tree-sitter errors) already have precise column positions.

### ~~Hover does not use Pike runtime for type inference~~ — RESOLVED

**US-009 update**: The `typeof_()` method is wired into the hover provider
(`server.ts`), completion provider (`navigationHandler.ts:565`), and definition
provider (`navigationHandler.ts:397`). Member access on `mixed`-typed variables
now resolves through runtime inference.

**Impact**: Hover, completion, and definition are type-aware for `mixed`
variables when a runtime inferrer is available.

### Stdlib hover: C-level builtins not indexed

The stdlib index (5,471 symbols) covers Pike source files only. C-level builtins (`write`, `werror`, `arrayp`, `all_constants`, etc.) are not in Pike source files and are not indexed. These symbols return null hover from Tier 2.

**Fallback path**: pike-ai-kb `pike-signature` tool — blocked on [TheSmuks/pike-ai-kb#11](https://github.com/TheSmuks/pike-ai-kb/issues/11) (C-level predef resolution gap). The LSP's predef builtin index (283 symbols from runtime introspection) covers the gap for now.

**Resolution**: Build a supplementary index from Pike's C source or Pike reference documentation.

**Current state**: `predef-builtin-index.json` (283 symbols) is a temporary workaround. When [TheSmuks/pike-ai-kb#11](https://github.com/TheSmuks/pike-ai-kb/issues/11) ships its `all_constants()` fallback, evaluate removing the predef index in favor of kb queries.
### ~~AutoDoc hover requires save for cache population~~ — RESOLVED

AutoDoc XML is now extracted on `textDocument/didOpen` with content-hash dedup,
not just on `textDocument/didSave`. Hover shows AutoDoc content immediately when
a file is opened, without requiring a save.

**Implementation**: `ctx.documents.onDidOpen()` handler in `navigationHandler.ts`
extracts AutoDoc on open using the same fire-and-forget pattern as didSave.
### AutoDoc hover coverage depends on codebase conventions

AutoDoc hover only works for symbols documented with `//!` comments. PikeExtractor produces XML only for documented symbols. In codebases without documentation conventions, hover falls through to tree-sitter declared types.

**Corpus coverage**: 5 docgroups across 2 files — only `autodoc-documented.pike` and `compat-pike78.pike` have `//!` comments.

## Phase 7: Type Resolution Limitations

### ~~Type resolution requires explicit type annotations~~ — PARTIALLY RESOLVED (US-008)

**US-008 update**: The symbol table now captures `assignedType` from simple initializer expressions. When a variable is declared as `mixed x = Dog()`, `assignedType` is set to `Dog`, enabling type resolution through the existing `resolveType()` pipeline.

**Remaining gap**: Variables initialized by assignment (not declaration) are
not covered by `assignedType`. Complex expressions that don't reduce to a
simple constructor or ternary call still require explicit type annotations.

**Impact**: Arrow/dot member completion and go-to-definition now work for
variables initialized with simple constructors or ternary expressions, even when
declared as `mixed`. Other complex initializers still require explicit annotations.
### Type resolution is same-file only for direct class lookup

`resolveType()` finds classes in the same file first, then falls through to cross-file resolution and stdlib. But cross-file resolution depends on the WorkspaceIndex having the target file indexed. If the target file hasn't been opened or changed since indexing, the resolution may return null.

### ~~No inference through function return types~~ — RESOLVED

When `resolveMemberAccess()` encounters a call expression where the callee
resolves to a function with a `declaredType` (return type annotation), it uses
that as the type for member access. `f()->speak()` now resolves correctly when
`f()` is declared to return `Dog`.

## Phase 8: Rename Limitations

### ~~Arrow/dot access rename uses name-based matching for unresolved references~~ — RESOLVED

When renaming `Dog.bark()`, cross-file `->bark` call sites are now type-filtered
via `isReceiverTypeMatch()`. References where the LHS resolves to a different
class are excluded.

**Implementation**: `getRenameLocations()` (rename.ts:255-258) applies the same
`isReceiverTypeMatch()` check for same-file refs and cross-file refs (when
`lhsName` is present in the reference).

### Rename does not rename through function return types

If `makeDog()` returns `Dog`, renaming `Dog` class won't update the return type annotation of `makeDog()`. Type annotation renaming is not implemented.

## Resolved: Type Inference (US-008/009/010)

`extractInitializerType()` in `scope-helpers.ts` now handles `cond_expr` (ternary
operator). When a ternary is encountered, both branches are examined and the
first non-primitive identifier is returned. Variables like `mixed x = condition ? Dog() : Cat();`
now get `assignedType = Dog`.

### ~~typeof_() is only called for hover, not completion or definition~~ — RESOLVED

`typeof_()` is wired into the hover provider (`server.ts`), completion provider
(`navigationHandler.ts:565`), and definition provider (`navigationHandler.ts:397`).
Member access on `mixed`-typed variables now resolves through runtime inference.
### ~~PRIMITIVE_TYPES centralization is incomplete~~ — RESOLVED

`PRIMITIVE_TYPES` is defined once in `scope-helpers.ts` and re-exported through
`symbolTable.ts`. All consumers import from the single canonical source. The
pattern duplication issue is resolved.

### ~~Chained inference requires multiple resolveType hops with no caching~~ — RESOLVED

`resolveType()` now uses an optional `ResolutionCache` to memoize type resolution
results within a single resolution chain. Each resolution hop checks the cache
before doing work and stores results after. Caches are created per-request
(completion/definition) and are not persisted.


### pike-introspect Availability Dependency

The `PikeWorker.resolve()` method depends on pike-introspect v0.2.0 being installed via `pmp install`.
The worker spawns with `-M modules/Introspect/src/` to find the module. If pike-introspect is not
installed, `resolve` calls will fail with an error message.

**Mitigation**: The worker starts successfully without pike-introspect — only `resolve` calls fail.
CI installs pike-introspect via `pmp install` after the pmp step in `.github/workflows/ci.yml`.

**pmp module path limitation**: pmp symlinks `modules/Introspect -> store-root` but Pike needs
`-M modules/Introspect/src/`. Filed as TheSmuks/pmp#42. Workaround: explicit `-M` path in spawn args.