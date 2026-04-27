# LSP Architecture References

This document maps hard LSP problems to the implementations that solve them well. When designing a new feature for the Pike LSP, check this file first. Most of these problems have been solved by other LSPs over years of work, and reproducing the solution is faster and lower-risk than rediscovering it.

The pattern: each section names a problem, names the LSP(s) that solved it, and points at the specific code or design document. Read the linked source before designing your solution. Don't copy wholesale — most of these LSPs are larger than what we need — but understand the shape of their answer before inventing your own.

## The Snapshot pattern (immutable workspace views)

**Problem.** LSP requests are concurrent. The user types a character while the server is computing hover information from a previous cursor position. Without care, the response combines parse-tree state from time T1 with type-info from time T2 and produces inconsistent results.

**Solution: gopls's Snapshot.** Every LSP request operates on an immutable Snapshot — a frozen view of the workspace at a point in time. New edits create a new Snapshot; in-flight requests on the old one complete or get cancelled but never see partial state.

**Where to look.** golang.org/x/tools/gopls/internal/cache. The `Snapshot` type and `Session` type. Each request handler in internal/lsp receives a snapshot at the start and uses it throughout.

**Apply to Pike LSP.** Phase 2 already needs this even for documentSymbol. By phase 5, you'll be combining tree-sitter parse trees, pike runtime introspection, AutoDoc XML, and source-parsed type info — four sources that all need to be from the same snapshot. Build the abstraction in phase 2 when there's only one source; extend it in later phases.

## Request cancellation

**Problem.** A request becomes stale because the user keeps typing. Computing the response is wasted work — and worse, the response may arrive after the cursor has moved, producing wrong UI behavior.

**Solution: Context-based cancellation.** gopls passes context.Context through every handler. When the client cancels (via $/cancelRequest) or supersedes (via a newer request to the same method), the context is cancelled, and handlers check it at every expensive step.

**Where to look.** gopls/internal/lsp/server.go and individual request handlers. Look for `ctx.Err()` checks at boundaries.

**Apply to Pike LSP.** TypeScript doesn't have Go's context.Context, but vscode-languageserver-node provides CancellationToken. Every request handler that takes more than a few milliseconds must accept and check the token. Specifically: any phase-5 handler that invokes pike (a slow operation) must check cancellation before invocation, after invocation, and ideally during invocation if the harness can be made to honor cancellation.

## Modification source tracking

**Problem.** Different file changes warrant different invalidation strategies. A didOpen needs full processing. A didChange might only need to update the AST. A didChangeConfiguration requires rebuilding everything.

**Solution: gopls's ModificationSource.** An enum (FromDidOpen, FromDidChange, FromDidChangeWatchedFiles, FromDidSave, FromDidClose, FromDidChangeConfiguration) tagged onto every workspace modification. Cache invalidation logic dispatches on the source.

**Where to look.** gopls/internal/lsp. Search for `ModificationSource`.

**Apply to Pike LSP.** Phase 4 (workspace model). When file change events arrive, knowing whether they're from VSCode's didChange (incremental edit), didChangeWatchedFiles (external editor), or didSave (explicit user action) changes how aggressively to invalidate.

## Diagnostic debouncing

**Problem.** Running the type checker on every keystroke melts the CPU. Running only on save makes errors feel stale. Some middle ground is needed.

**Solution: gopls's diagnostic pulses.** Diagnostics are computed in batches with debouncing. The default is to wait until the user stops typing for a configurable interval, then run the full type-check pipeline. Save events trigger immediate diagnostics. Configuration-driven.

**Where to look.** gopls/internal/lsp/diagnostics.go (or successor file). The `diagnoseSnapshot` function and its invocation pattern.

**Apply to Pike LSP.** Phase 5. CompilationHandler-based diagnostics are fast but not free. Initial implementation can be save-only. Real-time-with-debouncing is a refinement once the basic pipeline works. Don't try to ship real-time-with-debouncing in phase 5 — get save-triggered working first.

## Cross-translation-unit indexing (relevant for cross-file resolution)

