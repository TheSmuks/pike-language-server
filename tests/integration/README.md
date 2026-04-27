# Layer 2 — Integration Tests

These tests launch a real VS Code process with the Pike extension loaded via
`@vscode/test-electron`. They verify that the extension wiring works end-to-end:
activation on `.pike` files, outline view population, diagnostic publishing, and
error recovery.

## What they cover

| Test file | What it verifies |
|---|---|
| `activation.test.ts` | Opening a `.pike` file activates the extension and starts the LSP server |
| `documentSymbol.test.ts` | The outline view shows correct symbols for a Pike source file |
| `error-recovery.test.ts` | The server recovers gracefully from malformed input without crashing |

Layer 1 tests (`tests/lsp/`) cover feature correctness at the protocol level
using in-process streams. Layer 2 tests cover the VS Code extension host
integration — manifest, activation events, client-side middleware, and UI wiring.

## Prerequisites

- A compiled extension (VSIX or `dist/` directory with `package.json`)
- VS Code installed on the runner
- On Linux CI: `xvfb-run` or a virtual framebuffer

## Running

```sh
cd tests/integration
npm install
npm test
```

## When to run

Run these before each release, not on every commit. They are too slow and
too environment-dependent for the normal CI loop.

## Status

Tests are currently stubs (`test.todo`). They will be implemented once the
extension packaging pipeline produces a testable artefact.
