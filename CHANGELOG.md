# Changelog

All notable changes to the Pike Language Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html/).



## [Unreleased]

### Added

  - Predef builtin documentation: 204 of 283 C-level predef functions now have
    human-readable docs on hover and in completion detail. Extracted from
    Pike's `core_autodoc.xml`. Completions use named params from autodoc for
    snippet tab stops (e.g., `write(${1:fmt})`).
  - Semantic token classification for predef builtins and stdlib modules:
    unresolved identifiers that match predef builtins are highlighted as
    `function`, stdlib module names as `namespace` (instead of all being
    `variable`).
  - Keyword snippet completions: 23 Pike keywords (`if`, `for`, `foreach`,
    `while`, `class`, `lambda`, `catch`, `switch`, etc.) now offer structural
    snippet expansion. Keywords sort after all symbol completions so identifiers
    always appear first.

### Fixed

  - ALT+UP/DOWN line moves now reformat the document via pike-fmt instead of
    relying on regex-based `indentationRules` which cannot track actual block
    nesting. Wrapper commands (`pike.moveLinesUp`/`pike.moveLinesDown`) replace
    the built-in move action for Pike files and call
    `editor.action.formatDocument` after each successful move.

## [0.8.10] — 2026-05-28

### Fixed

  - `lineToColumn`: walk nested nodes (not just root children) to find the
    first token on a line. Previously only checked `tree.rootNode.children`,
    missing tokens in deeply nested structures like function bodies.
  - `textDocument/rename` LSP protocol tests: updated assertions to expect
    `ResponseError` (not `null`) for error cases — empty position, rename
    to keyword, and no-change rename. Pike LSP correctly returns descriptive
    errors for these cases.
  - `getRenameLocations`: corrected expected location counts in two same-file
    tests where comments referenced wrong line numbers. These were pre-existing
    fixture issues unrelated to the v0.8.9 release.
  - Added test for call hierarchy outgoing calls via method chains
    (`obj->method()`), covering the `extractCalleeFromChain` code path.

## [0.8.9] — 2026-05-28

### Fixed

  - Call hierarchy outgoing calls now correctly resolve through `postfix_expr`
    nodes with `(` children instead of searching for non-existent
    `call_expression` nodes. Handles bare calls (`helper()`), method chains
    (`obj->method()`), and nested calls (`foo(bar())`).
  - Transitive inherit resolution: cross-file go-to-definition now follows
    inherit chains beyond one hop (e.g., A→B→C where C references a symbol
    from grandparent A). Cycle detection prevents infinite recursion.
  - Cross-file rename: scope-aware filtering excludes arrow/dot access
    references where the receiver's type doesn't match the target's owning
    class. Renaming `Dog.speak()` no longer catches `cat->speak()` when
    `cat` is a `Cat`.
  - Variable alias type propagation: `Dog d2 = d1;` now sets
    `assignedType = "Dog"` instead of `assignedType = "d1"`. Multi-hop
    alias chains are resolved iteratively.
  - Diagnostic column precision: Pike error messages are parsed for
    identifier names to locate the specific error token on the diagnostic
    line, instead of always pointing to the first meaningful token.

## [0.8.8] — 2026-05-27

### Fixed

  - TextMate grammar: add missing `=` (assignment) operator to the operators
    regex — bare `=` was the only Pike operator with no scope, causing every
    assignment to render in default foreground instead of the theme's operator
    color.
  - TextMate grammar: support nested parametric types in function declaration
    matching (e.g. `mapping(string:array(int)) foo(`). The pattern used
    `[^)]*` which stopped at the first `)`, breaking on nested generics.
    Replaced with `(?:[^()]|\([^)]*\))*` to handle one level of nesting.
  - TextMate grammar: move `#declarations` before `#types` and `#keywords` in
    root pattern order so that `array(int) foo(` matches the declaration
    pattern instead of having `array` consumed by the generic type catch-all.
  - TextMate grammar: anchor preprocessor directive pattern to line start
    (`^\s*#`) to prevent `// #ifdef` comments from being highlighted as
    directives.
  - TextMate grammar: reorder float literal pattern before integer so `3.14`
    is consumed atomically instead of splitting into `3` (integer) + `.14`
    (float).
  - TextMate grammar: add `storage.type.pike` capture to the complex-type
    declaration pattern so the type portion (e.g. `mapping(string:int)`) gets
    proper type highlighting alongside the function name.
  - TextMate grammar: remove greedy `function-call` pattern that incorrectly
    highlighted function declarations as function calls (e.g. `int foo(` was
    colored as a call, not a declaration).
  - TextMate grammar: remove `.` from punctuation character class so that
    `member-access` patterns can match `identifier.identifier` chains
    (e.g. `Stdio.FILE`, `Crypto.SHA256`).
  - TextMate grammar: reorder root patterns so `scope-access` and
    `member-access` are tried before `operators` — previously `->` and `::`
    were consumed as operators, preventing accessor highlighting from
    ever firing.
  - TextMate grammar: fix complex-type declaration regex capture group
    numbering (was referencing non-existent group `"2"`, now `"1"`).
  - formattingHandler: replace index-based line comparison in
    `computeOnTypeEdits` with a proper diff approach (find common prefix
    and suffix). The old ±10 window broke when the formatter added or
    removed lines, producing corrupt edits on paste/move operations.
  - diagnosticManager: `onDidChange` now merges cached pike diagnostics
    with fresh parse diagnostics so that existing pike diagnostics are not
    cleared while a debounced run is pending or skipped (fixes stale
    error clearing on file switch).
  - serverFileWatchHandler: clear pike/autodoc caches for dependents when
    a dependency changes or is deleted, so stale diagnostics from the old
    dependency state are not merged back into dependent files.
  - serverFileWatchHandler: propagate invalidation to dependents on file
    deletion — previously dependents kept stale cross-file references and
    diagnostics when an included/imported file was deleted.
  - serverFileWatchHandler: extract `propagateDependentInvalidation()`
    helper to deduplicate 20+ lines of identical dependent-propagation
    logic between `handleFileCreatedOrChanged` and `handleFileDeleted`.
  - completion: suppress autocomplete popup after a lone `:` (case labels,
    goto labels, ternary expressions) — only `::` should trigger scope
    completion, not a single colon.

## [0.8.7] — 2026-05-22

### Fixed

  - formattingHandler: replace broken `computeIndentEdits` (only matched
    leading whitespace, silently dropped all other pike-fmt changes —
    internal whitespace, trailing whitespace, blank-line collapse,
    operator spacing) with `computeEdits` that does a single full-document
    replace. Also fixed `computeOnTypeEdits` to compare full line content
    rather than indentation only. Removed four unused imports.