**Problem.** Going from "this identifier" to "its definition somewhere in the workspace" requires an index. The index has to handle hundreds of thousands of symbols, update incrementally, and survive the user editing files.

**Solution variants:**

- **gopls's package graph.** Each Go package is a node; dependencies are edges. When a file changes, gopls invalidates the package containing the file plus everything that transitively imports it. Cached AST and type info per package.

- **rust-analyzer's salsa-based query system.** Every analysis result is memoized as a function of its inputs. Changing an input invalidates the cached result and everything that depends on it. More general than gopls's approach, more complex to implement.

- **clangd's index.** A persistent on-disk index of symbols across the workspace. Built incrementally. Survives across server restarts.

**Where to look.**
- gopls/internal/cache for the package graph approach
- rust-analyzer's `crates/base-db` and `crates/hir` for the query-based approach
- clangd's index/ directory for the on-disk index approach

**Apply to Pike LSP.** Phase 4. Pike's module system (.pmod directories, inherits, imports) maps roughly to Go's package model. Start with a gopls-style approach: in-memory index, .pmod-granularity invalidation, no on-disk persistence. If performance becomes an issue at scale, look at clangd's index for inspiration; rust-analyzer's salsa is overkill.

## Wrapping an external type checker

**Problem.** The LSP doesn't implement the language semantics; it wraps a tool that does. The wrapping layer is where most of the work is.

**Solution variants:**

- **typescript-language-server.** Wraps tsserver, the same type checker the TypeScript compiler uses. Communication via JSON over stdin/stdout. The LSP layer translates between LSP protocol and tsserver's request/response format.

- **gopls (in-process variant).** Type checker is `go/types`, in-process. No IPC overhead, but tightly coupled to the Go release.

- **pyright.** Type checker and LSP share a process and data structures. Most tightly integrated.

**Where to look.**
- typescript-language-server: github.com/typescript-language-server/typescript-language-server. Look at how it manages tsserver subprocess lifecycle and request multiplexing.
- gopls: in-process, less directly applicable.
- pyright: github.com/microsoft/pyright. The `pyright-internal` package shares types between the checker and the server.

**Apply to Pike LSP.** This is structurally what we're building. pike-ai-kb's MCP server is the closest analog — an out-of-process Pike runtime that the LSP queries. The typescript-language-server pattern of subprocess management is the most directly applicable: keep the pike process alive across requests, multiplex requests onto it, handle subprocess crashes, restart on failure. Read its src/lsp-server.ts for the pattern.

## Preprocessor and macro handling

**Problem.** C-family languages with preprocessors create cross-translation-unit dependencies that pure parser-based approaches don't see. Tree-sitter doesn't preprocess; the parse tree is of the source text, not the post-preprocessor text.

**Solution: clangd.** Uses clang's actual preprocessor. The LSP works on post-preprocessor token streams. Headers are tracked as inputs to the cached compilation result. When a header changes, every translation unit that includes it is invalidated.

**Where to look.** clangd/clangd. The PreambleAST and TUScheduler classes.

