# Manual Smoke Tests

Run once before each significant release. 10–15 items max; if it grows past 20, prune or automate.

## Purpose

Automated tests cover correctness at two layers:

- **Layer 1** (`tests/lsp/`) — LSP protocol-level tests: send JSON-RPC, assert on responses.
- **Layer 2** (`tests/integration/`) — integration tests exercising server lifecycle and edge cases.

This file covers what those layers cannot: visual quality, timing, editor feel, and UX-level
behavior that resists automation. It is not a substitute for the automated suites.

**When to run:** before each release, not per commit.

---

- [ ] **Phase 2**: Syntax highlighting
  - **Expected**: Keywords, types, strings, and comments are colorized correctly in a `.pike` or `.pmod` file.
  - **How**: Open any Pike file from `corpus/files/` (e.g. `basic.pike`). Confirm tokens are highlighted and no raw-text regions appear where highlighting is expected.

- [ ] **Phase 2**: Outline view shows document symbols
  - **Expected**: The VSCode outline panel lists top-level symbols (classes, functions, variables). Clicking a symbol jumps the cursor to its definition.
  - **How**: Open a multi-symbol file (e.g. `class_with_inherit.pike`). Open the outline view (View → Open View → Outline). Verify symbol names appear and navigation works.

- [ ] **Phase 2**: Syntax error appears in Problems panel
  - **Expected**: A file with deliberate syntax errors shows diagnostics in the Problems panel. The server does not crash or become unresponsive.
  - **How**: Create or open a file with a syntax error (e.g. missing semicolon, unmatched brace). Confirm a diagnostic appears in the Problems panel. Then fix the error and confirm the diagnostic clears.

- [ ] **Phase 6 P2**: Real-time parse diagnostics
  - **Expected**: Parse errors appear within 1 second of typing. No lag.
  - **How**: Open a Pike file. Type `class { }` (syntax error). Confirm the error appears in < 1 second. Fix it to `class Foo { }`. Confirm the error clears.

- [ ] **Phase 6 P2**: Supersession — no error flash
  - **Expected**: Introducing then fixing an error within 1 second does not produce a Pike diagnostic flash. Parse diagnostics may flash (this is by design — they're free).
  - **How**: In a clean file, type `class { }`, wait 200ms, fix to `class Foo { }`. Confirm no Pike compilation error appears briefly. Parse errors may appear and clear immediately.

- [ ] **Phase 6 P2**: Continuous typing — no lag or flicker
  - **Expected**: Typing continuously for 10 seconds does not cause editor lag, diagnostic flicker, or excessive CPU/memory usage.
  - **How**: Open a Pike file. Type continuously (add comments, variables, functions) for 10 seconds. The editor should feel like editing a TypeScript file with a mature LSP.

- [ ] **Phase 6 P2**: Cross-file propagation
  - **Expected**: Editing a base class file causes inheriting files to show updated diagnostics.
  - **How**: Open two files: `A.pike` defines `class A { void foo() {} }`. `B.pike` has `inherit "./A"; void test() { foo(); }`. Edit `A.pike` to remove `foo()`. Confirm `B.pike` shows an error without manually saving or switching tabs.

- [ ] **Phase 6 P2**: saveOnly mode
  - **Expected**: In saveOnly mode, typing does not trigger Pike diagnostics. Only Ctrl+S does.
  - **How**: Configure `"pike.diagnosticMode": "saveOnly"` in VSCode settings. Open a Pike file with a type error. Confirm no error appears while typing. Press Ctrl+S. Confirm the error appears.