## [0.8.6] — 2026-05-22

### Fixed

  - serverDocumentHandler / serverContext: guard `upsertInFlight.delete()`
    so a concurrent `didChangeContent` for the same URI cannot prematurely
    evict the second in-flight upsert promise (race condition where the
    first promise's `finally` block would delete an entry already replaced
    by a second call).
  - serverLifecycle: chain Phase 3 (`indexWorkspaceFiles`) after Phase 2
    (`refreshStaleCacheEntries`) resolves — previously they ran concurrently,
    causing double-indexing of the same files and stale-cache-entry
    corruption when background indexing raced ahead of the stale-refresh.
  - serverLifecycle: remove redundant dynamic import of `fileURLToPath`
    in `refreshStaleCacheEntries` — the symbol is already statically
    imported at the top of the file.
  - serverInitHandler: add `else` branch to log non-filesystem errors in
    `onDemandIndex` (parse errors, JSON errors) that were previously
    silently swallowed. Also add missing `logError` and `ErrorCategory`
    imports.
  - harness/diagnosticsGolden: use `canonicalStringify` instead of
    `JSON.stringify` for diagnostic comparison — ensures key-order
    differences don't produce false mismatches.
  - scope-helpers: replace non-null assertion on `namedChild(0)` with
    explicit null guard — tree-sitter nodes can be null on ERROR nodes.

## [0.8.5] — 2026-05-22

### Changed

  - Documented four design-level concerns as known limitations:
    synthetic ID counter thread-safety (`typeResolver.ts`), name-only
    cross-file reference matching (`workspaceResolution.ts`), no transitive
    inherit resolution (`workspaceResolution.ts`, `typeResolver.ts`), and
    scope boundary inclusion (`scope-helpers.ts`). These are not bugs but
    intentional simplifications with documented rationale.
  - serverContext: document fire-and-forget parser init pattern.
  - serverLifecycle: add `.catch()` on startup chain to prevent
    unhandled rejection if cache restore fails before reconnecting.

### Fixed

  - xmlParser: guard against out-of-bounds position advance when
    AutoDoc attribute value is unterminated (missing closing quote).
  - errorLog: reset `_nextId` counter in `clear()` so IDs restart
    after clearing — prevents confusing ID gaps in test assertions.
  - parser: clear cached promise on WASM init failure so transient
    I/O errors (e.g., NFS) don't make the parser permanently unusable.
  - serverDocumentHandler: add early return after parse error catch,
    preventing diagnostic manager from running on a failed parse.
    Wrap post-didChange diagnostics in try/catch for client disconnect.
  - getterSetter: fix `findParentClass` range check direction — was
    checking if class scope contains the declaration; now correctly
    checks if the declaration contains the class scope.
  - pikeWorkerProcess: replace deprecated `RegExp.$1` with `exec()`
    result — static RegExp properties are unsafe under async concurrency.
  - main: save persistent cache on SIGTERM/SIGINT before exiting.
    Without this, force-close loses the workspace index built during
    the session.
  - harness: remove self-healing snapshot/golden auto-generation.
    Missing files should fail the test, not silently create new baselines.
  - lifecycle test: remove stray `kg|` characters from test source.

## [0.8.4] — 2026-05-21

### Fixed

  - Semantic highlighting, completions, and go-to-definition now update
    correctly after editing a file. Two root causes: (1) the server never
    sent `workspace/semanticTokens/refresh` after document changes, so
    VSCode only re-requested tokens on tab switch; (2) tree-sitter
    incremental re-parse was missing the required `tree.edit()` call,
    causing stale subtrees to be reused after edits.
  - Pike worker subprocess now sets `LD_LIBRARY_PATH` from auto-detected
    `pikeHome/lib`, so native modules (Nettle, etc.) load correctly
    without manual configuration. A one-time warning is shown if a
    required shared library is missing, instead of spamming every
    stderr line as a critical error.
  - `worker.ldLibraryPath` VSCode setting is now passed through from the
    client to the server during initialization.

## [0.8.3] — 2026-05-20

### Fixed

  - P3005 lint rule no longer flags `inherit` declarations as unused. Inherited
    members are available through implicit scope access and cannot be reliably
    detected without cross-file type analysis. Removing a "seemingly unused"
    inherit silently breaks code because Pike returns 0 (null) for missing members.
  - Predef builtin hover (e.g., hovering on `time`) now renders clean,
    human-readable signatures instead of raw Pike runtime type syntax.
    Overloaded functions show each overload as `name(params) → returnType`.
    Pike-internal noise like `int(1bit)`, `scope(0,...)` is stripped.
  - Semantic highlighting no longer breaks after a few edits on restart.
    `refreshStaleCacheEntries` was calling `invalidateWithDependents` after
    `upsertBackgroundFile`, immediately nulling the freshly-built symbol
    table. All cached files ended up permanently stale — semantic token
    requests returned empty data. Fix: invalidate before re-indexing.

## [0.8.2] — 2026-05-19

### Added

  - `docs/perf/q3-profile-report.md` — profiling report documenting where
    buildSymbolTable time is spent. Key finding: type text extraction and
    tree traversal dominate; disk I/O is negligible.
  - `tests/perf/micro-upsert.test.ts` — per-phase micro-benchmark for
    upsertBackgroundFile breakdown.
  - **Startup:** Two-phase startup serves cached data immediately, then
    refreshes stale entries in background. Time-to-first-response drops
    to cache load time (<500ms for most workspaces).
  - **Startup:** Background cache refresh only re-indexes files whose
    content hash changed, plus their dependents. Pruned invalidation
    avoids re-indexing the entire workspace on restart.
  - `server/src/features/cacheHash.ts` — extracted DJB2 hash utility.
  - `WorkspaceIndex.restoreDependencies()` — reconstructs reverse-dep
    graph from serialized forward deps without async resolution.

### Changed

  - **Performance:** Pre-computed byte→UTF-16 offset map per file, eliminating
    the dominant `utf8ToUtf16` bottleneck in the symbol table build pipeline.
    Position conversion is now O(1) per lookup instead of O(lineLength).
  - **Performance:** Scope lookup uses binary search on sorted scopes instead
    of linear scan, reducing complexity from O(R × S) to O(R × log S).
  - **Cache:** Persistent cache split into per-file entries under
    `.pike-lsp/cache/<contentHash>.json` with atomic writes (temp file +
    rename). Loading validates each entry individually — only changed files
    are rebuilt. Format version bumped to 2.
  - **Cache:** Forward dependencies serialized per entry, enabling reverse-dep
    graph reconstruction from cache without async resolution.
  - ADR 0024: documents the offset map and binary search scope lookup decision.
  - ADR 0025: documents Q3 profiling results and M1 per-file cache architecture.
  - ADR 0026: documents two-phase startup and pruned cache invalidation.
  - **Startup:** Cache load and background indexing now run sequentially
    (cache first, then background). Previously both ran in parallel,
    causing background indexing to re-index files that were about to be
    loaded from cache.

