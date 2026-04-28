# Phase 5 Cleanup Verification Report

Date: 2026-04-27

## 1. Hover Output Correctness

Tested against Pike's published reference docs at pike.lysator.liu.se for 5 documented methods plus 20-symbol random sample from stdlib index.

### Issues Found and Fixed

| Issue | Severity | Status | Root Cause |
|-------|----------|--------|------------|
| `<mixed>` element silently dropped in param docs | High | **Fixed** | `renderBlocks` group case only extracted `<p>` from `<text>`, ignoring block children like `<mixed>` |
| `<string>` value list silently dropped (e.g., mode letters in `Stdio.File.open`) | High | **Fixed** | `renderDocGroup` same issue; also `doc` case only extracted `<p>` from `<text>` |
| `<expr>` rendered as plain text instead of inline code | Medium | **Fixed** | Missing case in `renderInline` switch |
| Multiple overloads only first shown | Medium | **Fixed** | `renderAutodoc` broke after first signature; now collects all |
| `<zero>` type rendered as empty string | Low | **Fixed** | Missing type case |
| Range-constrained `int` showed as bare `int` | Low | **Fixed** | `int` case now checks for `<min>`/`<max>` children |

### Before vs After: Stdio.File.open

**Before:**
```
int open(string filename, string mode)

Open a file for read, write or append. The parameter mode should
contain one or more of the following letters:
mode should always contain at least one of the letters "r" or "w".
```

**After:**
```pike
int open(string filename, string mode)
int open(string filename, string mode, int mask)
```

Open a file for read, write or append. The parameter mode should
contain one or more of the following letters:
  - `"r"` — Open file for reading.
  - `"w"` — Open file for writing.
  - `"a"` — Open file for append (use with `"w"`).
  - `"t"` — Truncate file at open (use with `"w"`).
  - `"c"` — Create file if it doesn't exist (use with `"w"`).
  - `"x"` — Fail if file already exists (use with `"c"`).
mode should always contain at least one of the letters `"r"` or `"w"`.
**Returns:** This function returns `1` for success, `0` otherwise.

### Before vs After: Getopt.find_option `def` param

**Before:**
```
- `def` — This argument has two functions: It specifies if the option
  takes an argument or not, and it informs find_option() what to return
  if the option is not present. The value may be one of:
```
(content stops — table silently dropped)

**After:**
```
- `def` — This argument has two functions: ... The value may be one of:
    - `int(0..0)|zero` — The option does not require a value.
    - `int(1..1)|string` — The option requires a value, and def will
      be returned if the option is not present. ...
```

### Remaining Known Limitations

- **Cross-references (`<ref>`)**: Rendered as plain text (no hyperlinks). VSCode hover doesn't support clickable links in markdown content. Phase 6 could resolve to LSP locations.
- **Signature type accuracy**: PikeExtractor produces types from source declarations, not from runtime introspection. For `Getopt.find_option`, the source says `string|int` but the reference says `void|string|bool`. This is a PikeExtractor limitation, not a renderer bug.

## 2. Stdlib Index Correctness

20 random symbols sampled from 5,505-entry index. Checked against published Pike reference docs.

**Result**: No disagreements found in the 20-symbol sample. All parameters, return types, and descriptions match the reference.

The rendering bugs from item 1 affected specific entries (those using `<mixed>`, `<string>`, or having multiple overloads). These are now fixed and the index has been rebuilt.

## 3. Cold/Warm Latency (Corrected)

Previous report cited 0.58ms for PikeExtractor — this was from a 37-line corpus file. Real measurements:

| File | Lines | PikeExtractor | XML Size |
|------|-------|---------------|----------|
| autodoc-documented.pike | 37 | 0.58ms | 1.7KB |
| Tools.Hilfe.pmod | 3,222 | 28.7ms | 28.9KB |
| Calendar.YMD.pike | 3,416 | 29.3ms | 32.7KB |
| Stdio.pmod/module.pmod | 3,686 | 41.0ms | 99.9KB |
| Standards.FIPS10_4.pmod | 4,513 | 57.8ms | 7.6KB |

**Full hover cold path** (parseXml + findDocGroup + renderAutodoc on 90KB XML):
- Cold: ~7ms
- Warm (re-render same symbol): ~2.3ms per symbol
- Full render all 92 symbols in one file: 203ms (~2.2ms each)

**Concurrent behavior**: The Pike worker is a single process handling one stdio request at a time. Multiple requests queue FIFO. The `request()` method in pikeWorker.ts is async but writes to stdin synchronously — the next request waits for the previous response. This is correct per decision 0011 §6f.

## 4. Resource Policy Audit

All 8 policies from decision 0011 §6:

| Policy | Implemented | Tested | Notes |
|--------|-------------|--------|-------|
| Idle worker eviction (5min) | Yes | Yes (2 tests) | `resetIdleTimer()` on every request, `unref()` to not prevent exit |
| Memory ceiling (100 req / 30min) | Yes | Partial | Request count tested; active time not tested (would need Date.now mock) |
| Timeout reduced to 3-5s | Yes | Yes (2 tests) | 5s default, `timedOut` flag surfaced as diagnostic |
| File watching (editor-push only) | Yes | N/A | No inotify/watchman in server code; verified by inspection |
| Cache size cap (50/25MB LRU) | Yes | Yes (1 test) | Both pikeCache and autodocCache share eviction |
| FIFO queueing | Yes | N/A | Single worker process, sequential by construction |
| CPU politeness (nice +5) | Yes | N/A | Spawn flag on Linux; reasonable not to test |
| Cold/warm separation | Yes | N/A | Numbers reported separately above |

**Gap**: Active time ceiling (`maxActiveMinutes: 30`) is implemented but untested. The logic is 4 lines in `shouldForceRestart()`. Adding a test requires mocking `Date.now()` or using a very short `maxActiveMinutes`. Low risk.

## 5. C-level Builtins

### Finding
- 300 predef symbols total, 283 are C-level functions
- pike-ai-kb's `pike-signature` tool has a compilation bug and fails for all symbols
- pike-ai-kb has extensive predef documentation in `stdlib-patterns.md` but as a skill reference file, not callable from LSP

### Resolution
- Built `predef-builtin-index.json`: 283 C-level functions with full type signatures from Pike's `_typeof()`
- Wired as Tier 2b in hover: after stdlib autodoc index, before tree-sitter fallback
- Signature display: first overload shown, full type string in documentation block

### Coverage
- **Indexed**: 283 C-level functions with type signatures (write, werror, arrayp, sprintf, random, search, map, filter, etc.)
- **Not covered**: C-level functions don't have AutoDoc descriptions — only type signatures. No parameter descriptions, no examples, no notes.
- **Remaining gap**: ~17 non-function predef symbols (objects, programs, constants)

### Accurate Limitation Framing
The previous framing ("builtins are not supported") was wrong. The accurate framing:

> C-level builtins are supported via Pike runtime type signatures (Tier 2b). They show function signatures with full type information but lack AutoDoc descriptions (parameters, examples, notes) since PikeExtractor only processes Pike source files, not C modules. 283 builtins have type signatures; 17 non-function predef symbols remain uncovered.
