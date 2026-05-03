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
### No column-level diagnostic positions

Pike's CompilationHandler reports line numbers but not column positions. LSP diagnostics from Pike always have `character: 0`.

**Impact**: Underlines span the entire line rather than the specific token. Parse diagnostics (from tree-sitter) do have column-level positions.

### ~~Hover does not use Pike runtime for type inference~~ — PARTIALLY RESOLVED (US-009)

**US-009 update**: The `typeof_()` method is now connected to hover responses (`server.ts`). When a variable is declared as `mixed` or has no type annotation, hover calls `typeof_()` to get the runtime-inferred type. Variables with explicit type annotations still use declared types.

**Remaining gap**: `typeof_()` is only invoked for hover, not for completion or go-to-definition. Member access completion on `mixed`-typed variables still cannot resolve through the runtime.

**Impact**: Hover on `mixed`/untyped variables now shows the inferred type in many cases. Member completion and definition lookup on the same variables remain unresolved.

### Stdlib hover: C-level builtins not indexed

The stdlib index (5,471 symbols) covers Pike source files only. C-level builtins (`write`, `werror`, `arrayp`, `all_constants`, etc.) are not in Pike source files and are not indexed. These symbols return null hover from Tier 2.

**Fallback path**: pike-ai-kb `pike-signature` tool — blocked on [TheSmuks/pike-ai-kb#11](https://github.com/TheSmuks/pike-ai-kb/issues/11) (C-level predef resolution gap). The LSP's predef builtin index (283 symbols from runtime introspection) covers the gap for now.

**Resolution**: Build a supplementary index from Pike's C source or Pike reference documentation.

**Current state**: `predef-builtin-index.json` (283 symbols) is a temporary workaround. When [TheSmuks/pike-ai-kb#11](https://github.com/TheSmuks/pike-ai-kb/issues/11) ships its `all_constants()` fallback, evaluate removing the predef index in favor of kb queries.

### AutoDoc hover requires save for cache population

AutoDoc XML is extracted on `didSave` and cached. Before the first save of a file, hover falls through to tree-sitter (Tier 3). This means new files opened but never saved will not have AutoDoc hover.

**Rationale**: The Pike worker extracts AutoDoc from source text (no file I/O needed), but the extraction is triggered by the save pipeline. Adding extraction on `didOpen` would require worker startup on file open.

### AutoDoc hover coverage depends on codebase conventions

AutoDoc hover only works for symbols documented with `//!` comments. PikeExtractor produces XML only for documented symbols. In codebases without documentation conventions, hover falls through to tree-sitter declared types.

**Corpus coverage**: 5 docgroups across 2 files — only `autodoc-documented.pike` and `compat-pike78.pike` have `//!` comments.

## Phase 7: Type Resolution Limitations

### ~~Type resolution requires explicit type annotations~~ — PARTIALLY RESOLVED (US-008)

**US-008 update**: The symbol table now captures `assignedType` from simple initializer expressions. When a variable is declared as `mixed x = Dog()`, `assignedType` is set to `Dog`, enabling type resolution through the existing `resolveType()` pipeline.

**Remaining gap**: `assignedType` only captures simple constructor calls (`Dog()`, `makeDog()`). Complex expressions (ternary, arithmetic, function calls returning untyped results) are not handled. Variables initialized by assignment (not declaration) are also not covered.

**Impact**: Arrow/dot member completion and go-to-definition now work for variables initialized with simple constructors, even when declared as `mixed`. Complex initializers still require explicit type annotations.

### Type resolution is same-file only for direct class lookup

`resolveType()` finds classes in the same file first, then falls through to cross-file resolution and stdlib. But cross-file resolution depends on the WorkspaceIndex having the target file indexed. If the target file hasn't been opened or changed since indexing, the resolution may return null.

### No inference through function return types

If a function returns `Animal`, calling `f()->speak()` cannot resolve `speak` because the return type is not tracked. Only direct declared types on variables and parameters are used.

**US-008 note**: `assignedType` captures initializer types for variables, but function return type propagation is not implemented. Chained inference (`a()->b()->c()`) requires multiple `resolveType` hops with no caching, and the `MAX_RESOLUTION_DEPTH` (5) limits deeply chained calls.

## Phase 8: Rename Limitations

### Arrow/dot access rename uses name-based matching for unresolved references

When renaming `bark()` on class `Dog`, all `->bark` call sites are included regardless of the object's type. If another class also has a `bark()` method, `otherObj->bark()` would be renamed too.

**Impact**: Low in practice — different classes rarely share method names in the same scope, and the rename preview allows users to verify before applying.

### Rename does not rename through function return types

If `makeDog()` returns `Dog`, renaming `Dog` class won't update the return type annotation of `makeDog()`. Type annotation renaming is not implemented.

## Phase 10/11: Type Inference Gaps (US-008/009/010)

### assignedType only captures simple constructor calls

`extractInitializerType()` in `symbolTable.ts` extracts types from initializers, but only handles simple constructor patterns (`Dog()`, `makeDog()`). Complex expressions — ternary operators, arithmetic, function calls returning untyped results, chained calls — are not parsed for type information.

**Impact**: Variables like `mixed x = condition ? Dog() : Cat();` get no `assignedType`. Only the straightforward `mixed x = Dog();` pattern is covered.

### typeof_() is only called for hover, not completion or definition

US-009 connected `typeof_()` to the hover pipeline, but the completion and go-to-definition features do not invoke it. A `mixed`-typed variable with a runtime-inferred type will show the correct type on hover but still produce no completions after `->`.

**Impact**: Hover is type-aware for `mixed` variables; completion and definition remain annotation-only.

### PRIMITIVE_TYPES centralization is incomplete

`PRIMITIVE_TYPES` is defined once in `symbolTable.ts` and imported by `completion.ts`, `typeResolver.ts`, and `server.ts` (3 import sites). This works but means any modification to the primitive set requires verifying all consumers. No single canonical source of truth beyond the one definition.

**Impact**: Low — the set is stable. But the pattern of `declaredType && !PRIMITIVE_TYPES.has(declaredType) ? declaredType : assignedType` is duplicated in three files, creating a maintenance risk if the fallback logic changes.

### Chained inference requires multiple resolveType hops with no caching



**Impact**: Performance degrades on deeply chained access. The depth limit (5) caps the worst case but also limits correctness for legitimate deep chains.


### pike-introspect Availability Dependency

The `PikeWorker.resolve()` method depends on pike-introspect v0.2.0 being installed via `pmp install`.
The worker spawns with `-M modules/Introspect/src/` to find the module. If pike-introspect is not
installed, `resolve` calls will fail with an error message.

**Mitigation**: The worker starts successfully without pike-introspect — only `resolve` calls fail.
CI installs pike-introspect via `pmp install` after the pmp step in `.github/workflows/ci.yml`.

**pmp module path limitation**: pmp symlinks `modules/Introspect -> store-root` but Pike needs
`-M modules/Introspect/src/`. Filed as TheSmuks/pmp#42. Workaround: explicit `-M` path in spawn args.