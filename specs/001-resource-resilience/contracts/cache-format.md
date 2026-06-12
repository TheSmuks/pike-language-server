# Contract: Persistent Cache Format and Lifecycle

## Scope

Defines the workspace-local `.pike-lsp/` cache contract for resource-resilient startup, metadata validation, migration, pruning, and hibernation saves.

## Files

```text
.pike-lsp/
├── cacheIndex.json
└── cache/
    └── <contentHash>.json
```

## cacheIndex.json

Required fields:
- `formatVersion`: integer cache schema version.
- `wasmHash`: short hash of the tree-sitter Pike WASM.
- `entryCount`: number of live entries saved in the last complete save.
- `savedAtMs`: save timestamp.

Validation:
- Unsupported `formatVersion` or mismatched `wasmHash` invalidates the cache root unless a migration path exists.
- `entryCount` is a sanity bound. If actual JSON entry count vastly exceeds expected live count, wipe and rebuild rather than load garbage.

## Cache entry

Required fields:
- `uri`: normalized file URI.
- `version`: document/index version.
- `contentHash`: content hash and filename stem.
- `mtimeMs`: source file modification time.
- `sizeBytes`: source file size.
- `dependencies`: normalized dependency URI array.
- `symbolTable`: serialized symbol table or `null` for a stub entry.

Load behavior:
- Entries are processed in bounded batches.
- A valid metadata match does not read file contents.
- Missing metadata indicates old format. On first upgraded launch, stat the source file, add `mtimeMs`/`sizeBytes`, keep the entry if otherwise valid, and drop corrupt/superseded entries.
- Corrupt JSON, missing required fields, missing source files, and duplicate/superseded entries are dropped and scheduled for prune.

Save behavior:
- Write each live entry atomically through temp file + rename.
- Write `cacheIndex.json` last.
- Prune cache files not in the live entry set after a successful save cycle.
- After save completes, the number of JSON files under `.pike-lsp/cache/` equals live entry count.

Deadline behavior:
- Shutdown/hibernation save has a bounded deadline.
- Deadline expiry is logged and must not block worker termination or LSP shutdown.
