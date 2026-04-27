# Decision 0007: Deferred Integration Tests (Layer 2)

**Date:** 2026-04-27
**Status:** Accepted
**Context:** Phase 2 exit verification — layer-2 integration test stubs need a phase commitment

## Decision

Layer-2 integration tests (VSCode extension testing via `@vscode/test-electron`) are deferred to **Phase 5 (Types and Diagnostics)**.

## Reasoning

Three alternatives were considered:

1. **Wire up now (Phase 2):** Significant scope expansion. Requires packaging the extension with esbuild, creating a test VSIX, configuring `@vscode/test-electron` with a test workspace, and debugging extension host crashes. This work is orthogonal to Phase 2's core deliverable (documentSymbol via tree-sitter). The extension entry point is 20 lines of boilerplate — there's nothing to integration-test yet.

2. **Defer to Phase 5 (chosen):** By Phase 5, the extension will have real features worth testing in VSCode: diagnostics from the pike oracle, hover, and potentially completion. The packaging infrastructure (esbuild, VSIX) will exist because Phase 5 requires a working extension for manual testing. Wiring `@vscode/test-electron` at that point adds marginal cost to an already-required packaging step.

3. **Abandon layer 2 entirely:** Rejected. Integration bugs ship. The VSCode extension host has unique constraints (process isolation, activation events, extension API versioning) that in-process tests cannot exercise. Every significant VSCode extension uses integration tests — skipping them is a known risk.

## Phase Commitment

Phase 5 exit checkpoint will include:
- [ ] `tests/integration/` wired with `@vscode/test-electron`
- [ ] At least one integration test per active LSP feature
- [ ] Integration tests run in CI (or documented as pre-release manual step if CI extension host is unavailable)

## Alternatives Not Chosen

| Alternative | Cost | Risk |
|-------------|------|------|
| Wire now | ~1 day of Phase 2 scope expansion | Delays Phase 3 entry for marginal value |
| Defer to Phase 6+ | Too late — bugs found after all features built | Expensive rework |
| Never | Zero cost | Integration bugs ship to users |

## Consequences

- Phase 2 ships with layer-1 tests only (protocol-level, in-process). This is sufficient because the LSP protocol layer is the entire Phase 2 deliverable.
- Phase 3 and 4 (symbol resolution) can be verified with layer-1 tests alone — they add server features, not extension host integration.
- Phase 5 adds the pike oracle subprocess, which requires the extension to actually spawn processes — this is where integration tests first provide unique value.
