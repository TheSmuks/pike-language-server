---

# Pike LSP Architecture Audit — Second Iteration

**Date:** 2026-05-16
**Auditor:** Automated audit (3 parallel subagents + inline checks)
**Scope:** Full codebase: server/src/ (83 files, 19,628 lines), tests/ + harness/ (61 files, 20,384 lines), client/, scripts/, .github/workflows/

## Baseline Metrics

| Metric | Value |
|--------|-------|
| Source files | 83 |
| Source lines | 19,628 |
| Test files | 61 |
| Test lines | 20,384 |
| Largest source file | pikeWorkerProcess.ts (500 lines) |
| Files >500 lines | 0 (all clean) |
| Silent `.catch(() => {})` | 0 (all clean) |
| TODO/FIXME without issue | 0 (all clean) |
| Generation counter mutations | 5 (present, correct) |
| Cancellation checks | 27 call sites |
| Corpus files | 82 |

## Findings

### CRITICAL

| # | Finding | Location | Description |
|---|---------|----------|-------------|
| C1 | `createPikeServer` is 417 lines | server.ts:68-485 | 8x the TigerStyle 50-line function limit. Entire server wiring in one function. |
| C2 | Silent catch on shutdown cache save | server.ts:413-415 | `catch {}` swallows disk-full or corruption errors. Must log at minimum. |
| C3 | Notification name mismatch after restart | client/extension.ts:391 | Re-registers as `"pike/serverLog"` but server sends `"pike/log"`. All server logs silently dropped after first config change. |

### HIGH

| # | Finding | Location | Description |
|---|---------|----------|-------------|
| H1 | Non-null assertion on `child(0)!` | diagnostics.ts:54 | Guard on line 53, `!` on 54 — fragile under refactoring. |
| H2 | Non-null assertion on `child(0)!` | referenceCollector.ts:184 | Recursive call assumes `childCount > 0` guarantees non-null. tree-sitter can return null on ERROR nodes. |
| H3 | `rootNode.text` in 10 hot paths | signatureHelp (2), hoverHandler, diagnostics, inlayHints, lintRules (3), diagnosticUtils, documentSymbol | Materializes entire file per keystroke. ~300KB for 10K-line file. |
| H4 | `require()` in ESM module | codeAction.ts:416,431 | `require("./codeActionSourceActions")` breaks ESM bundling and tree-shaking. |
| H5 | `completeUnqualified` is 153 lines | completion.ts:137-289 | 3x TigerStyle limit. Mixes scope walking, stdlib lookup, sorting, filtering. |
| H6 | `registerGoToHandlers` is 279 lines | navigationGoTo.ts:26-304 | 5.5x limit. Wires 5 handlers in one closure. |
| H7 | `registerDocumentFeatureHandlers` is 243 lines | navigationDocumentFeatures.ts:33-275 | 5x limit. Wires 4 handlers in one function. |
| H8 | `renderBlocks` ~350 lines | xml-renderer-blocks.ts:14 | 7x limit. |
| H9 | CHANGELOG version ordering | CHANGELOG.md:9-35 | `[0.6.6]` above `[0.7.0]` — violates Keep a Changelog descending order. |

### MEDIUM

| # | Finding | Location | Description |
|---|---------|----------|-------------|
| M1 | `catch {}` without error variable | pikeWorkerProcess.ts:479 | Malformed response error from JSON.parse is discarded. `consecutiveMalformed` is tracked but the actual error message is lost. |
| M2 | Bare `catch {}` in resolveDir/resolveFile | pikeWorkerProcess.ts:51,68 | Permission errors (EACCES) treated same as "not found." |
| M3 | `(handlerContext as any).index = index` | server.ts:255 | Runtime type escape bypasses structural checking. |
| M4 | Bare `as Record<>` casts on JSON imports | server.ts:171-172 | No runtime validation of stdlibAutodocIndex or predefBuiltinIndex shape. |
| M5 | Bare `as Record<>` casts on JSON imports | navigationRefactoring.ts:32,57,80 | Three more casts without validation. |
| M6 | `as any` on CodeAction kind | getterSetter.ts:102,121,142; autodocTemplate.ts:73 | Hides future type errors if `kind` field changes. |
| M7 | `import.meta.dirname!` non-null assertion | server.ts:410; serverLifecycle.ts:102 | `undefined` in non-Node ESM loaders. |
| M8 | `q.shift()!` non-null assertion | pikeWorkerProcess.ts:339; workspaceIndex.ts:200 | Guarded by length checks but fragile under refactoring. |
| M9 | `catch {}` on file read | hoverContent.ts:105 | `readFileSync` failure returns null silently — no logging. |
| M10 | `catch {}` on on-demand index | workspaceResolution.ts:171 | Indexing failure silently swallowed. |
| M11 | Notification shape mismatch after restart | client/extension.ts:389-396 | Restart handler uses `{ message: string }` but server sends `{ lines: string[] }`. Even if name were fixed, body would fail. |
| M12 | Missing `pike-fmt` CI job | .github/workflows/ci.yml | CHANGELOG documents a `pike-fmt` CI check but no such job exists. |
| M13 | `npx esbuild` in bun project | scripts/build-standalone.sh:17 | Other build scripts call `esbuild` directly. `npx` adds overhead and may resolve different binary. |
| M14 | Hardcoded `/tmp/unused` placeholder | server.ts:117 | If init fails, index uses `/tmp/unused` as workspace root. |
| M15 | VSIX filename format mismatch | scripts/release.sh:310 | Uses `+BUILD_NUM` but build-vsix.sh produces `-BUILD_NUM`. |
| M16 | Missing `bash` prefix | package.json:18 | `build:standalone` calls `.sh` directly; others use `bash` prefix. |
| M17 | 15+ functions exceed 50-line TigerStyle limit | Various | detectTriggerContext (153), findLhsBeforePosition (112), findCalleeBeforeOpenParen (91), completeMemberAccess (91), produceCodeActions (99), fixArityMismatch (83), getReferencesTo (87), buildSymbolTable (60), registerHoverHandler (124), etc. |
| M18 | it.skip without tracked issue | tests/integration/suite/index.ts:193 | Has documented reason (requires VSCode host) but no GitHub issue link. |

