## [Unreleased]

### Added

**Formatting layer architecture**: Added three-component formatting system:
`client/language-configuration.json` (client-side indentation rules),
`server/src/features/formattingHandler.ts` (LSP thin wrapper to pike-fmt),
`server.ts` (registered `documentFormattingProvider`). Phase 1 scope:
indentation normalization only. pike-fmt is a separate repository (WIP).

**Corpus expansion: 5 new P1 corpus files** covering constant declarations,
`.pmod` directory module imports, typed function parameters, `#define`/`#ifdef`
preprocessor directives, and `#include` directive resolution.

**Rename through function return types**: Renaming a class now also updates
function return type annotations. Renaming `Dog` → `Cat` also renames `Dog f()`
→ `Cat f()`. Added `collectFunctionReturnTypeRefs()` to collect return type
references, with location deduplication in `getReferencesTo()`.

### Changed

**CI**: Upgraded `actions/cache` from v4 to v5.

## [0.2.0-beta] - 2026-05-04

## [0.2.0-beta] - 2026-05-04

### Added

**Diagnostic quality improvements**: Parse diagnostics now have tighter ERROR node ranges
(single token instead of full recovery span), context-aware error messages, and numeric
diagnostic codes (P1xxx for parse, P2xxxx for Pike compiler). Parse diagnostics on
lines with Pike diagnostics are suppressed to avoid duplication.

### Fixed

**Dead formatter.ts removed**: Orphaned 244-line `server/src/features/formatter.ts`
was removed. The file was marked as removed in Phase 18 but persisted on disk.
All formatting functionality is deferred per Decision 0020.

**Dead import in navigationHandler.ts**: Removed unused `SEMANTIC_TOKENS_LEGEND` import.

**Stale TODO in referenceCollector.ts**: Updated to reference known-limitations doc.

**Test infrastructure critical bug**: `createTestServer()` in `tests/lsp/helpers.ts`
now sends `processId: null` in the `initialize` request. The vscode-languageserver
watchdog requires this field; omitting it caused `kill(undefined)` to be called,
making 16 of 34 LSP test files hang indefinitely.

**Syntax error in completion.test.ts**: Fixed missing closing braces that caused
test suite to fail. Also fixed `dead-code` and `unused-import` violations surfaced
by the corrected test suite.

**Unused imports across codebase**: Removed 8 unused imports in 6 files.

### Changed

All unreleased changes from Phases 17-21 are now part of this release:

**Diagnostic quality**: Parse diagnostics have tighter ERROR node ranges,
context-aware error messages, and numeric codes (P1xxx/P2xxxx). Duplicate
diagnostics on Pike-error lines are suppressed.

**Test infrastructure**: Fixed `createTestServer()` to send `processId: null`
(16 previously-hanging test files now pass). Fixed syntax error in
`completion.test.ts` (missing closing braces).

**Rename improvements**: Cross-file type filtering on arrow/dot access,
early-return bug fixed (same-file refs were skipped when cross-file refs existed).

**Hover improvements**: AutoDoc XML now extracted on `didOpen` (no save required),
ternary operator `assignedType`, function return type propagation, resolution
caching.

**Type inference**: PikeWorker `typeof_()` wired to completion and definition,
`mixed`/`auto` variables can now complete and go-to-def. Assignment-based
type narrowing, `typeof_()` fallback for hover.

**Completion improvements**: Declared-type member completion (`Animal a; a->`),
3-level cross-file inheritance chain completion, protected symbol rejection
(283 predef builtins, 5,471 stdlib names).

**Diagnostics**: Column-aware Pike compilation errors via tree-sitter
`lineToColumn()` helper. Three modes: realtime (default), saveOnly, off.

**Additional features**: Semantic tokens, document highlights, folding ranges,
signature help, code actions, workspace symbol search, background indexing
with progress, persistent cross-restart cache, VSCode configuration change
handler, cancellation token propagation.

**Performance**: Incremental tree-sitter parsing with LRU cache (50 entries /
50 MB ceiling), PikeWorker FIFO queue with backpressure, auto-restart on
malformed responses, event-loop yielding for large files.

**Code quality**: Audit round 2 (20 fixes), audit round 3 (10 fixes),
dead code removal from hoverHandler.ts, scopeBuilder.ts (749→276 lines),
xmlParser.ts (836→201 lines).

**Docs**: Known-limitations.md updated, state-of-project.md updated to Phase 21,
Decision documents 0014, 0018, 0019, 0020, 0021, 0022.

