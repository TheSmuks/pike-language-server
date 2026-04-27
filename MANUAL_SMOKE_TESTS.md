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