### LOW

| # | Finding | Location | Description |
|---|---------|----------|-------------|
| L1 | `console.debug()` instead of structured logging | pikeWorkerProcess.ts:477 | Won't appear in client output channel. |
| L2 | `as never` casts on console stubs | main.ts:30,39 | Fragile if createConnection overload changes. |
| L3 | Maps without explicit size bounds | workspaceIndex.ts, symbolTable.ts, diagnosticManager.ts | All lifecycle-managed but no explicit upper-bound guard per TigerStyle "put a limit on everything." |
| L4 | Zero-byte `=` file in project root | `/tank/projects/pike-language-server/=` | Accidental creation, possibly tracked in git. |
| L5 | Transitive dependency imports | inlayHints.ts, lintRules, formattingHandler, pikeWorkerProcess | Import from `vscode-languageserver-types` and `vscode-languageserver-protocol` without declaring them as direct dependencies. |
| L6 | `fetch-depth: 0` for commit lint | .github/workflows/commit-lint.yml:23 | Full history not needed for PR commit lint. |
| L7 | `@types/node` version drift | tests/integration/package.json | Uses `^22.0.0` while root uses `^25.6.0`. |
| L8 | `[Unreleased]` placed between v0.7.0 and v0.6.4 | CHANGELOG.md:105 | Should be first section after preamble. |
| L9 | known-limitations.md bloat | docs/known-limitations.md | ~70% entries are RESOLVED. Active limitations buried. |
| L10 | 17 features with no direct test file | Various | accessResolver, autodocLineRenderer, declarationBlockCollectors, declarationCollector, diagnosticUtils, navigationAdvanced, navigationDocumentFeatures, navigationGoTo, navigationInclude, navigationRefactoring, pikeDetection, referenceCollector, workspaceDependencies, workspaceResolution, xml-renderer-blocks, xml-renderer-inline, xml-renderer. Note: many are tested indirectly via integration/harness tests. |
| L11 | Duplicate test names detected | tests/ | "/file exists/is valid JSON" — likely from parameterized tests, harmless but may confuse reporters. |

### INFO

| Metric | Value |
|--------|-------|
| No hardcoded secrets/tokens | Confirmed clean across all .yml/.ts/.js/.sh/.json |
| Version alignment | 0.7.0 consistent across package.json, extension.package.json, .template-version, git tag, CHANGELOG |
| Test discovery | `"test": "bun test tests/ harness/"` — correctly covers all directories |
| Cancellation coverage | 27 `isCancellationRequested` checks across all async handlers |
| Path traversal protection | `normalizeAndCheck()` + `resolve()` + `startsWith()` boundary checks in place |

## Priority Matrix

### Fix Now (this iteration)

1. **C3** — Notification name mismatch. Server logs silently dropped after restart. One-line fix in client/extension.ts:391.
2. **C2** — Silent cache-save catch. Add `logWarn()` in server.ts:413.
3. **M11** — Notification shape mismatch. Fix restart handler body to match `{ lines: string[] }`.
4. **H1, H2** — Replace `child(0)!` with null guard. Two-line changes.

### Fix Soon (next few sessions)

5. **H4** — Replace `require()` with static imports in codeAction.ts.
6. **H3** — Eliminate `rootNode.text` from hot paths. Pass document text or line text from callers.
7. **C1, H5-H8** — TigerStyle function-length violations. Extract sub-functions from the giant monoliths.
8. **M17** — Remaining function-length violations across features.

### Defer (low impact or high effort)

9. **M4-M8** — Bare `as` casts. Safe as long as JSON shapes are stable. Add validation opportunistically.
10. **L4-L11** — Low-priority items. Address when touching affected files.

## Comparison with First Iteration

The first iteration (2026-05-15) found and fixed 26 issues across security, performance, client lifecycle, TigerStyle, and testing. This second iteration finds the codebase significantly healthier:

- All previous Critical/High findings are resolved
- File-level TigerStyle compliance holds (0 files >500 lines)
- Function-level TigerStyle remains the primary gap (C1, H5-H8, M17)
- Client restart logic has a regression (C3, M11) — likely introduced during the C5.3 fix in the first iteration
- `rootNode.text` in hot paths is the largest remaining performance concern
