# Changelog

All notable changes to the Pike Language Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

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
