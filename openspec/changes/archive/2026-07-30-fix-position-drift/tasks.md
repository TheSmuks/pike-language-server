## 1. Lock the binding contract first

- [x] 1.1 Add a test asserting web-tree-sitter reports `startIndex` and
      `Point.column` in UTF-16 code units, written so it fails under UTF-8 byte
      semantics (parse `int x; // © © marker`, require `endPosition.column` to
      be 20 and not 22)
- [x] 1.2 Confirm the new test passes against the current `web-tree-sitter`
      version before changing any production code

## 2. Prove the defect before fixing it

- [x] 2.1 Add a non-ASCII fixture pair: one UTF-8 source and one ISO-8859-1
      source, each with a `©` in the header and symbols defined after it
- [x] 2.2 Write failing tests for document link, hover, go-to-definition, and
      diagnostics against the fixtures, asserting exact ranges and exact
      resolved symbols
- [x] 2.3 Record the observed drift (expected: left shift of one per preceding
      non-ASCII character outbound, right shift inbound) so the fix can be
      confirmed to remove it rather than merely change it

## 3. Remove the conversion layer

- [x] 3.1 Enumerate all 51 call sites — 36 of `utf8ToUtf16` / `utf16ToUtf8`
      plus 15 of the offset map — across the 18 files, classifying each as
      outbound (node → LSP) or inbound (LSP → node)
- [x] 3.2 Remove outbound conversions, passing `node.startPosition.column` and
      `node.endPosition.column` through unchanged
- [x] 3.3 Remove inbound conversions, passing `params.position.character`
      directly to `descendantForPosition` and equivalents
- [x] 3.4 Delete `utf8ToUtf16` / `utf16ToUtf8` and the false premise in the
      module header; delete `positionConverter.ts` entirely if nothing else
      lands there
- [x] 3.5 Remove the offset map: drop the `offsetMap` parameter from
      `scope-helpers.ts`, `scope-helpers-lookup.ts`, `referenceCollector.ts`,
      and `symbolTable.ts`, and delete `server/src/util/offsetMap.ts`
- [x] 3.6 Strip the `utf8ToUtf16` / `utf16ToUtf8` sections from
      `tests/lsp/positionConverter.test.ts`, keeping its `getLineText` coverage
- [x] 3.7 Verify task 2.2's tests now pass

## 4. Encoding detection

- [x] 4.1 Implement a source decoder: `#charset` directive → UTF-8 if valid →
      ISO-8859-1 fallback, returning both text and detected encoding
- [x] 4.2 Unit-test the decoder against all three paths, including the
      `iso-2022` and `iso-8859-2` directive forms found in the Roxen corpus
- [x] 4.3 Route `backgroundIndex.ts:222`, `serverDocumentHandler.ts:266`,
      `serverLifecycle.ts:111`, and `hoverContent.ts:251` through the decoder
- [x] 4.4 Audit for any remaining `readFile(..., "utf-8")` on Pike source and
      route it too; leave server-owned JSON reads on UTF-8
- [x] 4.5 Assert the ISO-8859-1 fixture decodes with no U+FFFD present

## 5. Cache invalidation

- [x] 5.1 Bump `FORMAT_VERSION` in `server/src/features/persistentCache.ts:90`
      and `server/src/features/cacheManifest.ts:23`
- [x] 5.2 Test that a cache written before the bump is discarded rather than
      reused, so pre-fix positions cannot survive

## 6. Verification

- [x] 6.1 Run the full test suite serially and confirm no regression against
      the pre-existing failure baseline
- [x] 6.2 Re-run the Roxen 6.1 corpus parse and confirm the invalid-UTF-8 count
      drops to zero under the new decoder while the 14 genuine parse failures
      are unchanged
- [x] 6.3 Manually verify in the editor against a real ISO-8859-1 Roxen module:
      hover, Ctrl+Click, and diagnostics all land on the correct span
- [x] 6.4 Run the perf suite and confirm removing the offset map did not
      regress position-heavy paths; record the memory effect of dropping the
      per-file `Int32Array`
- [x] 6.5 Run quality gates (file ≤500 lines, function ≤50 lines)
