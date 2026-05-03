## [Unreleased]


## Phase 16: pike-introspect Integration - 2026-05-03

### Added

- **pike-introspect v0.2.0 integration**: New `resolve` method in worker.pike using
  `Introspect.Discover.resolve_symbol()` and `Introspect.Describe.describe_program()` for
  runtime-backed symbol resolution with source locations and inheritance chains
- **`PikeWorker.resolve()` in TypeScript**: New `ResolveResult` interface and async `resolve()`
  method exposing cross-file symbol resolution to callers
- **Worker spawn args updated**: Added `-M modules/Introspect/src/` so the Pike worker can find
  the Introspect module
- **7 new resolve tests**: Tests for Stdio.File, Stdio.read_file, Stdio module, unknown symbol,
  empty symbol, inheritance info, and worker lifecycle after resolve
- **Decision 0019 updated**: Documented v0.2.0 features (resolve_symbol, describe_program with
  source locations and inheritance), updated conclusions, added Phase 16 implementation notes

### Changed

- **Template upgrade**: ai-project-template from v0.2.0 to v0.6.0
  - Added OMP skills: merge-to-main, cut-release, setup, template-guide
  - Added OMP rules: no-placeholders, changelog-required, conventional-commits
  - Added OMP hooks: protect-main, template-compliance-hint
  - Added OMP tool: template-audit
  - Added GitHub workflow: branch-cleanup.yml
  - Added docs: omp-extensions-guide.md, agent-files-guide.md
  - Updated AGENTS.md and docs/ci.md with new structure

- Type-aware arrow/dot rename: rename now checks receiver type before including
  arrow/dot references, preventing cross-class rename of same-name methods
- Runtime type inference for completion and definition: `typeof_()` is called
  when static type resolution fails for `mixed`/`auto` variables
- `resolveTypeName()` utility: centralized type priority chain (declaredType >
  assignedType > null), replacing duplicated ternary in 3 files
- `collectClassMembers()` and exported `findClassScope()` from typeResolver
  for correct class scope lookup using `containsRange`
- `typeInferrer` callback on TypeResolutionContext and CompletionContext
  for async runtime type inference through PikeWorker

### Changed

- `findMemberInClass()` and `findMemberInInheritedScopes()` now use
  `containsRange(classDecl.range, scope.range)` instead of
  `posInRange(scope.range, nameRange.start)`, fixing nested class disambiguation
- `getRenameLocations()` is now async for type-aware filtering
- All 28 empty `catch {}` blocks in server/src/ now have explanatory comments
- Removed dead `rangeContains()` from completionTrigger.ts
- Removed unused imports (`Range`, `getDeclarationsInScope`) from completionTrigger.ts

### Added

- Type inference: assignment-based type narrowing (`assignedType` field on Declaration, `extractInitializerType`, `PRIMITIVE_TYPES` set)
- PikeWorker typeof integration for hover on mixed/auto-typed variables
- Type inference corpus files (4 new .pike files) and harness snapshots
- Semantic tokens: 9 token types + 5 modifiers, function→method promotion in class scope
- Semantic token LSP handler (textDocument/semanticTokens/full) with delta encoding
- Document highlight handler (textDocument/documentHighlight) with Write/Read kinds
- Folding range handler (textDocument/foldingRange) for blocks, classes, comment groups
- Signature help handler (textDocument/signatureHelp) with parameter tracking
- Code actions: remove unused variable, add missing stdlib import (extensible quick-fix registry)
- Workspace symbol search (workspace/symbol) with case-insensitive prefix matching
- Background workspace indexing on startup with progress reporting
- Persistent cache across LSP restarts (symbol table serialization + WASM hash invalidation)
- VSCode configuration change handler (didChangeConfiguration) for diagnostic settings
- Cancellation token propagation to all LSP request handlers
- Decision documents: 0019 (type inference), 0020 (semantic tokens), 0021 (signature help), 0022 (background indexing)

### Changed


