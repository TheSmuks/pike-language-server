# Changelog

All notable changes to the Pike Language Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha] - 2026-04-26

### Added

- Project initialized from ai-project-template.

## Phase 5: Types and Diagnostics - 2026-04-28

### Added

- Pike worker subprocess: long-lived Pike process for diagnostics and type queries
  - JSON-over-stdio protocol: diagnose, typeof, ping methods
  - CompilationHandler-based structured diagnostics (errors + warnings)
  - Same normalization as harness introspect.pike (expected/actual type extraction)
- PikeWorker TypeScript class: subprocess lifecycle management
  - Lazy start, automatic crash recovery, timeout (10s), restart with readiness check
  - Content-hash caching: sha256-keyed per-file cache, undo operations are free
- Save-triggered diagnostic pipeline (decision 0011)
  - didSave → Pike worker → structured diagnostics → merged with parse diagnostics
  - Position mapping: Pike 1-based lines → LSP 0-based lines
  - Diagnostic severity mapping: Pike error/warning → LSP Error/Warning
- Hover handler: three-source routing per decision 0002
  - Same-file: tree-sitter declaration → signature extraction
  - Cross-file: WorkspaceIndex resolution → signature from target
  - Stdlib: reserved for Pike runtime integration (Phase 6)
- Decision 0011: Types, diagnostics, and hover architecture
- harness/resolve.pike: cross-file resolution ground truth from Pike's perspective
  - Parses inherit/import declarations, resolves via master()->resolv() and cast_to_program()
  - Handles .pmod file modules, .pmod directory modules (joinnodes), .pike string-path inherits
  - 7 resolution snapshots, 5 oracle tests comparing LSP vs Pike
- Extension packaging: esbuild bundles for server and client
  - Server bundle: ~203KB, Client bundle: ~768KB
  - build:extension script in package.json
- @vscode/test-electron integration tests (3 tests in VSCode extension host)
  - Extension activates when .pike file opened
  - documentSymbol returns symbols for corpus files
  - Error recovery: malformed input doesn't crash
- resolveInheritTarget fix: .pmod module identifier inherits (e.g., `inherit cross_lib_module`)

### Fixed

- resolveInheritTarget: .pmod file inherits treated like string literal inherits (was treated like class identifier)
- Directory module normalization: LSP resolves `cross_pmod_dir` → `cross_pmod_dir.pmod/module.pmod`, Pike resolves to `cross_pmod_dir.pmod` — test normalizes these as equivalent

### Testing

- PikeWorker subprocess tests: 12 tests (lifecycle, diagnostics, concurrent requests)
- Diagnostics pipeline tests: 7 tests (type errors, position mapping, content-hash caching)
- Hover tests: 6 tests (function, variable, class, empty position, range, references)
- Oracle tests: 5 tests comparing LSP vs Pike resolution
- Integration tests: 3 tests running in VSCode extension host
- Total test suite: 863 tests, 7446 assertions, 0 failures
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