### Fixed

  - **Bug:** Feature handlers (workspace/symbol, hover, definition, etc.)
    returned empty results because they captured the placeholder index at
    registration time. `handleInitialize` replaced the index, but handlers
    still held the stale reference. Fixed by using getters that delegate
    to the live context object.
  - **Bug:** Background indexing ran concurrently with cache loading,
    wasting CPU on files that would be served from cache moments later.
    Now chained sequentially: cache load → stale refresh → background index.

## [0.8.1] — 2026-05-18

### Added

  - Pike-language test suite (`tests/pike/`) — 487 tests covering language
    analysis, LSP protocol handling, and server behavior via PUnit framework
    and Pike's `compile_string` introspection.
  - `scripts/test-pike.sh` — test runner for the Pike suite with verbose mode
    and single-file selection. Replaces the `pmp run` invocation.
  - `bun run test:all` — runs TypeScript and Pike tests together.
  - Testing section in README with directory structure, usage examples, and
    guide for adding new Pike tests.

### Changed

  - Project structure in README updated to reflect the three test directories
    (`tests/pike/`, `tests/lsp/`, `tests/perf/`).

## [0.8.0] — 2026-05-18

### Added

  - VSCode settings for Pike path configuration: `pikeHome`, `modulePaths`,
    `includePaths`, `programPaths`. When all four are set, auto-detection is
    skipped entirely — no `pike --show-paths` subprocess spawned.

### Changed

  - **Lazy on-demand indexing (ADR 0023).** Background indexing no longer
    resolves dependencies — it builds symbol tables only (synchronous, fast).
    Dependencies are resolved lazily when cross-file queries need them. This
    follows the pattern used by rust-analyzer and gopls.
  - Open files are indexed first with full dependency resolution before
    background workspace indexing starts. The files you're looking at get
    full features immediately.
  - Background indexing is now cancellable — accepts a `CancellationToken`
    and checks it between batches. User-facing requests always take priority.
  - Cache restoration (`upsertCachedFile`) is now synchronous and skips
    dependency resolution entirely. Previously it called `extractDependencies`
    for every cached entry, triggering hundreds of async filesystem operations
    at startup.
  - `depsResolved` sentinel on `FileEntry` distinguishes "not yet resolved"
    from "resolved, found nothing" — prevents redundant re-resolution for
    files with no imports/inherits.
  - `resolveCrossFileDefinition` now calls `ensureDependenciesResolved`
    internally before following import/inherit edges — cross-file go-to-def
    works even for background-indexed files.

### Fixed

  - Startup delay: `onInitialized` no longer blocks on cache loading.
    Previously, `loadCache()` was awaited, blocking background indexing
    from starting until every cached file's dependencies were resolved
    (async fs operations per entry). Now fire-and-forget.
  - `ensureDependenciesResolved` no longer re-runs for files with zero
    dependencies. Previously, `deps.size === 0` was used as the "not resolved"
    check, causing repeated resolution attempts on every cross-file query.

## [0.7.5] — 2026-05-18

### Fixed

  - Initial release of startup performance improvements (superseded by
    lazy indexing in [Unreleased]).
  - Pike path auto-detection runs only when needed — user-configured paths
    bypass the `pike --show-paths` subprocess and filesystem scanning.
  - Removed `.pike-lsp/pike-paths.json` disk cache — no workspace directory
    pollution. Detection results are cached in-memory per session only.

## [0.7.4] — 2026-05-18

### Added

  - `upsertBackgroundFile()` — synchronous fast path for background indexing
    that builds symbol tables without async dependency resolution. ~10× faster
    bulk indexing by eliminating per-file `warmResolverCache` + `extractDependencies`
    async fs operations.
  - `ensureDependenciesResolved()` — lazy dependency resolution that upgrades
    background-indexed files on demand when opened. Cross-file features
    (go-to-def, reference counts) light up without blocking startup.
  - Generation-based reference count cache in code lens provider. Code lens
    requests return cached results instantly when the workspace index hasn't
    changed, avoiding redundant cross-file reference walks.
  - `tests/perf/large-workspace.test.ts` — synthetic 1000-file workspace
    profiling test measuring indexing throughput, code lens, and cross-file
    reference performance with budget assertions.
  - `tests/perf/micro-upsert.test.ts` — per-operation breakdown benchmark
    isolating parse, buildSymbolTable, and upsert costs.

### Changed

  - Background indexer (`backgroundIndex.ts`) now uses `upsertBackgroundFile()`
    instead of `upsertFile()`, making batch insertion synchronous and
    eliminating async bottlenecks from the critical startup path.
  - `didOpen` handler triggers `ensureDependenciesResolved()` fire-and-forget,
    so dependency edges are populated without blocking the editor.

### Fixed

  - Performance regression on workspaces with 1000+ files: background indexing
    no longer blocks the LSP server during startup. Users see completions,
    highlights, and diagnostics immediately while dependency resolution
    continues in the background.
  - VSIX build version format: replaced dot-separated `build.NNNNNN` with
    single alphanumeric identifier `buildNNNNNN` to avoid semver leading-zero
    validation errors in vsce 3.x.

## [0.7.3] — 2026-05-16

### Added

  - `scripts/quality-gates.sh` — automated anti-pattern detection covering
    function length, non-null assertions, silent catches, rootNode.text usage,
    unbounded Maps, import.meta assertions, and file length. Derived from 3
    audit iterations (99 findings).

## [0.7.2] — 2026-05-16

### Changed

  - Audit documentation updated: `docs/audits/iteration-3.md` with full
    remediation status table, `docs/audits/README.md` updated.
  - Added `scripts/quality-gates.sh` — automated anti-pattern detection
    (function length, non-null assertions, silent catches, rootNode.text,
    unbounded Maps, import.meta assertions, file length) derived from
    3 audit iterations (99 findings).