- Audit remediation round 2: correctness and robustness fixes across 10 files:
  - `symbolTable.ts`: for-init and foreach-lvalue collection now use grammar field names (`childrenForFieldName('name')`, `childrenForFieldName('key'/'value')`) instead of walking bare `identifier` children, preventing type identifiers from being registered as variable names (C5, C6)
  - `symbolTable.ts`: removed all non-null assertions (`!`) on `scopeMap.get()` results that were followed by null checks — the assertion lied to the type system and could crash before the guard executed (H12)
  - `symbolTable.ts`: `collectFunctionDecl` now extracts `return_type` field as `declaredType` (M13)
  - `server.ts`: `diagnosticDebounceMs` and `maxNumberOfProblems` from `initializationOptions` are now wired to `DiagnosticManager` instead of being extracted and ignored (H9, H10)
  - `diagnosticManager.ts`: added `setDebounceMs()`, `setMaxNumberOfProblems()` methods; `publishDiagnostics()` now truncates to max problems limit
  - `moduleResolver.ts`: removed dead code — step 4 iterated `modulePaths` identically to step 2 (H11)
  - `pikeWorker.ts`: auto-restart after malformed responses now logs failure reason instead of silently swallowing errors (H14)
  - `client/extension.ts`: added restart-in-progress guard to prevent duplicate `LanguageClient` instances when settings change rapidly (H15)
  - `server.ts`: extracted `renderPredefSignature()` helper from inline regex chain for testability (M9)
  - `server.ts`: replaced Bun-specific `import.meta?.main` with cross-runtime guard (M14)
  - `accessResolver.ts`: added cache-hit comment on `parse()` call (M10)
  - `documentSymbol.test.ts`: uses `createSilentStream()` instead of bare `new PassThrough()` (H13)
  - `completion.test.ts`: removed dead first `getCompletions()` call whose result was never asserted (M11)
  - `sharedServer.test.ts`: LRU eviction test now uses production `LRUCache` class instead of hand-rolled Map (M12/L5)

- Systematic refactoring across 12 files addressing correctness, structural, error handling, and dead code issues:
  - Rewrote `detectPikePaths()` to use `pike --show-paths` for actual paths instead of hardcoded defaults
  - Extracted access resolution into new `server/src/features/accessResolver.ts` with `ResolutionContext` interface
  - Added generic `LRUCache<T>` (`server/src/util/lruCache.ts`) with max entries, max bytes, and `onEvict` callback; integrated into parser and server
  - Added `declById`/`scopeById` indexed maps to `SymbolTable` for O(1) lookups (replaced 21 O(n) array scans)
  - Fixed shared `completionCtx.uri` mutation with per-request context spread
  - Added malformed response counter in `PikeWorker` with auto-restart threshold
  - Log parse failures in `DiagnosticManager.onDidChange`
  - Clear pending request timeouts in `PikeWorker.restart()`

### Removed

- Dead `return "bool"` after `case "zero"` in `autodocRenderer.ts`
- Unsafe `as unknown as` cast on synthetic `SymbolTable` in `typeResolver.ts`
- `table as any` casts in `rename.ts` (replaced with proper `SymbolTable` type)
- Dead `buildStdlibLookupKeys` and `formatSignature` helpers from `server.ts`
- Unused `fileScopeId` variable in `symbolTable.ts`
- Unused `buildSymbolTableAsync`, `yieldToEventLoop`, and `YIELD_THRESHOLD` from `symbolTable.ts`

### Added

- `server/src/features/rename.ts` — stdlib/predef protected symbol rejection: `prepareRename()` and `getRenameLocations()` now reject rename targets matching 283 predef builtins or 5,471 stdlib short names, preventing accidental breakage of shadowed stdlib symbols
- `corpus/files/rename-base.pike`, `rename-child.pike`, `rename-main.pike` — multi-file inheritance chain corpus files for rename testing
- 9 new rename tests: protected symbol rejection (6), 3-file inheritance chain rename (3)
- `tests/integration/p2-verification.test.ts` — Phase 6 P2 verification suite: worker thrashing, hover latency, cross-file propagation, mode switching (10 tests, real PikeWorker, no mocks)
- `server/src/server.ts` — `PikeServer.index` changed from stale value to live getter, fixing dependency graph access after initialization
- `server/src/features/symbolTable.ts` — `buildSymbolTableAsync()` for event-loop yielding on large files (>= 1000 nodes)
- `server/src/server.ts` — `workspace/didChangeWatchedFiles` capability with dynamic watcher registration for `.pike` and `.pmod` files
- `decisions/0014-audit-remediation-and-incremental-parsing.md` — architecture decision record for audit fixes


