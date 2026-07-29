## Context

`server/src/util/positionConverter.ts` opens with the assertion "Tree-sitter
produces UTF-8 byte offsets. LSP requires UTF-16 code unit offsets." Every
feature that emits or consumes a position calls into it on that basis: 36 call
sites across 15 files.

The assertion is false for this binding. Measured against
`server/tree-sitter-pike.wasm` with web-tree-sitter 0.26, parsing the line
`int x; // © © marker` yields `endPosition.column = 20` — the UTF-16 code unit
length of that line. Its UTF-8 byte length is 22. Feeding 20 through
`utf8ToUtf16()` returns 18.

The consequences are symmetric and both wrong:

- **Outbound** (`utf8ToUtf16` on a tree-sitter column): ranges shift *left* by
  one per preceding non-ASCII character on the line. Diagnostics, document
  links, and any highlighted range land off-target.
- **Inbound** (`utf16ToUtf8` before `descendantForPosition`): lookups shift
  *right*, resolving a different node than the one under the cursor. Hover and
  Ctrl+Click return an unrelated symbol.

Because file headers are where non-ASCII characters cluster — copyright signs,
author names — the mis-resolved node is disproportionately an `import` or
`#include`, which matches the reported symptom.

A second, independent source of non-ASCII text compounds this. All disk reads
of Pike source hardcode `"utf-8"`. In the Roxen 6.1 corpus, 241 of 442 Pike
files are ISO-8859-1, so those reads inject a U+FFFD on nearly every file's
first lines — manufacturing the exact condition that triggers the drift, in
files that contain no non-ASCII text at all when decoded correctly.

## Goals / Non-Goals

**Goals:**

- Positions the server emits and consumes are correct on any line, regardless
  of character content.
- Pike source is decoded using its actual encoding.
- The unit contract with the parser binding is asserted, not assumed.

**Non-Goals:**

- Changing the LSP `positionEncoding` negotiation. The server emits UTF-16,
  which is the protocol default; nothing about the wire contract changes.
- Supporting encodings beyond `#charset`, UTF-8, and ISO-8859-1 fallback. The
  corpus shows `iso-2022` and `iso-8859-2` appearing once each, both via an
  explicit directive, which the directive path already covers.
- Re-encoding files on write. The server does not write Pike source.

## Decisions

**Delete the conversion layer rather than making it identity.**

A no-op `utf8ToUtf16()` would keep 36 call sites that read as though a
conversion were necessary, inviting someone to "fix" the no-op back into a real
conversion. Removing the calls makes the pass-through the visible default. The
module survives only if the encoding-detection helpers land there; otherwise it
is deleted outright.

*Alternative considered:* keep the wrappers for a deprecation window. Rejected —
there are no external consumers, so the only effect would be preserving the
misleading premise.

**Assert the binding's units in a test rather than documenting them.**

This defect was almost certainly introduced by a web-tree-sitter upgrade that
changed indexing units without breaking any build. Prose in a comment header is
what failed the first time; a failing test is what would have caught it. The
assertion is deliberately written to distinguish the UTF-16 answer from the
UTF-8 answer, so it cannot pass under either semantics by coincidence.

**Sniff encoding rather than configure it.**

A configuration setting would require every user with mixed-encoding sources to
find and set it per workspace, and would still be wrong for repositories that
mix encodings file by file — which Roxen does. Detection is per-file and needs
no user action. The fallback is total: ISO-8859-1 accepts any byte sequence, so
detection never fails, it only picks a less likely answer.

*Alternative considered:* honour VS Code's `files.encoding`. Rejected — it does
not reach the indexer, which reads files the client never opens, and it is a
single workspace-wide value.

**Fix encoding in this change rather than in the Roxen change.**

The two defects are separable in principle but not in practice: the encoding
bug's user-visible symptom *is* position drift, and any test of drift against
realistic Pike source needs correct decoding to be meaningful. Splitting them
would leave the first change untestable against the corpus that motivated it.

## Risks / Trade-offs

**A future web-tree-sitter upgrade reverts to byte offsets** → The
binding-semantics test fails immediately and names the cause, which is strictly
better than today's silent corruption.

**Heuristic misclassifies a valid-UTF-8 file that is really ISO-8859-1** → Rare
but possible: a short ISO-8859-1 byte sequence can be valid UTF-8. The file
decodes as UTF-8 and produces mojibake, exactly as today. No regression, and an
explicit `#charset` is the escape hatch.

**Cached positions computed under the old decoder become invalid** → The
persistent cache must be invalidated. Its existing hash-based versioning covers
this if the cache format version is bumped; not bumping it would surface as
stale, drifting positions that survive the fix.

**Wide blast radius: 15 files, 36 call sites** → Each removal is mechanical and
local, but a missed inbound call site is silent. The non-ASCII feature tests are
the backstop, so they must cover every category of call site, not a sample.

## Migration Plan

No user-facing migration. Internally: bump the persistent cache format version
so entries built under the old decoder are discarded on first run.

Rollback is a revert; no persisted state changes shape, only its contents.

## Open Questions

None outstanding. The binding's unit semantics were measured rather than
inferred, and the corpus encoding distribution was counted rather than
estimated.
