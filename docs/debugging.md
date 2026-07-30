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
  probe cannot see this layer; test the grammar directly (below).

## Testing the TextMate grammar

The TextMate layer has its own tests — they do not involve the server:

```bash
bun test tests/tooling/tmLanguage.test.ts
bun test tests/tooling/tmLanguage-tokenization.test.ts
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

## Extension-host memory

`bun run --cwd tests/integration memory-probe` launches a real VSCode, activates
the extension, opens Pike's own stdlib largest-first, and reports memory from
*inside* the extension host, with the language-server child sampled from `/proc`
at the same instant.

It exists because the two are easy to confuse. VSCode's process explorer nests
the language server under the extension host, so the server's RSS reads as the
host's. They are separate processes with separate budgets, and the fixes are
different.

Measured 2026-07-30 (40 largest stdlib files, Pike 8.0.1116, node 22):

| | before activate | settled | growth |
|---|---|---|---|
| extension host RSS | 146–148 MB | 174–182 MB | **+28–34 MB** |
| extension host heap | 25–27 MB | 47–53 MB | +22–26 MB |
| language server RSS | — | 233–239 MB (peak ~340 MB) | — |

So roughly **147 MB of the extension host is VSCode's own floor**, before any of
our code runs. What this extension adds to the host is tens of megabytes, most
of it VSCode holding document text and symbols for open files. Forcing semantic
tokens (which are off by default) accounts for about 6 MB RSS of that across 40
large files — real, but not the story.

The number people actually notice is the server's, and that is the one
`memory.budgetMb`, the heap cap and the lazy cache exist to bound. See
`decisions/` and the perf work for that side. Read the server's settled figure
no sooner than 60s after load: the burst is a transient high-water mark that V8
returns (~340 MB → ~235 MB here).

`PIKE_PROBE_NO_TOKENS=1` skips the semantic-token requests to measure the
default path. `PIKE_PROBE_WORKSPACE` opens a real workspace (Pike's stdlib, a
Roxen checkout) instead of the in-repo corpus, and `PIKE_PROBE_FILES` sets how
many files to open.

### Where the multi-gigabyte figure comes from

Measured 2026-07-30 with Pike's stdlib as the workspace and 60 files open:

| | before our extension activates | settled |
|---|---|---|
| whole VSCode tree, summed RSS | 1411 MB | 1549 MB |
| whole VSCode tree, summed PSS | 859 MB | 925 MB |

Two things matter here.

**Most of it is VSCode.** Its floor with `--disable-extensions` and nothing open
is already ~1.4 GB RSS. At settle the largest processes are the renderer
(261 MB PSS), our language server (186 MB), the extension host (134 MB, of
which ~148 MB RSS was VSCode's own floor before we activated), the main process
(113 MB) and the GPU process (78 MB).

**Summed RSS double-counts.** Electron runs a dozen processes sharing one large
binary, and RSS charges those pages to every one of them. PSS divides each
shared page by the number of processes mapping it, and comes out ~40% lower.
Any figure obtained by adding up per-process RSS — including VSCode's own
process explorer — overstates the real footprint.

This extension's own share at settle is the language server (~186 MB PSS /
~248 MB RSS), the Pike worker (~23 MB PSS), and ~40 MB of extension-host growth.

### Comparing two server builds

`bun run scripts/measure-server-memory.ts <server.mjs> [--files N] [--settle S]`
drives a build directly over stdio, with no VSCode in the way, so two builds can
be compared with one variable. It uses the same heap cap the VSCode client
passes, and reports peak and settled separately.

Paired runs, 60 largest stdlib files, v0.8.49 (pre-Roxen) against current:

| run | current settled RSS | v0.8.49 settled RSS |
|---|---|---|
| 1 | 247 MB | 275 MB |
| 2 | 231 MB | 228 MB |
| 3 | 230 MB | 234 MB |

Within noise of each other — the Roxen work cost nothing measurable. Note the
first run of each is high: page cache is cold, and peak in particular swings
320–410 MB on GC timing alone. Always take at least three paired runs before
calling a difference real.