### Fixed

  - Architecture audit iteration 3 remediation: 1 Critical, 5 High, 13 Medium,
    13 Low findings resolved across server, scripts, and test infrastructure.
  - **C1**: Stale `package-lock.json` regenerated via `bun install`.
  - **H1**: `resolveCrossFileDefinition` now has `maxRetries` depth limit to
    prevent unbounded recursion on concurrent indexer updates.
  - **H3**: `indexWorkspaceFiles` split from 162 to 49 lines (6 helpers).
  - **H4**: `registerAdvancedHandlers` split from 179 to 17 lines (6 handlers).
  - **H5**: `declForHover` split from 160 to 34 lines (7 helpers).
  - **M1**: Idle-eviction and memory-ceiling extracted to `pikeWorkerLifecycle.ts`.
  - **M2**: `detectPikePaths` split into 5 phase-based functions.
  - **M3**: `formattingHandler` extracted into named handler functions.
  - **M4**: `parseXml` split into 9 module-level parsing functions.
  - **M5**: `extractInitializerType` split into 4 focused helpers.
  - **M6**: `produceGetterSetterActions` split into 3 helpers.
  - **M7**: Extracted `synthesizeFileClassDecl()` — eliminated 4 duplicated blocks.
  - **M8**: `registerCompletionHandlers` split from 117 to 21 lines.
  - **M9**: `createSyntheticScope` split from 97 to 30 lines.
  - **M10-M12**: Non-null assertions on tree-sitter nodes replaced with null guards.
  - **M13**: `scopedResolver` cached by version string to bound memory.
  - **L1-L4**: Logging added to 4 silent catch blocks.
  - **L5**: `root.text` replaced with `content` parameter in `parsePikeVersion`.
  - **L7**: `import.meta.dirname!` replaced with nullish coalescing fallback.
  - **L8**: Segfault detection in `smoke-test.sh` uses process exit code.
  - **L9**: Shell quoting bug fixed in `test-vscode.sh`.
  - **L10**: CHANGELOG `[Unreleased]` moved to correct position.
  - **L11**: Sed escape in `release.sh` switched to `|` delimiter.
  - **L12**: 87 golden snapshot files regenerated.
  - Performance benchmark `completion_cold` baseline raised to 200ms (shared
    server reality), eliminating flaky CI failures.

## [0.7.1] — 2026-05-16

### Changed

  - Audit documentation restructured into `docs/audits/` with per-iteration
    files (`iteration-1.md`, `iteration-2.md`) replacing monolithic
    `architecture-audit.md`.

### Fixed

  - Architecture audit iteration 2 remediation: 3 Critical, 9 High, 18 Medium,
    10 Low findings resolved across server, client, and CI.
  - **C1**: `createPikeServer` split from 417-line monolith into 5 focused
    modules (`serverContext`, `serverInitHandler`, `serverFileWatchHandler`,
    `serverShutdownHandler`, `serverDocumentHandler`).
  - **C2**: Silent cache-save catch now logs via `logWarn()`.
  - **C3**: Client restart notification name fixed from `pike/serverLog` to
    `pike/log`; param shape aligned with server (`{ level, lines }`).
  - **H1–H2**: Non-null `child(0)!` assertions replaced with null guards in
    diagnostics and reference collector.
  - **H3**: `rootNode.text` eliminated from 8 of 10 hot paths (remaining 2 are
    test-only fallbacks with explicit `source` override).
  - **H4**: `require()` calls replaced with static ES imports in code actions.
  - **H5–H8, M17**: 15+ function-length violations split across 7 files.
    New `completionTriggerResolve.ts` extracted from `completionTrigger.ts`.
  - **H9**: CHANGELOG version ordering fixed to follow Keep a Changelog.
  - **M4–M6**: Bare `as` casts replaced with runtime validation
    (`staticDataValidation.ts`, `codeActionKinds.ts`).
  - **M7–M8**: `q.shift()!` / `queue.shift()!` replaced with null guards.
  - **M9–M10**: Silent catch blocks improved with descriptive comments.
  - **M11**: Client restart handler param shape fixed to match server output.
  - **M12–M16**: CI/build fixes — pike-fmt job added, esbuild path corrected,
    VSIX filename format fixed, bash prefix added.
  - **L2, L4, L6–L8**: `as never` casts replaced, zero-byte `=` file deleted,
    fetch-depth fixed, @types/node aligned, CHANGELOG ordering corrected.
  - **L9**: `known-limitations.md` restructured into Current/Resolved sections.

## [0.7.0] — 2026-05-16

### Added

  - Selection range tests: 12 tests for `getSelectionRange()` covering basic
    cases, nested constructs, deduplication, and edge cases (T4.1).
  - Call hierarchy tests: 11 tests for prepare/incoming/outgoing call
    hierarchy. Documents known bug: `collectCallExpressions` looks for
    `call_expression` but tree-sitter-pike produces `postfix_expr` nodes (T4.2).
  - Runtime JSON validation for Pike subprocess responses (`jsonValidation.ts`):
    6 validator functions replace bare `as unknown as` casts with fail-fast
    type guards.
  - `completionItem/resolve` provider for lazy stdlib markdown documentation
    loading on demand instead of eagerly during completion.
  - `workspaceResolution.ts`, `workspaceDependencies.ts`, `workspaceTypes.ts`:
    extracted from `workspaceIndex.ts` for focused module boundaries.
  - `pikeWorkerProcess.ts`, `pikeWorkerTypes.ts`: extracted from
    `pikeWorker.ts`.
  - `serverCapabilities.ts`, `serverLifecycle.ts`: extracted from `server.ts`.
  - `completion-chain.ts`, `completion-callArgs.ts`, `completion-scopeAccess.ts`,
    `completion-snippets.ts`, `completion-stdlib.ts`, `completion-items.ts`:
    extracted from `completionTrigger.ts` and `completion.ts`.
  - `navigationGoTo.ts`, `navigationRefactoring.ts`, `navigationCompletion.ts`,
    `navigationDocumentFeatures.ts`, `navigationAdvanced.ts`,
    `navigationInclude.ts`: extracted from `navigationHandler.ts`.
  - `codeActionSourceActions.ts`, `diagnosticUtils.ts`,
    `declarationBlockCollectors.ts`, `hoverContent.ts`,
    `signatureHelp-resolve.ts`, `pikeDetection.ts`, `completion-scope.ts`,
    `xml-renderer-blocks.ts`, `xml-renderer-inline.ts`, `xml-renderer-types.ts`:
    further module boundary extractions.
  - Golden-file diagnostics test infrastructure: `harness/src/diagnosticsGolden.ts`
    runner produces LSP diagnostic snapshots from tree-sitter parse + lint rules.
    93 tests across 87 corpus files in `harness/__tests__/diagnostics-golden.test.ts`
    (Tier 3.1).
  - `positionConverter.ts` utility: `utf8ToUtf16()` and `utf16ToUtf8()` functions
    with 53 unit tests for UTF-8/UTF-16 position encoding conversion (P1.7).
  - `typeHierarchy` LSP provider: `prepareTypeHierarchy`, `supertypes`, and
    `subtypes` for Pike class hierarchies with 10 tests. Supports cross-file
    inheritance resolution via WorkspaceIndex (Tier 3.5).

