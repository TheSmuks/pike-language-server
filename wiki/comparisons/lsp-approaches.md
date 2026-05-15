---
title: LSP Approaches
created: 2026-05-15
updated: 2026-05-15
type: comparison
tags:
  - architecture
  - design
sources:
  - raw/articles/lsp-references.md
---

# LSP Approaches

How other LSPs solve hard problems. When designing a new feature for the Pike LSP, check this page first -- most problems have been solved by other LSPs over years of work.

Related: [[tier-3-lsp]], [[two-speed-diagnostics]], [[pike-worker]]

## The Snapshot Pattern (Immutable Workspace Views)

**Problem:** LSP requests are concurrent. The user types while the server computes hover from a previous cursor position. Without care, the response combines parse-tree state from time T1 with type-info from time T2.

**Solution (gopls):** Every LSP request operates on an immutable `Snapshot` -- a frozen view of the workspace at a point in time. New edits create a new Snapshot; in-flight requests on the old one complete or get cancelled but never see partial state.

**Where to look:** `golang.org/x/tools/gopls/internal/cache` -- the `Snapshot` and `Session` types. Each request handler receives a snapshot at the start and uses it throughout.

**Pike LSP application:** Phase 2 needed this even for documentSymbol. By phase 5, combining tree-sitter parse trees, pike runtime introspection, AutoDoc XML, and source-parsed type info requires all four sources from the same snapshot.

---

## Request Cancellation

**Problem:** A request becomes stale because the user keeps typing. Computing the response is wasted work and may produce wrong UI behavior.

**Solution (gopls):** Context-based cancellation. `context.Context` through every handler. When the client cancels via `$/cancelRequest` or supersedes with a newer request, the context is cancelled and handlers check it at every expensive step.

**Pike LSP application:** TypeScript uses `CancellationToken` from vscode-languageserver-node. Every handler that takes more than a few milliseconds must accept and check the token. The Pike LSP has 27 cancellation checkpoints.

---

## Diagnostic Debouncing

**Problem:** Running the type checker on every keystroke melts the CPU. Running only on save makes errors feel stale.

**Solution (gopls):** Diagnostics computed in batches with debouncing. Default: wait until user stops typing for a configurable interval, then run full type-check pipeline. Save events trigger immediate diagnostics. Configuration-driven.

**Pike LSP application:** Diagnostics are triggered on `didChange` (debounced at 500ms) and `didSave` (immediate). Three modes: realtime, saveOnly, off. See [[two-speed-diagnostics]].

---

## Cross-Translation-Unit Indexing

**Problem:** Going from "this identifier" to "its definition somewhere in the workspace" requires an index that handles hundreds of thousands of symbols, updates incrementally, and survives edits.

**Solution variants:**

- **gopls package graph:** Each Go package is a node; dependencies are edges. File change invalidates the package plus everything that transitively imports it.
- **rust-analyzer salsa:** Every analysis result is memoized as a function of its inputs. More general, more complex to implement.
- **clangd index:** Persistent on-disk index of symbols. Built incrementally. Survives restarts.

**Pike LSP application:** Pike's module system (.pmod directories, inherits, imports) maps roughly to Go's package model. Uses gopls-style approach: in-memory index, .pmod-granularity invalidation, no on-disk persistence.

---

## Wrapping External Type Checkers

**Problem:** The LSP wraps a tool that implements language semantics. The wrapping layer is where most of the work is.

**Solution variants:**

- **typescript-language-server:** Wraps tsserver via JSON over stdin/stdout. LSP layer translates between LSP protocol and tsserver's request/response format.
- **gopls (in-process):** Type checker is `go/types`, no IPC overhead, tightly coupled.
- **pyright:** Type checker and LSP share a process and data structures. Most tightly integrated.

**Pike LSP application:** Structurally what we're building. The PikeWorker subprocess is the out-of-process Pike runtime. The typescript-language-server pattern of subprocess management is most applicable: keep the pike process alive across requests, multiplex requests, handle crashes, restart on failure.

---

## Parser Readiness (Non-Blocking Check)

**Problem:** During startup, tree-sitter WASM initialization takes time. If a document change arrives before the parser is ready, handlers that block on initialization queue up.

**Solution (rust-analyzer):** Instead of blocking on readiness, check with a fast boolean guard. If not ready, return immediately. The document will be re-processed on the next didChange.

**Pike LSP application:** `server/src/parser.ts` exports `isParserReady()` which returns `true` after `initParser()` completes. The server uses this instead of `await parserReady`:

```typescript
// BLOCKING (old): await parserReady;
// NON-BLOCKING (new): if (!isParserReady()) return;

documents.onDidChangeContent(async (event) => {
  if (!isParserReady()) return;
  // ... process document
});
```

---

## Content Guards

**Problem:** A compound guard like `if (!content && content !== "")` silently skips processing when `content` is unexpectedly null/undefined.

**Solution (gopls):** When content is unexpectedly null/undefined, log a diagnostic-quality error instead of silently skipping. The guard checks only the invalid state, not the valid-but-empty state.

**Pike LSP application:** Server uses explicit null/undefined checks that log errors, distinguishing "unexpected null" (bug) from "valid empty" (user wrote empty file).

---

## Testing Strategies

### Layer 1: Protocol-level tests (`tests/lsp/`)

In-process LSP server with PassThrough streams. Real JSON-RPC messages, real tree-sitter parsing. Ground truth from harness snapshots. Milliseconds per test. Pattern borrowed from gopls `internal/lsp/regtest`.

### Layer 2: VSCode extension wiring tests (`tests/integration/`)

Real VSCode process with extension loaded via `@vscode/test-electron` + Mocha. Verifies extension activation and LSP client wiring. Seconds per test.

### Layer 3: Manual smoke tests

Human verifies UX: highlighting, completion timing, hover rendering. 10-15 items max. Before significant releases only.

---

## What NOT to Copy

Most of gopls (and rust-analyzer, and clangd) solves problems Pike doesn't have:

- **Build system integration** (go modules, cargo, CMake) -- Pike has no equivalent
- **Code generation tracking** -- Pike has no equivalent
- **Cross-language interop** -- out of scope
- **Telemetry, web UIs, profiling endpoints** -- out of scope

Don't read these LSPs cover-to-cover. Pull out specific patterns when the corresponding problem comes up. Most of the codebases are 10-100x larger than what the Pike LSP needs to be.
