## Why

Every LSP range the server emits on a line containing a non-ASCII character is
shifted, because `server/src/util/positionConverter.ts` is built on a false
premise: that tree-sitter reports UTF-8 byte offsets. web-tree-sitter 0.26
indexes JS-string input in **UTF-16 code units**, so the conversion layer
corrupts positions instead of correcting them.

Users see this as diagnostics underlining an unrelated span, and as hover and
Ctrl+Click resolving to a different symbol than the one under the cursor —
frequently an `import` or `#include`, because those sit in the file header
alongside the copyright characters that trigger the drift.

## What Changes

- **BREAKING (internal)**: remove the UTF-8 ↔ UTF-16 conversion layer for the
  tree-sitter ⇄ LSP direction. Positions pass through unconverted. All 51 call
  sites across 18 files are deleted rather than reduced to no-op wrappers, so
  the false premise cannot be reintroduced by a future edit.
- Remove `server/src/util/offsetMap.ts`, a second implementation of the same
  false premise. It exists to make the incorrect conversion fast, pre-computing
  a per-line `Int32Array` byte→UTF-16 map at parse time. Deleting it removes
  that per-file allocation outright.
- Rewrite `tests/lsp/positionConverter.test.ts`, which currently asserts the
  incorrect behavior and therefore protects the bug.
- Decode Pike source by encoding sniffing rather than assuming UTF-8: honour an
  explicit `#charset` directive, else UTF-8, else fall back to ISO-8859-1 when
  the bytes are not valid UTF-8. Applies to every disk read of Pike source.
- Add a binding-semantics assertion test that fails loudly if a future
  web-tree-sitter upgrade switches index units back to bytes. The silent
  semantics change is what introduced this defect.

## Capabilities

### New Capabilities

- `source-position-mapping`: how tree-sitter node positions map to LSP
  positions, and the unit contract with the parser binding.
- `source-encoding`: how Pike source bytes are decoded into text, including
  `#charset` handling and the non-UTF-8 fallback.

### Modified Capabilities

None. No existing spec covers these behaviors.

## Impact

- `server/src/util/positionConverter.ts` — the byte↔unit conversion functions
  are removed; `getLineText`, which has three unrelated consumers, stays.
- `server/src/util/offsetMap.ts` — deleted entirely.
- 18 feature modules holding the 51 call sites, including `documentLink.ts`,
  `hoverHandler.ts`, `accessResolver.ts`, `signatureHelp.ts`,
  `selectionRange.ts`, `lintRules/missingReturn.ts`, and — via the offset map —
  `symbolTable.ts`, `referenceCollector.ts`, and `scope-helpers*.ts`.
- Expected side benefit: one fewer `Int32Array` per file at parse time, which
  should register against the tracked memory baselines.
- Disk reads currently hardcoding `"utf-8"`: `backgroundIndex.ts:222`,
  `serverDocumentHandler.ts:266`, `serverLifecycle.ts:111`,
  `hoverContent.ts:251`.
- `tests/lsp/positionConverter.test.ts`.
- No change to the LSP wire contract; the server was already required to emit
  UTF-16 positions and will now actually do so.