### Changed

  - Auto-import completion now uses prefix-indexed binary search
    (`getAutoImportByPrefix`) instead of O(n) linear scan over all stdlib
    entries. Per-keystroke filtering is O(log n + k) where k is the number
    of matching symbols (X3.6).
  - All 13 source files that exceeded the TigerStyle 500-line limit have been
    split into focused modules. Largest file is now 500 lines (was 1166).
  - `outputChannel.clear()` replaced with session separator in client — crash
    logs from previous sessions are preserved.
  - FileSystemWatcher now properly disposed before recreation on config change,
    preventing watcher leaks across restarts.
  - Modernized README.md with complete feature inventory (23 LSP providers),
    architecture overview, and development section.
  - Symbol table pipeline (`toLoc`/`toRange` → `toLocUtf16`/`toRangeUtf16`) and
    19 feature files converted to use UTF-16 position encoding for correct
    non-ASCII character handling (P1.7). Both tree-sitter→LSP and LSP→tree-sitter
    directions covered.

### Fixed

  - Tree-sitter UTF-8 byte offsets are no longer used directly as LSP character
    positions. All position conversions now go through `positionConverter.ts`,
    fixing latent incorrect column values for non-ASCII Pike source files.
  - Removed non-null assertion `targetDecl!` in `workspaceIndex.ts` — replaced
    with narrowed local after null check.
  - Fixed `export { FileEntry }` → `export type { FileEntry }` in
    `workspaceIndex.ts` re-export — bun's ESM loader crashes on runtime
    re-export of type-only symbols.

## [0.6.6] — 2026-05-15

### Added

  - CodeLens provider tests: 7 tests covering reference count lenses, self-
    reference exclusion, singular/plural titles, and mixed declaration scenarios.

### Changed

  - `implementationProvider` and `diagnosticProvider` capabilities are now
    declared in the server's initialize response, enabling clients to discover
    these features correctly.
  - `safeParse()` in `DiagnosticManager` now passes the document URI to the
    parser cache, avoiding redundant re-parses on every diagnostic cycle.
  - PikeWorker priority queue replaced with three FIFO sub-queues (interactive,
    normal, background). Dequeue is now O(1) instead of O(n) linear scan.

### Fixed

  - Rename now returns a descriptive `ResponseError` instead of silent `null`
    when no renamable symbol is at the given position or the new name matches
    the old name.
  - Autodoc renderer sanitizes HTML entities (`<`, `>`, `&`) and escapes
    markdown metacharacters in inline content to prevent injection from
    user-written Pike doc comments.

## [0.6.5] — 2026-05-15

### Fixed

  - Unreachable code lint (P3003) no longer flags `break` after `return` or
    `continue` in a switch case segment. Break-after-return is a common
    defensive pattern (prevents accidental fallthrough if return is later
    removed) and is harmless.
  - Unreachable code lint (P3003) no longer flags comments after a terminator.
    Comments are not executable code and were incorrectly included in the
    named-children scan. Affects both regular blocks and switch case segments.

## [0.6.4] — 2026-05-15

### Added

  - Directory module convention: files inside `Foo.pmod/` now automatically
    see symbols from `Foo.pmod/module.pmod` without explicit `inherit`/`import`.
    This works for hover, go-to-definition, and completions. Pike's module
    system treats `module.pmod` as the implicit parent of all files in the
    same directory module.

## [0.6.3] — 2026-05-15

### Fixed

  - Unreachable code lint (P3003) no longer flags subsequent `case`/`default`
    clauses in a `switch` statement after a `return` or `break`. Each case
    is an independent control-flow entry point. Unreachable code within a
    single case segment is still correctly flagged.

## [0.6.2] — 2026-05-15

### Fixed

  - Hover on cross-file inherited members (e.g. `d->speak()` where `speak`
    comes from an inherited class in another file) now resolves correctly.
    The reference position matcher was using exact character match instead
    of range-based matching, so hovering anywhere other than the start of
    the identifier would fail.
  - Cross-file hover range now highlights the identifier in the requesting
    document instead of pointing to the declaration in the target file.


## [0.6.1] — 2026-05-15