- `server/src/parser.ts` — `deleteTree(uri)`, `getCachedTree(uri)`, `clearTreeCache()` for tree cache lifecycle
- `decisions/0018-incremental-parsing-and-ipc-security.md` — architecture decision record
- Standalone server build (`bun run build:standalone`) producing a self-contained bundle in `standalone/`
- `bin/pike-language-server` wrapper script for use with any LSP-capable editor
- `docs/other-editors.md` — verified setup instructions for Neovim, Helix, and generic LSP clients
- `package.json` `bin` field and `build:standalone` script

### Changed

- `server/src/server.ts` — `onPrepareRename` and `onRenameRequest` now pass protected stdlib/predef name set to rename functions
- `server/src/features/rename.ts` — `prepareRename()` and `getRenameLocations()` accept optional `ProtectedNames` parameter for stdlib/predef rejection
- `decisions/0016-rename.md` — amended with protected symbol rejection section
- `TRACKING.md` — Phase 6 P3 entry corrected from 'Deferred' to 'Shipped in Phase 8'
- `tests/lsp/rename.test.ts` — LSP protocol test fixtures renamed to avoid stdlib name collisions (counter→tally, add→computeSum)

- `harness/worker.pike` — `handle_typeof` hardened with character whitelist, balanced-parentheses check, dangerous-identifier rejection, and 200-char length limit
- `server/src/server.ts` — `autodocCache` now has independent 5 MB size cap with LRU eviction
- `server/src/server.ts` — `getSymbolTable` and `upsertFile` callers properly await async operations
- `server/src/parser.ts` — incremental tree-sitter parsing with LRU tree cache (50 entries / 50 MB ceiling), `parse(source, uri)` passes old tree for diff-based re-parsing
- `server/src/features/pikeWorker.ts` — strict FIFO queue serializing all worker calls, stdin backpressure via `drain` event, process-exit race fix
- `harness/worker.pike` — `typeof` handler rejects `;\n\r` in expressions, uses function wrapper instead of raw variable interpolation
- `server/src/features/diagnosticManager.ts` — removed internal priority queue; all worker calls delegate to `PikeWorker.enqueue()`
- `server/src/features/diagnostics.ts` — eliminated duplicate types (`Position`, `Range`, `DiagnosticSeverity`, `Diagnostic`), now imported from `vscode-languageserver/node`
- `server/src/features/documentSymbol.ts` — eliminated duplicate types (`Position`, `Range`, `SymbolKind`, `DocumentSymbol`), now imported from `vscode-languageserver/node`
- `server/src/server.ts` — all `parse()` calls pass URI for incremental cache; `didClose` evicts tree, `onShutdown` clears cache

### Removed

- `PLAN.md` — stale Phase 7-8 handoff document (Phase 8 complete)

### Fixed

- `tests/lsp/hover.test.ts` — stdlib hover test now asserts unconditionally (no more `if (result)` maybe-assertion)
- `tests/lsp/diagnostics.test.ts` — cross-file propagation test uses real corpus files and real workspace root instead of virtual URIs
- `resolveTypeMembers()` in completion.ts used broken `containsDecl()` for class scope lookup —
  class-name dot completion (`Animal.`) returned nothing. Fixed to use `parentId + rangeContains`.
- Cross-file rename excluded inherited symbol references because `getCrossFileReferences()` filtered by
  `resolvesTo !== null`. Inherited references have `resolvesTo=null`. Changed filter to `resolvesTo === null`.
- Arrow/dot access call sites (`d->bark()`) excluded from rename because `getReferencesTo()` only matched
  references where `resolvesTo === targetDeclId`. Added fallback for arrow/dot access name matching.
