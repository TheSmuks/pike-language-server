# Changelog

All notable changes to the Pike Language Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

  




## [Unreleased]

## [0.3.5-beta] — 2026-05-06

### Fixed

  - **LSP server never started**: The `PIKE_LSP_STDIO` environment variable was
    placed at the wrong level in `ServerOptions` NodeModule objects in
    `client/extension.ts`. The NodeModule interface has no top-level `env`
    property — `env` belongs inside `options: ForkOptions`. vscode-languageclient
    silently ignored the unknown property, so the env var never reached
    `server/src/main.ts`. In `main.ts`, `shouldListen()` checks
    `process.env.PIKE_LSP_STDIO === "1"` — it returned `false`, so
    `connection.listen()` was never called. The LSP server process exited
    immediately, and all 16 LSP capabilities (hover, go-to-definition,
    completion, diagnostics, etc.) were unreachable despite being correctly
    declared and wired. Fix: move `env` inside `options` on both `run` and
    `debug` entries.

  - **Worker startup crash when Introspect unavailable**: `harness/worker.pike`
    `handle_resolve()` now uses `master()->resolv("Introspect")` for runtime
    module resolution instead of a compile-time `import Introspect`. Pike's
    `import` is a compile-time directive — when Introspect is absent (as in the
    VSIX), the entire script failed to compile with "Module is neither mapping
    nor object". The worker now gracefully degrades and returns
    `"Introspect module not available"` instead of crashing on startup.
  ### Changed

  - **Integration test architecture**: `tests/integration/` rewritten with
    proper Mocha `describe`/`it` structure. Extension host runs tests as
    CommonJS (`__dirname` required). `run-tests.ts` now calls compiled
    `dist/run-tests.js` (Bun strips `__dirname`). Lock cleanup added.
    Layer 2 narrowed to wiring-only scope; correctness assertions live in
    Layer 1 (`tests/lsp/`).

## [0.3.6-beta] — 2026-05-07

wk|### Added
  - **Adopt rust-analyzer non-blocking parser readiness pattern**: `isParserReady()`
  - **Build number in VSIX and extension log**: VSIX filenames and extension
    activation logs now include a unique build number (last 6 digits of Unix
    epoch seconds) via `+<build>` suffix, e.g. `0.3.5-beta+559491`. Build number
    is baked into the client bundle at compile time via esbuild `--define`.
    The extension logs `Version <version>+<build>` on activation so users can
    identify which build they are testing without looking at file timestamps.
    replaces `await parserReady` in `onDidChangeContent`. Handler returns
    immediately when parser is not initialized, avoiding blocking during WASM
    load. Document is re-processed on next keystroke.

  - **Adopt gopls sentinel pattern for content guards**: Changed compound guard
    `if (!content && content !== "")` to explicit `if (content === undefined ||
    content === null)` with error logging. Distinguishes "unexpected null"
    (logged, skipped) from "valid empty" (proceeds normally). Applied to
    `onDidChangeContent` (server.ts) and `onDidOpen` (navigationHandler.ts).

  - **Documentation**: Both patterns documented in `docs/lsp-references.md`


### Fixed

  - **Graceful degradation without Pike**: PikeWorker now detects missing Pike
    binary (exit code 127) and sets `pikeAvailable = false`, skipping spawn on
    subsequent requests. No more stderr spam on every request. Server stays up
    with tree-sitter-only features (symbols, highlights, folding, formatting).
    Added `PikeUnavailableError` and `isAvailable` getter to `PikeWorker`.

  - **Duplicate log lines in output panel**: Removed `{ log: true }` from the
    VSCode `OutputChannel` creation. The `{ log: true }` channel auto-timestamps
    `window/logMessage` notifications AND passes them through raw, causing each
    server message to appear twice. The extension already adds its own timestamps.

  - **One-time user notification**: When Pike is not found, the server now shows
    a single warning via `window/showWarningMessage` in `onInitialized` instead
    of spamming the console. Tree-sitter-only features remain fully functional.

## [0.3.7-beta] — 2026-05-07

### Fixed

  - **Server bundle banner quoting**: Moved server esbuild invocation into
    `scripts/build-server.sh` to fix `from'module'` single-quote collision
    that produced `frommodule` — a syntax error preventing the server from
    starting.

## [Unreleased]

### Fixed

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

### Changed

  - **Syntax highlighting**: Expanded TextMate grammar (`client/syntaxes/pike.tmLanguage.json`)
    from 6 patterns (comments + strings only) to 21 patterns covering keywords
    (control flow, declaration, other), modifiers, type keywords, built-in constants,
    preprocessor directives, numeric literals, operators, and punctuation. Keywords,
    types, operators, and constants are now colorized immediately on file open with
    zero indexing delay. Previously only comments and strings were highlighted.

  ## [0.3.4-beta] — 2026-05-05

