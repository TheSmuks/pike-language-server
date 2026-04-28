# Decision 0007: Integration Tests (Layer 2)

**Date:** 2026-04-27 (revised 2026-04-28)
**Status:** Accepted (moved from Phase 5 exit to Phase 5 entry)
**Context:** Phase 5 entry prerequisites

## Decision

Layer-2 integration tests (`@vscode/test-electron`) are wired as a Phase 5 **entry** prerequisite rather than Phase 5 exit.

## Reasoning

Phase 5 adds diagnostics that surface in VSCode's UI in ways that protocol-level tests can't fully validate. Having Layer-2 wired before Phase 5 scope work begins means diagnostic features are testable from the start.

## Implementation

### Extension packaging

The extension is bundled with esbuild:

```
bun run build:extension
```

This creates:
- `server/dist/server.js` — bundled LSP server
- `client/dist/extension.js` — bundled VSCode extension client

### Test runner

```
cd tests/integration && npm test
```

Downloads VSCode via `@vscode/test-electron`, loads the extension, and runs tests inside the extension host.

### Test suite

Three tests in `tests/integration/suite/index.ts`:

1. **Activation** — Extension activates when a .pike file is opened
2. **documentSymbol** — Outline view shows correct symbols for corpus files
3. **Error recovery** — Malformed Pike files don't crash the extension

### When to run

Before merges (not on every commit). These tests are slow (~30s) and require a display or virtual framebuffer (`xvfb-run`).

## Phase Commitment

Phase 5 entry checkpoint includes:
- [x] `tests/integration/` wired with `@vscode/test-electron`
- [x] Extension packaging via esbuild (`bun run build:extension`)
- [x] Three integration tests (activation, documentSymbol, error-recovery)
- [x] Integration tests documented as pre-merge checks

## Consequences

- Extension packaging infrastructure exists before Phase 5 adds features
- Phase 5's diagnostic work can be validated in VSCode from the start
- The `build:extension` script is a prerequisite for manual testing too