- Cross-file class-body identifier inherits (`inherit Animal` where Animal is a class in another file)
  resolved to `resolve_error: "NOT FOUND"`. `wireCrossFileInheritance()` now resolves bare identifiers
  directly via ModuleResolver. Also extended `warmResolverCache()` to pre-warm class-body inherits and
  fixed `resolveInheritTarget()` to correctly handle identifier inherits to `.pike` files.

### Added

- `textDocument/rename` — workspace-wide symbol renaming with cross-file support (decision 0016)
  - Scope-aware: only renames the same symbol, not homonyms in different scopes
  - Cross-file: uses WorkspaceIndex to enumerate references across dependent files
  - `textDocument/prepareRename` returns range and placeholder for rename UI
  - Pike keyword validation prevents renaming to reserved words
  - Renames variables, parameters, functions, classes, and class members

- Type resolution system (decision 0014)
  - `server/src/features/typeResolver.ts` — pure-function `resolveType()` and `resolveMemberAccess()`
  - Resolution chain: same-file class → qualified type → cross-file via inherit/import → stdlib
  - Depth limit 5 with graceful degradation to null
- Arrow/dot access definition and hover resolution
  - `textDocument/definition` now resolves `obj->member` and `obj.member` through type inference
  - `textDocument/hover` provides member info for resolved arrow/dot accesses
- Import dependency tracking (decision 0015)
  - `DeclKind 'import'` distinguishes import from inherit declarations
  - `extractDependencies()` includes import edges in dependency graph
  - Cross-file diagnostic propagation covers import dependents
- `resolveTypeMembers()` in completion.ts replaced with `resolveMemberAccess()` calls
  - Cross-file member completion via workspace index
  - Inherited member completion through type resolution
- Stdlib qualified type resolution: `resolveQualifiedType` falls through to stdlib index for types like `Stdio.File`

### Changed

- `collectInheritDecl()` now derives `kind` from node type (`import_decl` → `'import'`, `inherit_decl` → `'inherit'`)
- All consumers of `kind === 'inherit'` audited and updated to handle both kinds where appropriate
- `findMemberInClass` and `findMemberInInheritedScopes` use `parentId` + position comparison instead of `containsDecl`


### Added

- `textDocument/completion` — tree-sitter-first completion provider (decision 0012)
  - Trigger characters: `.`, `>`, `:` (dot, arrow, scope access)
  - Unqualified completion: local scope walk + predef builtins (283) + stdlib modules (5,471)
  - Dot/arrow access: resolve left-hand side → enumerate members from symbol table + stdlib
  - Scope access (`::`): resolve inherited class members
  - Deduplication: inner scope shadows outer
  - No Pike worker dependency in the common case (~93% of completions)
- `symbolTable.ts`: `getSymbolsInScope()` — enumerate all declarations visible at a position
- `symbolTable.ts`: `getDeclarationsInScope()` — enumerate declarations in a specific scope
- `symbolTable.ts`: `findClassScopeAt()` — find enclosing class scope at a position
- `completion.ts`: stdlib secondary index — prefix-grouped member enumeration
- Real-time diagnostics with debouncing (decision 0013)
  - `DiagnosticManager` — per-file debounce timers (500ms default, configurable)
  - Supersession: version-gated dispatch prevents stale diagnoses
  - Worker priority queue: diagnose defers to hover/completion
  - Cross-file diagnostic propagation via dependency graph
  - Three modes: `realtime` (default), `saveOnly`, `off`
  - Staleness indication for long-running diagnose (2s)
  - Configurable via `initializationOptions.diagnosticMode`
- 15 new diagnostic tests (debounce, mode, lifecycle, caching, supersession, priority)

### Added

- Declared-type member completion: `Animal a; a->` now resolves to class members
  - Symbol table tracks `declaredType` on variables and parameters from type annotations
  - `resolveTypeMembers()` resolves declared types to class scopes, including inherited members
  - Works for both local variables and function parameters
  - Primitive types (`int`, `string`, `mixed`) correctly produce no member completions
  - 6 new tests covering typed variables, parameters, inheritance, primitives, mixed types
- Cancellation state test: verifies `$/cancelRequest` causes early return via raw JSON-RPC
- `c2s`/`s2c` streams exposed on `TestServer` for raw message testing

