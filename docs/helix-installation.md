# Installing the Pike Language Server for Helix

A complete, step-by-step setup for Helix — from nothing to a working Pike LSP
with syntax highlighting.

Verified against **Helix 25.01.1** on Linux. Every command and config block
below was run end-to-end against a real Helix install.

Helix needs two independent things, and they are configured separately:

| What | Gives you | Needs |
|------|-----------|-------|
| **Language server** | hover, completion, goto, references, rename, diagnostics | `[language-server.pike-lsp]` + `[[language]]` |
| **Tree-sitter grammar** | syntax highlighting | `[[grammar]]` + `hx --grammar build` + highlight queries |

Setting up only the first leaves you with a working LSP and **no highlighting**.
Steps 1–5 cover the LSP; step 6 covers highlighting.

---

## 1. Install Helix

Follow the official instructions: <https://docs.helix-editor.com/install.html>

Verify:

```bash
hx --version
```

## 2. Install the prerequisites

| Tool | Why | Check |
|------|-----|-------|
| [Bun](https://bun.sh/) | runs the server | `bun --version` |
| [Pike](https://pike.lysator.liu.se/) 8.0+ | produces diagnostics | `pike --version` |
| A C compiler + `git` | only for step 6 (grammar) | `cc --version` |

Bun is required. Pike is only needed for diagnostics — everything else (hover,
completion, goto, rename) works without it.

## 3. Build the server

```bash
git clone https://github.com/TheSmuks/pike-language-server.git
cd pike-language-server
bun install
bun run build:standalone
```

This produces `standalone/server.js`. Confirm it serves LSP over stdio:

```bash
bun run check:standalone
```

Note the absolute path to `standalone/server.js` — you need it next. The rest of
this guide writes it as `/path/to/pike-language-server`.

## 4. Configure Helix

Add to `~/.config/helix/languages.toml` (create the file if it does not exist):

```toml
[language-server.pike-lsp]
command = "bun"
args = ["/path/to/pike-language-server/standalone/server.js", "--stdio"]

[[language]]
name = "pike"
scope = "source.pike"
file-types = ["pike", "pmod", "mmod"]
comment-token = "//"
indent = { tab-width = 2, unit = "  " }
roots = ["pike.json", ".git"]
language-servers = ["pike-lsp"]
```

Helix ships no built-in Pike language, so you define it yourself. Two fields are
easy to omit and both are fatal:

- **`scope` is mandatory.** Without it Helix rejects the *entire* user language
  config — every language, not just Pike — and falls back to defaults.
- **`file-types` is what attaches Pike to your files.** Without it, Helix never
  recognises a `.pike` file and the server never starts.

## 5. Verify the language server

```bash
hx --health pike
```

You want a green check next to `bun`:

```
Configured language servers:
  ✓ bun: /home/you/.bun/bin/bun
```

Then open a Pike file and confirm the server actually attached:

```bash
hx -v some-file.pike
```

`-v` logs LSP traffic to `~/.cache/helix/helix.log`. In another shell:

```bash
grep -c "pike-lsp" ~/.cache/helix/helix.log
```

A non-zero count means Helix and the server are talking. Inside the editor,
`gd` (goto definition), `K` (hover), and `<space>r` (rename) should now work.

At this point the LSP is fully working, but the file is **not highlighted**.

## 6. Syntax highlighting

Highlighting is tree-sitter, entirely separate from the LSP. It needs a
compiled grammar **and** highlight queries — one without the other gives you
nothing.

Add the grammar to the same `~/.config/helix/languages.toml`:

```toml
[[grammar]]
name = "pike"
source = { git = "https://github.com/TheSmuks/tree-sitter-pike", rev = "main" }
```

Fetch and compile it, then install the queries from this repository:

```bash
hx --grammar fetch
hx --grammar build
mkdir -p ~/.config/helix/runtime/queries/pike/
cp queries/highlights.scm ~/.config/helix/runtime/queries/pike/highlights.scm
```

`hx --grammar fetch` and `build` operate on *every* grammar Helix knows about,
so they take a while and may report unrelated grammars failing — that is
expected and harmless. Only the Pike result matters:

```bash
hx --health pike
```

```
Tree-sitter parser: ✓
Highlight queries: ✓
Textobject queries: ✘
Indent queries: ✘
```

`Textobject` and `Indent` stay `✘` — this repository ships no such queries.

## 7. Optional configuration

Server settings go in a `config` key on the language-server block you already
created. Helix delivers it as `initializationOptions`, which is the only place
this server reads settings from:

```toml
[language-server.pike-lsp]
command = "bun"
args = ["/path/to/pike-language-server/standalone/server.js", "--stdio"]
config = { diagnosticMode = "realtime" }
```

Do **not** repeat the `[language-server.pike-lsp]` header a second time in the
file — duplicate TOML tables make Helix reject the whole config.

| Option | Values | Default |
|--------|--------|---------|
| `diagnosticMode` | `"realtime"`, `"saveOnly"`, `"off"` | `"realtime"` |
| `diagnosticDebounceMs` | positive integer | `500` |
| `maxNumberOfProblems` | positive integer | `100` |

## Troubleshooting

**`Language 'pike' not found`** — `file-types` is missing, or the config failed
to parse and Helix silently fell back to defaults. Run `hx --health pike` and
read the first line of output.

**`Error parsing user language config: missing field 'scope'`** — add
`scope = "source.pike"`. Until you do, *no* language config of yours loads.

**`Error parsing user language config: TOML parse error`** — you almost
certainly declared `[language-server.pike-lsp]` twice. Merge the blocks.

**`hx --health pike` shows `✘ bun`** — Bun is not on the `PATH` Helix sees. Use
an absolute path in `command`, e.g. `command = "/home/you/.bun/bin/bun"`.

**Server never attaches** — check the path in `args` resolves, then re-test the
build from the repository clone:

```bash
bun run check:standalone
```

This spawns the server exactly as Helix does and asserts it answers an LSP
`initialize`. If it fails, re-run `bun run build:standalone`. (Running
`bun standalone/server.js --stdio` by hand proves little: with no LSP client on
the other end it reads end-of-input and exits 0 straight away.)

**No highlighting, LSP works** — `hx --health pike` reports
`Tree-sitter parser: None`. Finish step 6; queries alone are not enough.

**No diagnostics, everything else works** — Pike is not on `PATH`. Check
`pike --version`. Diagnostics are the only feature that needs the Pike binary.

**Nothing works after an upgrade** — Helix config errors are printed at startup
and scroll past instantly. `hx --health pike` reprints them.

## What works

Every feature below was exercised against Helix 25.01.1's own client
capabilities and confirmed to return real results (`bun run check:helix`
re-runs this):

- Document symbols, hover, goto-definition, find references
- Completion (trigger characters `.`, `>`, `:`, `!`) and signature help
- Rename and prepareRename
- Document highlight, selection range, workspace symbols
- Formatting, inlay hints, code actions
- Diagnostics (pushed by the server; requires Pike on `PATH`)

Helix 25.01 has no semantic-token support, so the server's semantic tokens are
unused there — highlighting comes from the tree-sitter grammar instead.

**One known limitation:** a *file-scope* declaration whose name collides with a
Pike stdlib or predef name (`write`, `count`, `size`, …) cannot be renamed, in
any editor. Locals, parameters, and class members are always renameable.