### Added

  - **Pre-flight check script**: `scripts/preflight.sh` runs the full test suite before a release (typecheck, build, bun test, pike tests via pmp, harness tests, e2e tests). Fails fast on the first error.
  - **pmp-guide skill**: New skill documenting `pmp` usage conventions — use `pmp run` instead of raw `pike -M`.
  - **cut-release skill Phase 1.5**: Added pre-flight checks documentation, corrected `--skip-e2e` rationale, updated manifest count.
  - **release.sh pre-flight note**: Added NOTE block directing users to run preflight.sh before executing the release script.

  ### Changed

  - **preflight.sh step 4**: Now uses `bun run test:pike` (wraps `pmp run`) instead of raw `pike -M modules -M harness`. Adds `~/.pmp/bin` to PATH so pmp is found in local dev environments.
  - **preflight.sh `--skip-e2e`**: Corrected rationale — "requires `@vscode/test-electron` setup" instead of "requires a display server".
  ## [0.3.2-beta] — 2026-05-05

### Added

  **VSCode marketplace presentation**: Extension `package.json` enriched with
  icon (256x256 Pike fish picturemark), keywords, categories, galleryBanner,
  repository, homepage, license, and `extensionKind`. Five settings now declared
  in `contributes.configuration` so they appear in VS Code settings UI:
  `path`, `pikeFmtPath`, `diagnosticMode`, `diagnosticDebounceMs`,
  `maxNumberOfProblems`. `README.md` rewritten for marketplace presentation with
  Quick Start, feature list, configuration table, troubleshooting, and links.
  `build-vsix.sh` updated to include `CHANGELOG.md` in VSIX.

  ## [0.3.1-beta] - 2026-05-05
  
  ### Fixed
  
  **Extension activation crash**: `scripts/build-vsix.sh` now copies
  `client/language-configuration.json` into the VSIX so it is present at the
  extension root. Previously the file was missing from the packaged VSIX,
  causing the extension to crash silently when reading it on activation.
  
  ### Added
  
  **Output channel and status bar**: `client/extension.ts` now creates a log
  output channel ("Pike Language Server") and a status bar item that reflects
  server state: spinning icon while starting, zap icon while running, warning
  icon on error. State transitions are logged with timestamps. A custom
  `errorHandler` routes server errors to the output channel instead of showing
  popup dialogs. Clicking the status bar item opens the output channel.
  
  
  ## [0.3.0-beta]

  
  ### Added
  
  **`extensionKind: ["workspace"]`**: VSCode extension now declares it must run on the workspace/remote side. Required for Remote-SSH deployment where the extension and all subprocesses (pike, pike-fmt, tree-sitter WASM) live on the remote server.
  
  **`pike.languageServer.pikeFmtPath` configuration**: Users can now configure the pike-fmt binary path via VS Code settings (`pike.languageServer.pikeFmtPath`). Previously only configurable via `initializationOptions`. `client/extension.ts` now passes this through to the server.
  
  **Formatting integration (Phase B)**: `server/src/features/formattingHandler.ts` now passes correct `--tab-size` arg to pike-fmt (removed invalid `--indent-width`). pike-fmt CLI fixed to load tree-sitter-pike.wasm correctly in bundled output. Published to npm (`pike-fmt@0.1.3`) and added as LSP dependency.
  
  **Formatting tests**: New integration tests for the formatting handler covering graceful failure, real pike-fmt binary, and idempotency (`tests/lsp/formatting.test.ts`, 13 tests).
  
  ### Documentation
  
  **Decision 0020 updated**: Status changed from "In Progress" to "Phase B/C complete". Phase D (tests, corpus verification) is in progress.
  
  **known-limitations.md updated**: "pike-fmt not integrated" severity lowered from "Medium" to resolved. pike-fmt is now bundled and working.

## [0.3.3-beta] — 2026-05-05

### Added

  Placeholder for next release.

## [0.2.0-beta]

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

**CI**: Upgraded `actions/cache` from v4 to v5.

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


- Remove unused variables and imports across 6 files
- PikeDiagnostic interface: added optional `code` field
- Documentation cleanup: TRACKING.md updated through Phase 21




**Documentation cleanup**: Updated TRACKING.md with Phases 17-21, updated state-of-project.md title to Phase 21, documented scopeBuilder.ts re-export facade, added "PERMANENT" markers to known-limitations for unfixable items (.so modules, joinnode, import resolution).

**PikeDiagnostic interface**: Added optional `code` field for compiler error codes.


**Test infrastructure critical bug**: `createTestServer()` in `tests/lsp/helpers.ts`
now sends `processId: null` in the `initialize` request. The vscode-languageserver
watchdog requires this field; omitting it caused `kill(undefined)` to be called,
making 16 of 34 LSP test files hang indefinitely.

**Syntax error in completion.test.ts**: Fixed missing closing braces that caused
the entire file to fail parsing. The file now runs all completion integration tests.

**Dead code removal from hoverHandler.ts**: Removed 12 lines of no-op code in the
`needsPikeTypeof` branch that fetched `typeof_()` results from PikeWorker but did
nothing with them. The hover always fell through to the tree-sitter fallback.


Remove unused variables and imports: `inferredSig` in `hoverHandler.ts`,
`FileEntry` in `persistentCache.ts`, `SCOPE_INTRODUCERS`/`BLOCK_SCOPES`
in `declarationCollector.ts`, `rangeSize` in `completion-scope.ts`,
`ctx` parameter in `codeAction.ts`.


>>>>>>> 749628b (fix: health-check tests and includeDeclaration support)
### Fixed

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

## [0.3.5-beta] — 2026-05-06