### Fixed

- Operator symbols (backtick identifiers) no longer appear in completion suggestions
  - Filtered out Pike operators (`>`, `==`, `->`, etc.) from predef builtin completions
- Trailing dot/arrow completion now works (`Stdio.`\n, `a->`\n no longer falls through to unqualified)
  - `findLhsBeforePosition()` handles ERROR nodes and anonymous operator tokens
  - Fixed `indexOf` bug: tree-sitter node wrappers are not reference-identical; use `equals()` for sibling lookup
- Foreach loop variables (`idx`, `val`) now captured in symbol table
  - Fixed `collectForeachStatement()`: `foreach_lvalues` is an unnamed child, not a field
  - Fixed `collectForeachLvalues()`: identifiers are siblings of type nodes, not children
- Completion handler checks `CancellationToken` at three boundaries for fast-typing cancellation
- Tree-sitter `indexOf` bug: node wrappers are not reference-identical; use `equals()` for sibling lookup

## Phase 5 AutoDoc Redesign: PikeExtractor XML Boundary - 2026-04-27
# Changelog

All notable changes to the Pike Language Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Phase 5 AutoDoc Redesign: PikeExtractor XML Boundary - 2026-04-27

### Changed

- **AutoDoc routing redesigned** from //! comment parsing to XML-based pipeline:
  - Source-to-XML: PikeExtractor.extractNamespace() in Pike worker (cached)
  - XML-to-markdown: TypeScript renderer (autodocRenderer.ts)
  - Every tag in the autodoc.xml schema has a render path
  - Boundary at XML: TypeScript never reimplements Pike's //! syntax
- **autodocParser.ts removed** — replaced by autodocRenderer.ts
- **Hover handler rewritten** — three-tier routing:
  - Tier 1: Workspace AutoDoc — XML cache → findDocGroup → renderAutodoc → Markdown
  - Tier 2: Stdlib — hash-table lookup in pre-computed index
  - Tier 3: Tree-sitter — bare declared type

### Added

- `harness/worker.pike`: handle_autodoc method (PikeExtractor API, no temp files)
- `pikeWorker.ts`: autodoc() method, AutodocResult type
- `autodocRenderer.ts`: XML parser + walk + render to Markdown (covers all schema tags)
  - parseXml: lightweight XML parser for PikeExtractor output
  - findDocGroup/findClass: XML tree walker for symbol lookup
  - renderAutodoc: XML → MarkupContent for LSP hover
  - Handles: method, variable, class, param, returns, throws, note, deprecated,
    seealso, example, mapping, array, dl, multiset, inline markup (b, i, tt, code, ref)
- `server/src/data/stdlib-autodoc.json`: Pre-computed stdlib index
  - 5,471 symbols, 1.39 MB
  - Generated from Pike 8.0.1116 stdlib via `scripts/build-stdlib-index.ts`
- `scripts/build-stdlib-index.ts`: Build script for stdlib AutoDoc index
- `autodocCache` in server.ts: Content-hash keyed XML cache with LRU eviction
- `PikeServer.autodocCache` exposed for testing

### Performance

| Operation | Cold | Warm |
|-----------|------|------|
| PikeExtractor (in-process) | 0.58ms | 0.48ms |
| XML rendering (TypeScript) | 0.29ms/symbol | 0.29ms/symbol |
| Stdlib lookup (hash table) | — | <0.01ms |
| Hover hot path (cache hit) | — | ~0.3ms/symbol |

### Testing

- autodocRenderer tests: 43 tests (parser, finder, per-tag rendering, corpus snapshot, complex types)
- Hover tests: 9 tests (Tier 1 cache hit, Tier 1 cache miss, Tier 2 stdlib, Tier 3 fallback, range, isolation)
- Total test suite: 915 pass, 1 todo, 0 fail, 7569 assertions

### Fixed

- worker.pike: spawn command double-command bug fixed (nice + Pike args)
- worker.pike: requestCount tracking added for memory ceiling check

## Phase 5: Types and Diagnostics - 2026-04-28

### Added