### Chore

- Remove unused variables and imports across 6 files
- PikeDiagnostic interface: added optional `code` field
- Documentation cleanup: TRACKING.md updated through Phase 21

## Phase 21: Known Limitations Fixed - 2026-05-03

### Fixed

**~~Unicode identifiers not parsed correctly~~**: tree-sitter-pike commit `28a8ae8`
added Unicode property escapes (`\p{L}`, `\p{N}`) to the identifier grammar rule.
WASM binary updated; LSP now handles full Unicode identifiers.

**~~catch expression in assignment context~~**: WASM binary updated — `catch_expr`
now appears in the parse tree in both standalone and assignment contexts.
`collectCatchExpr()` in `declarationCollector.ts` now handles assignment context.

**for_statement missing initializer field**: `for_statement` now has `body` and
`condition` fields. `initializer` field still missing; positional scan workaround
remains in `collectForStatement()`.

**while/do-while missing body field**: `while_statement` and `do_while_statement`
now have `body` fields. `collectWhileStatement()` and `collectDoWhileStatement()`
use `childForFieldName('body')` directly.

**switch_statement missing body field**: `switch_statement` still lacks `body` field.
Positional scan workaround remains in `collectSwitchStatement()`.

### Changed

**WASM binary updated**: Built from latest tree-sitter-pike grammar with field name fixes
for `for_statement`, `while_statement`, `do_while_statement`, and `switch_statement`.
Updated `server/dist/tree-sitter-pike.wasm`.

### Added

**cross-inherit-chain test suite**: Added 5 corpus files and harness snapshots for
3-level inheritance chain (A inherits B inherits C). Tests verify that member access
through the chain works at all levels.

**Precomputed cross-inherit-chain-resolve snapshots**: Added oracle-verified ground
truth for `cross-inherit-chain-a.pike`, `cross-inherit-chain-b.pike`,
`cross-inherit-chain-c.pike`.

### Docs

**Known-limitations.md**: Consolidated permanent limitations (.so modules, joinnode,
import resolution) with "PERMANENT" markers. Added upstream issue links for
tree-sitter-pike #1, #2, #3, #4.

## Phase 20b: Cross-File Inheritance Chain + Diagnostic Columns - 2026-05-03

### Fixed

**Cross-file class-body identifier inherit not resolved**: Added second resolution path
in `wireCrossFileInheritance()` that resolves inherit name via `ModuleResolver` when
no file-level match is found. Extended `warmResolverCache()` to pre-warm class-body
identifier inherits during async cache warmup.

**Diagnostic column positions are approximate**: Added `lineToColumn()` helper that
locates the first meaningful token on the diagnostic's line using tree-sitter.
Both `mergeDiagnostics` call sites now pass the parsed tree for column resolution.

### Changed

**Diagnostics**: Pike compiler diagnostics now display with approximate column positions
(pointing to first meaningful token). Parse diagnostics (tree-sitter errors) retain
precise column positions.

**Reference collector**: Refactored to use a single `_collectAllReferences()` helper
that unifies same-file and cross-file collection. Simplified `getReferencesTo()` to
delegate to `_collectAllReferences()`.

### Added

**cross-inherit-chain corpus files**: `cross-inherit-chain-a.pike`,
`cross-inherit-chain-b.pike`, `cross-inherit-chain-c.pike` for 3-level
inheritance testing.

**Diagnostic column test**: Added test in `diagnostics.test.ts` verifying column
resolution for Pike compiler errors.

## Phase 20: tree-sitter-pike Workarounds Removed - 2026-05-03

### Fixed

**~~Unicode identifiers not parsed correctly~~ — RESOLVED**: tree-sitter-pike grammar
now accepts Unicode identifiers via `\p{L}` and `\p{N}` property escapes.

**~~for_statement missing initializer field~~ — PARTIALLY RESOLVED**: `body` and
`condition` fields added. `initializer` field still missing; positional scan remains.

**~~No scope-introducing nodes for while/switch/plain blocks~~ — MOSTLY RESOLVED**:
`while_statement` and `do_while_statement` now have `body` fields. `switch_statement`
`body` field still missing; positional scan remains.

### Added

**Stdlib corpus files**: `stdlib-fileio.pike` covering `Stdio.File`,
`Stdio.read_file`, `Stdio.write_file`.

**Diagnostic code field**: Added numeric diagnostic codes to Pike compiler diagnostics
(P2xxxx range) for IDE integration.