**Apply to Pike LSP.** Pike has a preprocessor (#if/#ifdef/#define) but it's used much less than C's. Most Pike code doesn't preprocess in ways that change syntactic structure. The 11 KL-007 files in tree-sitter-pike are the cases where preprocessor splits a syntactic construct, and the documented limitation is that those files aren't fully parseable. For phase 5, when full type information requires pike's view of the program (which IS post-preprocessor), the LSP gets the right answer for free because pike preprocesses before reporting types. The complication is mapping pike's diagnostics (which use post-preprocessor positions) back to source positions for the LSP. clangd has solved this exact problem; the relevant code is in clangd/SourceCode.cpp.

## Performance: when things get slow

**Problem.** LSPs that work fine at 100 files become unusable at 10,000. The naive implementation reparses, retypechecks, or rescans on every request.

**Solution: aggressive caching with explicit invalidation.** Every LSP that scales does this. The Snapshot pattern is one half; per-file caches keyed on content hash are the other half.

**Where to look.**
- gopls/internal/cache: the package cache.
- rust-analyzer's salsa: query-level caching.
- clangd: preamble caching for the compiled prefix of large headers.

**Apply to Pike LSP.** Phase 4 onward. Cache parse trees by content hash. Cache pike introspection results until the file changes. When the user reverts a change, the cached result is still valid (content hash matches) — don't re-run pike.

## Configuration and capabilities

**Problem.** Different editors support different LSP features. Different users want different settings. The server must negotiate capabilities at initialize time and respect configuration changes mid-session.

**Solution.** Standard LSP — handle initialize.capabilities, handle workspace/configuration, handle workspace/didChangeConfiguration. Most LSP libraries (vscode-languageserver-node, lsp-server in Rust, etc.) provide this scaffolding.

**Where to look.** vscode-languageserver-node's documentation and examples. Don't reinvent.

**Apply to Pike LSP.** Phase 2 should establish the capabilities pattern correctly. Don't try to support all editors initially — VSCode is the primary target, others come later.

## Testing strategies for LSPs

**Problem.** LSP behavior is hard to test because it involves a server, a client, and a protocol. Bugs hide in the interaction.

**Solution variants:**

- **gopls's regtest.** Spin up a real LSP server in-process for each test, feed it real LSP requests, assert on responses. Tests run against the actual code paths users hit.

- **rust-analyzer's lsp-server tests.** Similar pattern, with explicit fixtures for workspace state.

- **typescript-language-server's tests.** Mock the editor side, real server.

**Where to look.**
- gopls/internal/lsp/regtest. The fixture-based test infrastructure.
- rust-analyzer's lsp-server crate tests.

**Apply to Pike LSP.** Phase 2 and beyond. The harness from phase 1 is currently testing pike's output, not LSP output. When the LSP starts existing, phase 2 needs LSP-level tests too. Borrow gopls's regtest pattern: spin up the server, send a documentSymbol request, assert on the response.

## What NOT to copy

Most of gopls (and rust-analyzer, and clangd) is solving problems Pike doesn't have:
- Build system integration (go modules, cargo, CMake) — Pike has no equivalent
- Code generation tracking — Pike has no equivalent
- Cross-language interop — out of scope
- Telemetry, web UIs, profiling endpoints — out of scope

Don't read these LSPs cover-to-cover. Pull out the specific patterns when the corresponding problem comes up. Most of the codebases are 10-100x larger than what this Pike LSP needs to be.


## Testing Strategies for the Pike LSP

The Pike LSP uses three layers of testing with different cost/coverage trade-offs.

### Layer 1: Protocol-level tests (`tests/lsp/`)

- In-process LSP server with PassThrough streams
- Real JSON-RPC messages, real tree-sitter parsing
- Ground truth: harness snapshots from Phase 1
- Fast: milliseconds per test
- Run on every commit
- Catches: logic bugs in LSP server, parser regressions, symbol extraction errors
- Pattern: gopls `internal/lsp/regtest`

### Layer 2: VSCode integration tests (`tests/integration/`)

- Real VSCode process with extension loaded via `@vscode/test-electron`
- Ground truth: VSCode behaves correctly
- Slow: seconds per test
- Run before each release
- Catches: extension wiring bugs, activation failures, transport issues
- 5–15 tests for the entire project

### Layer 3: Manual smoke tests (`MANUAL_SMOKE_TESTS.md`)

- Human verifies UX: highlighting, completion timing, hover rendering
- Run once before significant releases
- 10–15 items max
- Catches: UX issues with no programmatic ground truth

### Why three layers

Without Layer 1, testing depends on Layer 2 which is slow and brittle. Without Layer 2, integration bugs ship to users. Without Layer 3, the LSP is correct but might feel wrong.

The proportion: many Layer 1 tests, few Layer 2 tests, rare Layer 3 manual checks.

### How Layer 1 works

```typescript
// In-process: two PassThrough streams connect client and server
const { client, openDoc } = await createTestServer();
const uri = openDoc('file:///test.pike', source);
const symbols = await client.sendRequest('textDocument/documentSymbol', { textDocument: { uri } });
// Compare symbols against harness snapshot
```

No subprocess, no stdio, no VSCode. The test framework IS the editor.