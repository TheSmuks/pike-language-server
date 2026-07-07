# Debugging the Pike extension

This project has two very different debug surfaces:

1. **The LSP server** — TypeScript, runs headless, answers requests (hover,
   completion, semantic tokens, diagnostics, …). This is where most logic lives
   and where most bugs are.
2. **The VSCode client** — a thin extension that spawns the server and wires it
   to the editor (status bar, commands, TextMate grammar, semantic-token theme
   mapping).

Most "the extension is broken" reports are really "the server returned the wrong
thing" or "the manifest wired it up wrong." You can diagnose almost all of it
**without opening VSCode** using the headless probe below.

## Headless LSP probe — the fast loop

`scripts/lsp-probe.ts` boots the real server in-process (same code path as
production) and fires a single LSP request against a Pike file, printing a
decoded result. No VSIX, no install, no editor.

```bash
bun run probe tokens      corpus/files/basic-types.pike      # semantic tokens, decoded
bun run probe tokens      corpus/files/basic-types.pike --summary  # counts per token type
bun run probe hover       corpus/files/basic-types.pike 7:5  # hover at line 7, col 5 (1-based)
bun run probe complete    somefile.pike 12:3                 # completion
bun run probe define      somefile.pike 12:3                 # go-to-definition
bun run probe symbols     somefile.pike                      # document symbols
bun run probe diagnostics somefile.pike                      # waits for publishDiagnostics
bun run probe capabilities                                   # what the server advertises
bun run probe raw textDocument/foldingRange somefile.pike    # any method, escape hatch
```

Positions are **1-based** `line:col` (as the editor shows them); the probe
converts to LSP's 0-based coordinates.

### Reading the `tokens` output

Syntax highlighting comes from **two independent systems** — this is the single
most important thing to understand when highlighting looks wrong:

| Layer | Source | Covers |
|-------|--------|--------|
| TextMate grammar | `client/syntaxes/pike.tmLanguage.json` | keywords (`int`, `if`, `return`), strings, comments, numbers, operators |
| Semantic tokens | LSP server → `semanticTokenScopes` in `package.json` | identifiers: which name is a variable vs function vs method vs type |

`bun run probe tokens <file>` shows only the **semantic** layer. If you run it on
`basic-types.pike` you will see that `int`/`float`/`string` keywords produce **no
token** — that is correct; those are the TextMate grammar's job. So:

- **Identifier colored wrong** (a function name looks like a variable) → semantic
  tokens. Check the probe output and `semanticTokenScopes` in the manifest.
- **Keyword/string/comment not colored** → TextMate grammar, not the server. The
  probe cannot see this layer; test the grammar with the harness (below).

## Testing the TextMate grammar

The TextMate layer has its own harness — it does not involve the server:

```bash
bun test harness/__tests__/tmLanguage.test.ts
bun test harness/__tests__/tmLanguage-tokenization.test.ts
```

## Fast rebuild (watch mode)

```bash
bun run watch:server   # rebuilds server/dist/server.mjs on change (~1s)
bun run watch:client   # rebuilds client/dist/extension.cjs on change (~100ms)
```

These wrap esbuild in watch mode **and** replicate the post-processing that the
one-shot build scripts do (WASM asset copies for the server, the import-meta
polyfill site for the client), so the watched output is actually runnable — a
bare `esbuild --watch` would skip those and emit a subtly broken bundle.

## Interactive debugging inside VSCode (optional)

For breakpoint debugging in a live editor, `.vscode/launch.json` provides an
**"Extension + Server"** compound: press F5, and it opens an Extension
Development Host with the extension loaded from source, attaches to the client,
and attaches the Node debugger to the server subprocess (port 6009, which the
extension opens automatically in debug mode). Breakpoints in `client/*.ts` and
`server/src/**/*.ts` both hit.

## Two manifests, one source of truth

There are **two** extension manifests:

- `extension.package.json` — **the single source of truth for `contributes`**
  (grammars, languages, `semanticTokenScopes`, commands, the full config
  schema). Packaged into the VSIX (VSIX layout: grammar at `syntaxes/…`).
- `package.json` — the bun project manifest, which VSCode also reads when you
  F5-debug from source (dev layout: grammar at `client/syntaxes/…`).

**Edit `contributes` only in `extension.package.json`.** `package.json`'s
`contributes` is generated from it by `scripts/sync-manifest.ts`, which rewrites
the grammar/language-configuration paths to the `client/` dev layout. The sync
runs automatically at the start of `bun run build:extension`, and the
`manifest stays in sync` test (`tests/lsp/manifestSync.test.ts`) fails CI if the
two ever drift. Run it manually with `bun run manifest:sync`; check without
writing via `bun run manifest:check`.

These previously drifted by hand (different config descriptions, and
`extension.package.json` declared ~15 settings the root one omitted), which made
behavior differ between F5 and an installed VSIX. The generator removes that
whole class of bug.

## Known cleanup

`scripts/build-client.sh` (and the watch wrapper) contain a `sed`/replace of
`var import_meta = {}` that is now a **no-op** — esbuild ≥0.28 no longer emits
that form for CJS. Harmless today, but verify web-tree-sitter WASM resolution in
the client still works if you touch the client bundle format.