- Pike worker subprocess: long-lived Pike process for diagnostics and type queries
  - JSON-over-stdio protocol: diagnose, typeof, ping methods
  - CompilationHandler-based structured diagnostics (errors + warnings)
  - Same normalization as harness introspect.pike (expected/actual type extraction)
- PikeWorker TypeScript class: subprocess lifecycle management
  - Lazy start, automatic crash recovery, restart with readiness check
  - Idle eviction: kill after 5 min idle (configurable), restart on next request
  - Memory ceiling: forced restart after 100 requests or 30 min active use
  - Timeout: 5s per request, surfaced as diagnostic on timeout
  - CPU politeness: spawned with nice +5 on Linux
  - FIFO queueing: one request at a time, documented
  - All values configurable via PikeWorkerConfig
- Save-triggered diagnostic pipeline (decision 0011)
  - didSave → Pike worker → structured diagnostics → merged with parse diagnostics
  - Position mapping: Pike 1-based lines → LSP 0-based lines
  - Diagnostic severity mapping: Pike error/warning → LSP Error/Warning
  - Timeout surfaced as warning diagnostic ("Compilation timed out, will retry on next save.")
- LRU diagnostic cache: 50 entries / 25MB cap, oldest-first eviction
  - Content-hash keyed per-file, undo operations are free
- AutoDoc hover routing: parse-tree driven, no subprocess (decision 0011 §7)
  - Tier 1: Workspace AutoDoc — //! comments extracted from source text
  - Tier 2: Stdlib — reserved for pike-ai-kb pike-signature (Phase 6)
  - Tier 3: Fall-through — tree-sitter declared type
  - Supports: @param, @returns, @throws, @note, @deprecated, @seealso, etc.
  - Hover coverage on corpus: 7/545 (1%) — corpus not designed for autodoc
- Hover handler: three-tier routing per decision 0002
  - Same-file: autodoc → tree-sitter
  - Cross-file: WorkspaceIndex resolution → autodoc or tree-sitter
  - Hover never involves the Pike worker — sub-millisecond latency
- Decision 0011: Types, diagnostics, hover, shared-server policies
- harness/resolve.pike: cross-file resolution ground truth from Pike's perspective
- Extension packaging: esbuild bundles for server and client
- @vscode/test-electron integration tests (3 tests in VSCode extension host)
- docs/deployment-context.md: SSH/shared-server deployment context

### Fixed

- resolveInheritTarget: .pmod file inherits treated like string literal inherits
- Directory module normalization: LSP and Pike resolve differently, test normalizes
- Spawn command: fixed double-command bug in nice/ Pike worker spawn

### Benchmarks

| Operation | Cold | Warm p50 | Warm p95 |
|-----------|------|----------|----------|
| Diagnose | 49.5ms | 0.13ms | 0.32ms |
| Hover (autodoc) | 0.005ms | 0.005ms | 0.005ms |
| Worker restart | 150ms | — | — |

### Testing

- PikeWorker subprocess tests: 12 tests (lifecycle, diagnostics, concurrent)
- Diagnostics pipeline tests: 7 tests (type errors, position mapping, caching)
- Hover tests: 8 tests (autodoc, undocumented, empty, range, isolation)
- Shared-server tests: 6 tests (idle eviction, memory ceiling, timeout-as-diagnostic, LRU)
- Oracle tests: 5 tests comparing LSP vs Pike resolution
- Integration tests: 3 tests running in VSCode extension host
- Total test suite: 871 tests, 7478 assertions, 0 failures
## [Unreleased]

### Added

- LSP server: stdio transport, documentSymbol handler, text document sync
- Server factory: `createPikeServer(connection)` for in-process testing
- Tree-sitter integration: WASM parser (web-tree-sitter@0.26.8) with parse cache
- documentSymbol: 15 node type → SymbolKind mappings with nested class/enum support
- Parse error handling: partial results + diagnostics on ERROR nodes
- VSCode extension: activates on .pike/.pmod/.mmod files
- Harness: symbol extraction via Pike program introspection (indices/values/typeof)
- docs/lsp-references.md: architecture patterns + testing strategies
- Decision 0006: LSP server architecture

### Testing