## Phase 17: Type-Aware Completion and Definition - 2026-05-03

### Fixed

**Type resolution through function return types**: `resolveMemberAccess()` now uses
`declaredType` from call expressions to resolve member access on return values.
`f()->speak()` resolves correctly when `f()` is declared to return `Dog`.

**Type annotation renaming**: Renaming `Dog` now updates function return type
annotations. `collectFunctionReturnTypeRefs()` collects all `Dog` references in
type annotation positions within function declarations.

**PRIMITIVE_TYPES centralization**: `PRIMITIVE_TYPES` moved to `scope-helpers.ts`
and re-exported through `symbolTable.ts`. All consumers now import from single
canonical source.

### Changed

**Type inference chain caching**: `resolveType()` now uses an optional `ResolutionCache`
to memoize results within a single resolution chain. Each hop checks cache before
doing work. Caches are per-request (completion/definition) and not persisted.

**Hover handler**: Tier 1 (AutoDoc), Tier 2 (stdlib index), Tier 3 (tree-sitter)
routing with predef builtin fallback. `renderPredefSignature()` strips scope/attribute
wrappers for cleaner display.

**Completion provider**: Three-tier resolution (symbol table → cross-file → stdlib).
Reuses same `ResolutionCache` mechanism as hover for consistent type inference.

**Reference collector**: Single `_collectAllReferences()` helper for same-file and
cross-file. Type-filtered for cross-file when `lhsName` is present.

### Removed

**Dead formatter.ts**: Orphaned 244-line `server/src/features/formatter.ts` removed.
The file was marked as removed in Phase 18 but persisted on disk.

**Dead code in scope-helpers.ts**: `hasProhibitedModifier()` was dead code (never called)
— removed along with `PROHIBITED_MODIFIERS`.

**Dead `scope-helpers.ts` import in declarationCollector.ts**: Unused import removed.

### Refactored

**scopeBuilder.ts**: Reduced from 749 to 276 lines by extracting type inference to
`typeResolver.ts` and scope helpers to `scope-helpers.ts`. Re-exports from `scope-helpers.ts`.

**xmlParser.ts**: Reduced from 836 to 201 lines by extracting XML extraction logic
into Pike-specific helpers. Removed generic parsing framework.

**referenceCollector.ts**: Unified same-file and cross-file collection into single
`_collectAllReferences()` helper. Simplified `getReferencesTo()`.

### Changed

**Symbol table**: Added `assignedType` field for variables initialized with simple
constructors or ternary expressions. Enables type resolution for `mixed`-typed
variables without explicit annotations.

**Type resolver**: Added `resolveType()` for walking initializer expressions.
Added `extractInitializerType()` for constructors and ternary operators.

**Declaration collector**: Added `collectForStatement()` for `for` loop variable
scoping. Added `collectCatchExpr()` for catch block scoping.

**Hover handler**: Type inferrer wired to `PikeWorker.typeof_()` for runtime
type inference on `mixed` variables.

**Completion provider**: `CompletionContext` now tracks resolver state for
multi-hop type chains.

**Scope helpers**: `isScopeBoundary()` now returns `false` for all statement types
(no scope boundaries inside blocks). `BLOCK_SCOPES` removed.

**`typeof_()` wiring**: Called for hover, completion, and definition. Falls back
to tree-sitter declared types when PikeWorker is unavailable.

## Phase 18: Housekeeping and Debt Reduction - 2026-05-03

### Removed

**formatter.ts**: Dead 244-line file. Formatting deferred to pike-fmt per Decision 0020.

**Dead exports from symbolTable.ts**: `getDefinitionAt()` and `isLocalDeclaration()`
removed — unused after refactoring.

### Refactored

**scopeBuilder.ts**: Extracted type inference to separate modules. Re-exports
helpers from `scope-helpers.ts`.

**xmlParser.ts**: Removed generic XML parsing framework. Pike-specific extraction
now in focused helpers.

### Changed

**Type inference**: Added `ResolutionCache` for memoization within resolution chains.
Handles constructor calls and ternary operators in initializers.

**Hover**: Predef builtin signatures from `predef-builtin-index.json` (283 symbols).
Rendered via `renderPredefSignature()`.

**Reference collection**: Type-filtered cross-file references when `lhsName` is present.

**Scope boundaries**: `isScopeBoundary()` simplified — no scope boundaries inside blocks.
`BLOCK_SCOPES` set removed.
