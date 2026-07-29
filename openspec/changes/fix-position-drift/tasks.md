## 1. Lock the binding contract first

- [ ] 1.1 Add a test asserting web-tree-sitter reports `startIndex` and
      `Point.column` in UTF-16 code units, written so it fails under UTF-8 byte
      semantics (parse `int x; // © © marker`, require `endPosition.column` to
      be 20 and not 22)
- [ ] 1.2 Confirm the new test passes against the current `web-tree-sitter`
      version before changing any production code

## 2. Prove the defect before fixing it

- [ ] 2.1 Add a non-ASCII fixture pair: one UTF-8 source and one ISO-8859-1
      source, each with a `©` in the header and symbols defined after it
- [ ] 2.2 Write failing tests for document link, hover, go-to-definition, and
      diagnostics against the fixtures, asserting exact ranges and exact
      resolved symbols
- [ ] 2.3 Record the observed drift (expected: left shift of one per preceding
      non-ASCII character outbound, right shift inbound) so the fix can be
      confirmed to remove it rather than merely change it

## 3. Remove the conversion layer

- [ ] 3.1 Enumerate all 36 call sites of `utf8ToUtf16` / `utf16ToUtf8` across
      the 15 files and classify each as outbound (node → LSP) or inbound
      (LSP → node)
- [ ] 3.2 Remove outbound conversions, passing `node.startPosition.column` and
      `node.endPosition.column` through unchanged
- [ ] 3.3 Remove inbound conversions, passing `params.position.character`
      directly to `descendantForPosition` and equivalents
- [ ] 3.4 Delete `utf8ToUtf16` / `utf16ToUtf8` and the false premise in the
      module header; delete `positionConverter.ts` entirely if nothing else
      lands there
- [ ] 3.5 Rewrite `tests/lsp/positionConverter.test.ts`, which asserts the
      incorrect behavior — replace, do not adjust
- [ ] 3.6 Verify tasks 2.2's tests now pass

## 4. Encoding detection

- [ ] 4.1 Implement a source decoder: `#charset` directive → UTF-8 if valid →
      ISO-8859-1 fallback, returning both text and detected encoding
- [ ] 4.2 Unit-test the decoder against all three paths, including the
      `iso-2022` and `iso-8859-2` directive forms found in the Roxen corpus
- [ ] 4.3 Route `backgroundIndex.ts:222`, `serverDocumentHandler.ts:266`,
      `serverLifecycle.ts:111`, and `hoverContent.ts:251` through the decoder
- [ ] 4.4 Audit for any remaining `readFile(..., "utf-8")` on Pike source and
      route it too; leave server-owned JSON reads on UTF-8
- [ ] 4.5 Assert the ISO-8859-1 fixture decodes with no U+FFFD present

## 5. Cache invalidation

- [ ] 5.1 Bump `FORMAT_VERSION` in `server/src/features/persistentCache.ts:90`
      and `server/src/features/cacheManifest.ts:23`
- [ ] 5.2 Test that a cache written before the bump is discarded rather than
      reused, so pre-fix positions cannot survive

## 6. Verification

- [ ] 6.1 Run the full test suite serially and confirm no regression against
      the pre-existing failure baseline
- [ ] 6.2 Re-run the Roxen 6.1 corpus parse and confirm the invalid-UTF-8 count
      drops to zero under the new decoder while the 14 genuine parse failures
      are unchanged
- [ ] 6.3 Manually verify in the editor against a real ISO-8859-1 Roxen module:
      hover, Ctrl+Click, and diagnostics all land on the correct span
- [ ] 6.4 Run quality gates (file ≤500 lines, function ≤50 lines)