- Three-layer test infrastructure:
  - Layer 1 (tests/lsp/): 227 protocol-level tests with in-process PassThrough transport
    - documentSymbol.test.ts: 213 tests comparing against harness snapshots
    - lifecycle.test.ts: 5 tests (initialize, shutdown, performance)
    - error-handling.test.ts: 8 tests (malformed input, KL-007, edge cases)
  - Layer 2 (tests/integration/): 3 test stubs for @vscode/test-electron
  - Layer 3 (MANUAL_SMOKE_TESTS.md): 3 manual UX items
- Tree-sitter unit tests: 108 (renamed to tree-sitter-symbol.test.ts)
- Total test suite: 403 tests, 4306 assertions

### Fixed

### Fixed

- snapshot.ts: type-safe generic diff (getField helper, no unsafe casts)

## Phase 4: Cross-File Resolution - 2026-04-27

### Added

- ModuleResolver: Pike's module resolution algorithm in TypeScript
  - Module path resolution: Stdio.File, cross_import_a, cross_pmod_dir.helpers
  - Inherit path resolution: string literal, identifier, dot-path, relative (.Foo)
  - Import path resolution: import Stdio, import cross_pmod_dir
  - #pike version-aware search paths (e.g., #pike 7.8)
  - Priority: .pmod directory > .pmod file > .pike file
  - Hyphen-to-underscore normalization (Pike naming convention)
  - Caching with per-query invalidation
- WorkspaceIndex: in-memory per-file symbol table index
  - Forward dependency graph (inherit/import targets)
  - Reverse dependency graph (dependents) for invalidation
  - Invalidation propagation: file change → dependents invalidated
  - ModificationSource tracking (gopls pattern)
  - Content hashing for cache validity
  - #pike version detection from parse tree
- Cross-file definition: resolve definitions across files through inherit/import chains
- Cross-file references: find references to symbols across workspace files
- Server integration: WorkspaceIndex replaces per-document cache
- Manifest-driven metadata: corpus/corpus.json replaces hardcoded CROSS_FILE_FLAGS
- import_decl now collected as declaration alongside inherit_decl
- Decision 0010: Cross-file resolution architecture (workspace model, index, module resolution, invalidation)
- 14 new cross-file corpus files covering inherit chains, import, pmod directories, stdlib, compat

### Testing

- ModuleResolver tests: 21 tests (module, inherit, import, #pike version, path detection)
- WorkspaceIndex tests: 15 tests (indexing, dependencies, invalidation, version detection)
- Cross-file definition/reference tests: 12 tests (simple inherit, rename, chain, import, incremental update)
- Total test suite: 830 tests, 7359 assertions, 0 failures

## Phase 3: Per-file Symbol Table - 2026-04-27

### Added

- Symbol table builder: two-pass construction (declarations + references, then inheritance wiring)
- Scope-aware resolver: 10-level scope hierarchy with chain walk
- textDocument/definition handler: go-to-definition for same-file symbols
- textDocument/references handler: find-references for same-file symbols
- Symbol table cache: lazy rebuild on next request after didChange
- Inherit-with-rename support: `inherit Animal : creature` with alias resolution
- 4 new corpus files: scope-for-catch, scope-shadow-params, class-forward-refs, class-inherit-rename
- 18 edge-case tests covering scoping, shadowing, forward refs, lambda captures
- Decision 0009 expanded: explicit cache invalidation policy, Pike-verified scoping behaviors table, class extraction documentation
- Upstream issues filed: tree-sitter-pike#2, #3, #4

### Fixed

- For-loop init declarations now register in for-scope (was empty due to tree-sitter missing field names)
- If-block consequence/alternative push their own block scope (variables no longer leak)
- Lambda scopes in variable initializers now discovered
- Scope tie-breaking prefers deeper scopes when ranges are equal
- Inherit-with-rename: scope_access resolves through alias, go-to-def on both path and alias

### Testing

- Phase 3 definition tests: 110 tests
- Phase 3 references tests: 29 tests
- Edge-case tests: 18 tests
- Total test suite: 614 tests, 5680 assertions, 0 failures
## [0.1.0-alpha] - 2026-04-26