### Added

  - **Intelligent LSP features**: Complete implementation of the intelligent
    features plan (E1-E5, F1-F5, G1-G2, H1-H2, AU1, GS1):

  - **Fast lint layer** (E1-E5): Real-time syntax diagnostics on every keystroke
    via tree-sitter — unused variables/parameters (P3001/P3002), unreachable
    code (P3003), missing return statements (P3004), unused imports (P3005).
    Suppressed on lines where Pike compiler provides diagnostics.

  - **Type-aware completion** (F1): Chained call type inference via
    `resolveChainedType` and `decomposePostfixChain`. Completes members through
    multi-step `d->get_dog()->bark()` chains.

  - **Constructor and method signature help** (F2-F3): Resolves `Dog("Rex",`
    to constructor `create()` params, and `d->bark("hi",` to method signature
    via type -> class -> method lookup.

  - **Commit characters** (F4): `.` and `(` as commit characters in completion
    items for immediate acceptance.

  - **Auto-import suggestions** (F5): When typing an unqualified identifier
    matching a stdlib symbol (e.g., `get_v`), offers completion with
    `additionalTextEdits` that inserts `inherit Module;`. Uses reverse index
    from stdlib-autodoc.json. Suppresses when module is already inherited.

  - **Inlay type hints** (G1): Shows inferred types for untyped variable
    declarations.

  - **Parameter name inlay hints** (G2): Shows `param:` labels at call sites.
    Handles `comma_expr` unwrapping and arrow/dot method resolution. Requires
    tree-sitter-pike v1.2.2+ (issue #18 fixed).

  - **PikeWorker pre-warming** (H1): `warmUp()` during initialization eliminates
    ~200ms cold start on first completion/hover request.

  - **Arity quick-fix** (H2): Code action for "Wrong number of arguments to foo()"
    diagnostics — adds or removes argument slots.

  - **Autodoc template generation** (AU1): Type `//!!` above a function, method,
    class, or variable declaration. Code action replaces it with a `//!` autodoc
    skeleton populated with parameter names and return type sections.

  - **Getters/setters generation** (GS1): Code action on class member variables
    generates `get_name()` / `set_name(value)` methods. Uses declared type for
    return/parameter types. Skips if method already exists.

  - **Call hierarchy**: Incoming/outgoing call hierarchy support
    (`textDocument/callHierarchy`).

  - **Complex type rename support**: `collectTypeRefsRecursive()` now recurses
    `function_type` nodes, ensuring rename propagates through compound type
    annotations like `array(Dog)` and `mapping(Dog:int)`.

  - **Recursive `.pmod` directory discovery**: The harness now recurses into
    `.pmod` directories (which are directories, not files) to discover nested
    Pike sources like `module.pmod` and `helpers.pike`.

  - Updated tree-sitter-pike WASM to v1.2.2 (fixes bare function call parsing,
    issue #18).

### Changed

  - **SignatureHelp rewrite**: `extractCalleeInfo()` now returns `objectName`
    for method calls. `resolveMethodOnType()` does type -> class -> method
    lookup. `resolveConstructor()` uses range overlap for scope discovery.

  - **Removed client-side tree-sitter syntactic provider**
    (`TreeSitterSyntacticProvider`): Server semantic tokens and VSCode TextMate
    grammar already cover all highlighting. The client-side provider was
    redundant and has been deleted.

  - **Hardened `build-vsix.sh`**: `vsce` binary is now resolved from `$PATH`
    with fallback to `$HOME/.bun/bin/vsce` instead of using a hardcoded
    absolute path.

  - **`release.yml` uses `.latest-vsix`**: The upload step now reads the exact
    VSIX path written by `build-vsix.sh`, eliminating BUILD_NUM skew between
    build and release steps.

  - **`ci.yml` uses `$PIKE_VERSION` variable**: Replaced hardcoded `8.0.1116`
    in PATH and PIKE_BINARY entries with the existing `PIKE_VERSION` env var.

### Fixed

  - **Parser cache corruption in tests**: `parse()` uses incremental parsing
    with old tree cache keyed by URI. Tests reusing the same URI across
    different sources got garbled parse trees. Fixed with unique URIs per test.

  - **Non-null assertion safety in completion**: Replaced unsafe `child(0)!`
    with a null-checked loop in dot-access completion, preventing potential
    crashes on unexpected tree-sitter node structures.

  - **Harness uses `PIKE_BINARY` for outer invocation**: `runIntrospect()` was
    passing `PIKE_BINARY` to the introspect script (correct) but using a
    hardcoded `"pike"` string for the outer process that runs the script.

  - **Removed dead `getErrorCount` import** from `client/extension.ts`.

  - **Removed dead `treeSitterProvider` tests**: Two `it.skip` tests that
    referenced the deleted provider have been removed. The remaining output
    channel test is documented as a manual smoke test.

## [0.5.1] — 2026-05-14

### Fixed

  - **Angle-bracket `#include <file>` navigation**: CTRL+CLICK and document links
    now resolve `#include <stdio.h>` directives against Pike's system include paths
    (from `pike --show-paths`). Previously these were explicitly skipped with a
    `return null` bail-out.

  - **UriError on Windows paths**: Replaced fragile `"file://" + encodeURI(path)`
    URI construction with Node.js `pathToFileURL()` across all handlers
    (definition, document link, background index). The old pattern produced
    malformed URIs on paths containing special characters, causing VSCode to
    throw "UriError: Scheme contains illegal characters".

  - **Fact-check audit of `docs/known-limitations.md`**: Corrected 5 factual
    errors — stale "PARTIALLY RESOLVED" / "MOSTLY RESOLVED" statuses for
    `for_statement` and `switch_statement` (both fully resolved), removed a
    fabricated `BLOCK_SCOPES` constant reference, removed stale line-number
    anchors from `typeof_()` entries, and fixed corrupted severity table headers.

## [0.5.0] — 2026-05-14

### Added

  - **Clickable `#include` navigation**: CTRL+CLICK on `#include "file"` directives
    now navigates to the target file. Also exposed as document links (underlined
    clickable path). Requires tree-sitter-pike v1.1.3+ for structured `preproc_include`
    node with `path` field.

  - **Corpus manifest management tool** (`scripts/manifest.ts`): Scans `corpus/files/`,
    parses `manifest.md`, detects drift between disk state and manifest entries.
    Supports `--sync` to apply changes, `--version <VERSION>` to bump the manifest
    version. Registered as `pike-corpus-manifest` Hermes skill.

  - **4-space indentation default**: New Pike files now default to 4-space
    indentation via `configurationDefaults` in the extension manifest. Configurable
    per-workspace and per-file through VSCode settings.

  - **Repository-based TextMate grammar**: Rewrote `pike.tmLanguage.json` with a
    repository-based structure using standard scope names (`storage.type.pike`,
    `entity.name.function.pike`, `entity.name.type.class.pike`, `variable.parameter`).
    Ensures consistent syntax highlighting across all VSCode themes.

### Changed

  - **Formatter default tab size**: Changed from 2-space to 4-space fallback when
    VSCode does not pass explicit formatting options.

  - **PikeWorker idle eviction**: Now calls `this.stop()` instead of raw
    `this.proc.kill("SIGTERM")`, ensuring SIGKILL escalation and proper cleanup
    on idle timeout.

  - **PikeWorker pending rejection**: `stop()` now rejects all pending promises
    in the response map before clearing it, preventing leaked promises on restart.

### Fixed

  - **EACCES during background indexing**: Permission errors (EACCES, EPERM, ENOENT)
    during workspace file indexing are now logged as warnings instead of errors
    and excluded from the error count. Expected on shared servers with inaccessible
    directories.

  - **Cross-file go-to-definition**: Navigation on imported/inherited symbols now
    uses `decl.sourceUri` to navigate to the original source file, not the file
    where the symbol was inherited into.

  - **Implicit class navigation fallback**: `import Foo` and `inherit Animal` now
    navigate to the top of the target `.pike`/`.pmod` file when no explicit `class`
    declaration is found (covers the common case where a `.pike` file IS the class).

  - **Corpus manifest sync**: 10 new corpus files that were on disk but not in the
    manifest have been added: `basic-int-ranges.pike`, `basic-string-types.pike`,
    `basic-type-conversions.pike`, `cross_import_a.pmod`, `err-syntax-partial.pike`,
    `err-type-member.pike`, `import-relative.pike`, `stdlib-array.pike`,
    `stdlib-mapping.pike`, `stdlib-string.pike`.

  - **Updated tree-sitter-pike WASM** to v1.1.3 with structured `preproc_include`
    node (upstream fix for TheSmuks/tree-sitter-pike#17).

## [0.4.3] — 2026-05-14

### Added

  - **SIGKILL escalation in PikeWorker.stop()**: If the Pike subprocess does not
    exit within 3 seconds of SIGTERM, the server escalates to SIGKILL. This
    prevents zombie Pike processes on shared SSH dev servers where resources are
    limited.

  - **Process signal handlers in server main.ts**: `process.on('exit')`,
    `process.on('SIGTERM')`, and `process.on('SIGINT')` handlers now call
    `worker.stop()` as a last resort, ensuring the Pike subprocess is cleaned up
    even when the Node server process is force-killed.

  - **Stale VSIX cleanup**: `build-vsix.sh` removes old VSIX files from `out/`
    before creating a new one. Previously they accumulated indefinitely.

  - **Shutdown test suite** (`tests/lsp/shutdown.test.ts`): 22 tests covering
    PikeWorker.stop() (subprocess termination, SIGKILL escalation, queue cleanup,
    idempotency), server onShutdown (diagnosticManager disposal, index clearing,
    autodoc cache clearing, LSP shutdown protocol), force-close resilience, and
    createPikeServer interface contract.

### Changed

  - **install-extension.sh**: Removed redundant `bun run build:extension` step
    (already done by `build-vsix.sh`). Cleaned up phase numbering.

### Fixed

  - **Build suffix doubling**: `build-vsix.sh` now strips any existing `+NNNNNN`
    build suffix from the version string before appending a new one, preventing
    corrupted version strings like `0.4.2+704238+704238`.

  - **VSIX install path mismatch**: `install-extension.sh` reads the actual VSIX
    path from a `.latest-vsix` marker file produced by `build-vsix.sh`, instead of
    guessing the filename. Previously it looked for `pike-language-server-0.4.2.vsix`
    (no suffix) but the build produced suffixed names.

  - **Stale OutputChannel logs**: `activate()` now calls `outputChannel.clear()`
    before logging anything. VSCode OutputChannel content survives window reloads,
    which caused old version entries from previous installs to accumulate and appear
    as if multiple versions were running simultaneously.

## [0.4.2] — 2026-05-13

### Added

  - **Structured init logging**: The entire extension startup sequence is now
    logged as numbered steps across both client and server. Each step logs
    before and after execution, so the last logged step identifies where
    startup failed. Client logs to the "Pike Language Server" output channel
    (`[init] step 1/6` through `step 6/6`). Server logs to stderr before
    connection (`[init] step 1/5` through `5/5`) and to the LSP console after
    (`[init] step 6` through `7e`). Tree-sitter initialization on the client
    side logs `[tree-sitter] step 1/4` through `4/4` to the VSCode console.

  - **Centralized error logging**: All server-side errors now route through
    `server/src/util/errorLog.ts` (`logInfo`, `logWarn`, `logError`). The format
    is `<ISO timestamp> <LEVEL> <message>`. Zero `connection.console.log/error`
    calls remain outside the logging module itself.

  - **Status bar error badge**: The status bar shows `(N errors)` with error
    styling when the server reports errors. Clicking opens the output channel.

  - **Global error handlers**: `main.ts` installs `uncaughtException` and
    `unhandledRejection` handlers before any other code runs, ensuring startup
    crashes are logged instead of silently swallowed.

### Fixed

  - **Dual connection.listen() crash**: Removed the `isDirectExecution()` entry
    block from `server.ts`. When esbuild bundled both `server.ts` and `main.ts`,
    two `connection.listen()` calls executed on the same stdio transport,
    corrupting LSP protocol state and causing `FullTextDocument._content` to
    become `undefined` — the root cause of "Cannot read properties of undefined
    (reading 'charAt')" on file open.

  - **Portable snapshot paths**: The harness now normalizes absolute paths
    embedded in Pike diagnostic messages (e.g. include resolution errors)
    using a `<ROOT>` placeholder. The `cpp-include.pike` snapshot no longer
    contains a machine-specific path, fixing CI on different environments.

## [0.4.1] — 2026-05-13

### Fixed

  - **Client-side tree-sitter initialization**: `TreeSitterSyntacticProvider.#init()`
    now calls `Parser.init()` before `Language.load()`. Without this call, the
    Emscripten WASM runtime (`C`) was never initialized, causing all tree-sitter
    operations on the client side to fail silently. This was the root cause of
    missing syntax highlighting and the "Unable to open: Cannot read properties of
    undefined (reading 'charAt')" error in v0.4.0.

  - **VSIX packaging**: `build-vsix.sh` now copies `web-tree-sitter.wasm` to
    `client/dist/` in addition to `server/dist/`. The client resolves WASM paths
    relative to `extension.cjs` (which lives in `client/dist/`), so the runtime WASM
    must be present there for `Parser.init()` to succeed.

## [0.4.0] — 2026-05-13

### Added

  - **pike-fmt integration**: `scripts/fmt.sh` wrapper and `fmt:check`/`fmt:write`
    npm scripts for formatting Pike source files in the repo. CI checks formatting on
    every push/PR via the `pike-fmt` job in `.github/workflows/ci.yml`.
  - **tree-sitter highlights for Neovim/Helix**: `queries/highlights.scm` provides
    syntax highlighting queries for nvim-treesitter and Helix via tree-sitter.
    Captures include `@keyword.import` for inherit/import, `@function.method`,
    `@variable.parameter`, `@constant`, and `@preproc`.

  - **TextMate grammar test**: `harness/__tests__/tmLanguage.test.ts` validates
    that the grammar JSON contains all required keyword patterns.

  - **languageConfiguration test**: `tests/lsp/languageConfiguration.test.ts`
    validates that `language-configuration.json` is valid JSON with all required keys.

  - **Skipped cross-file completion test**: `tests/lsp/completion.test.ts` includes
    a skipped test for cross-file inherited member completion, referencing the
    known limitation entry in `docs/known-limitations.md`.

  - **Open Issues tracked**: `TRACKING.md` Open Issues table now tracks
    TextMate grammar tokenization coverage and cross-file inherited member completion.

  - **tree-sitter workarounds annotated**: `server/src/features/declarationCollector.ts`
    now includes `TODO(tree-sitter-pike#2)` and `TODO(tree-sitter-pike#4)` markers
    on the remaining tree-sitter-pike grammar workarounds.

  - **Cross-file inheritance gap documented**: `docs/known-limitations.md` now
    documents that `Dog d; d->` returns only same-file members when `Dog`
    inherits from a cross-file class.

  - **AI agent scaffolding documented**: `CONTRIBUTING.md` now includes an
    "AI Agent Scaffolding" section describing `.omp/skills/` conventions.

  - **Neovim/Helix highlights documented**: `docs/other-editors.md` now includes
    setup instructions for nvim-treesitter and Helix tree-sitter queries.

### Changed

  - **Text document sync**: Switched from Full to Incremental sync
    (`TextDocumentSyncKind.Incremental`). Client now sends only the changed
    range per keystroke instead of the entire document, reducing latency on
    large files. Decision 0023.

  - **PikeWorker priority queue**: Converted the PikeWorker FIFO queue to a
    priority queue. Interactive requests (hover, completion, navigation) are
    now serviced before background work (diagnostics), preventing visible
    latency when the diagnostic manager is busy. Decision 0024.

  - **Completion quality**: Added `filterText` to all completion items so the
    client fuzzy-matches against the plain identifier regardless of label
    content. Added `detail` (type annotation) to declaration completions.

  - **Cancellation propagation**: Added `CancellationToken` checks to all LSP
    request handlers that were missing them: documentSymbol, documentHighlight,
    foldingRange, signatureHelp, codeAction, workspace/symbol, and formatting.
    All handlers now bail early when a newer request supersedes them.

  - **Selection range**: Implemented `textDocument/selectionRange` for
    shrink/expand selection. Walks the tree-sitter AST from cursor position
    upward, collecting ranges for meaningful node types (declarations, blocks,
    expressions). Decision 0025.

  - **On-type formatting**: Added `documentOnTypeFormatting` provider triggered
    by `}` and `;`. Reuses the existing pike-fmt formatter but returns only
    the edits near the trigger line for responsiveness. Decision 0025.

  - **Completion textEdit**: All completion items now include a `textEdit`
    that replaces the identifier prefix being typed. Fixes the "foo.bbar"
    doubling bug when completing after a dot. Decision 0025.

  - **Completion snippets**: Function and method completions now include
    LSP snippet tab stops for parameters (e.g., `write(${1:string})`).
    Gracefully degrades to plain insertion when type info is unavailable.
    Decision 0025.

  - **Call hierarchy**: Implemented `textDocument/prepareCallHierarchy`,
    `callHierarchy/incomingCalls`, and `callHierarchy/outgoingCalls`.
    Incoming calls use the cross-file reference index. Outgoing calls walk
    the tree-sitter AST to find `call_expression` nodes and resolve callees.
    Decision 0026.

  - **Code lens**: Added reference count annotations above function and
    method declarations. Uses the workspace index to count references across
    the workspace. Decision 0026.

  - **Code actions**: Added three new code action kinds:
    `source.fixAll` (apply all quick-fixes at once),
    `source.organizeImports` (sort and deduplicate import statements),
    `refactor.extract.variable` (extract selected expression to a local
    variable with auto-generated name). The codeActionProvider now
    advertises all supported kinds for VSCode's lightbulb menu.

  - **Syntax highlighting**: Expanded TextMate grammar (`client/syntaxes/pike.tmLanguage.json`)
    from 6 patterns (comments + strings only) to 21 patterns covering keywords
    (control flow, declaration, other), modifiers, type keywords, built-in constants,
    preprocessor directives, operators, and punctuation. Keywords, types, operators,
    and constants are now colorized immediately on file open with zero indexing delay.
    Previously only comments and strings were highlighted.

  - **Removed build artifacts**: `out/pike-language-server-*.vsix` and scratch
    files `test2.md`, `test-changelog.md` are no longer tracked by git.

  - **pike-fmt upgraded to v0.1.5**: Uses npm semver (`^0.1.5`). The npm package
    bundles `tree-sitter-pike.wasm` in `dist/`. `.pmod` files are now discovered
    by `pike-fmt` ([TheSmuks/pike-fmt#17]). `scripts/fmt.sh` sets `PIKE_FMT_WASM`
    to bypass a bundled-`__dirname` bug in `dist/cli.js` ([TheSmuks/pike-fmt#16]).
    A `postinstall` script (`scripts/postinstall-pike-fmt.js`) symlinks
    `web-tree-sitter.wasm` into `dist/` for the bundled tree-sitter runtime.

### Fixed

  - **Critical: client-side tree-sitter WASM loading broken** — esbuild's CJS output
    set `import.meta` to an empty object, making `import_meta.url` undefined.
    `web-tree-sitter` could not locate its WASM runtime, silently breaking
    semantic token highlighting in the editor.  The build script now patches
    the bundled output so `import_meta.url` resolves to the bundle's real path.

  - **Server `isMain` detection broken in Node.js** — `import.meta.main` is a
    Bun-only property; in Node.js it is always `undefined`, so the fallback
    branch never called `connection.listen()`.  Production use was unaffected
    (the `PIKE_LSP_STDIO` env-var guard in `main.ts` covers that), but running
    the server standalone under Node.js silently exited.  Replaced with a
    `process.argv[1]` comparison that works in both runtimes.

  - **Typecheck errors**: Fixed 21 TypeScript errors introduced in Phases B–D
    that were not caught locally. Added `'method'` to the `DeclKind` union type
    and all `Record<DeclKind, ...>` maps. Fixed `Reference` property access
    (`ref.line` → `ref.loc.line`) in call hierarchy and code lens. Fixed
    `SelectionRange` property access (`lastRange.start` →
    `lastRange.range.start`) in selection range. Fixed wrong variable name
    (`stdlibTopLevel` → `stdlibTopLevelNames`) in completion cache reset.

  - **Cross-file inherited member completion tests**: Fixed two structural syntax
    errors in `tests/lsp/completion.test.ts` that prevented cross-file inheritance
    completion tests from executing:
    1. Missing `});` closing brace on the US-001 test (~line 988), causing it to
       merge with the subsequent test.
    2. Extra `});` at end of file (~line 1286), causing a parse error.
    Removed the `describe.skip("Cross-file inherited member completion")` placeholder
    — the feature was already fully implemented; only the tests were broken.
    All cross-file inheritance tests now pass (US-001, CB-2, US-002, US-007, US-008).

  - **sigHelp.second-param SKIP → PASS**: `resolveSignature()` in
    `server/src/features/signatureHelp.ts` was looking up the class scope
    with `table.scopes.find(s => s.declarations.includes(classDecl.id))`.
    `Dog`'s `scopeId` is the file scope, not the class scope, so this
    returned the file scope — which does not contain `create`'s ID. The
    `createDeclId` was always `undefined`, causing the constructor lookup
    to fall through to stdlib (no `predef.Dog`) and return `null`.
    Fix: use `findClassScope(table, classDecl)` from `typeResolver.ts`,
    which correctly finds the class body scope via `kind === 'class'`
    and range containment.

  - **textDocument/references respects includeDeclaration**: The `onReferences`
    handler now adds the declaration location to the results when
    `params.context.includeDeclaration` is `true`, in both cross-file and
    same-file paths with duplicate-avoidance logic.

  - **documentLink fallback for unresolvable modules**: `collectInheritLink`
    in `documentLink.ts` now emits a `pike://modules/...` link even when the
    module cannot be resolved, instead of silently omitting the link.

  - **health-check.ts test suite**: Fixed 6 needle/position issues and 1 test
    structure error in the LSP health-check test file (`tests/health-check.ts`):
    `refs.method`, `refs.parameter`, `rename.prepare-valid`, `rename.execute`,
    `highlight.variable`, `hover.variable-type`, and `codeAction.unused-var`.

## [0.3.3-beta] — 2026-05-05
## [0.3.5-beta] — 2026-05-06
