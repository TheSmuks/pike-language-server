# Using Pike LSP with Other Editors

The Pike Language Server communicates over stdio using the standard LSP protocol. It works with any LSP-capable editor.

## Prerequisites

1. [Bun](https://bun.sh/) runtime installed and on PATH
2. [Pike](https://pike.lysator.liu.se/) 8.0+ installed and on PATH
3. Clone and build the server:

```bash
git clone https://github.com/TheSmuks/pike-language-server.git
cd pike-language-server
bun install
bun run build:standalone
```

The server binary is at `standalone/server.js`. Run it with:

```bash
bun /path/to/pike-language-server/standalone/server.js --stdio
```

## Neovim (verified)

Tested with Neovim 0.10.4 and [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig).

### Setup with nvim-lspconfig

Install nvim-lspconfig, then add to your `init.lua`:

```lua
local configs = require("lspconfig.configs")
local lspconfig = require("lspconfig")

-- Register the pike-lsp config (if not already registered)
if not configs.pike_lsp then
  configs.pike_lsp = {
    default_config = {
      cmd = { "bun", "/path/to/pike-language-server/standalone/server.js", "--stdio" },
      filetypes = { "pike", "pmod" },
      root_dir = function(fname)
        return vim.fs.dirname(vim.fs.find(".git", { path = fname, upward = true })[1])
          or vim.fn.getcwd()
      end,
      single_file_support = true,
    },
  }
end

lspconfig.pike_lsp.setup({})
```

Replace `/path/to/pike-language-server` with the actual clone path.

### Features verified on Neovim

- LSP client attaches on `.pike` and `.pmod` files
- Document symbols (classes, functions, variables, enums)
- Hover (type info, AutoDoc documentation)
- Completion with trigger characters `.`, `>`, `:`
- Go-to-definition (same-file and cross-file)
- Find references (workspace-wide)
- Rename (with prepareRename support)

### Configuration

The server reads its configuration from `initializationOptions` only — it never
issues a `workspace/configuration` request. Use `init_options`; a `settings`
block is silently ignored.

```lua
lspconfig.pike_lsp.setup({
  init_options = {
    diagnosticMode = "realtime",  -- "realtime" | "saveOnly" | "off"
  },
})
```

## Helix (verified)

> **Setting up Helix from scratch?** Follow the step-by-step
> [Helix installation guide](helix-installation.md) instead — it covers
> installing Helix, syntax highlighting, and troubleshooting. The summary below
> assumes you already know your way around `languages.toml`.

Tested with Helix 25.01.1. Helix has no built-in Pike language, so you must
define it yourself — `scope` and `file-types` are both required, and Helix
rejects the *entire* user language config if `scope` is missing.

Add to `~/.config/helix/languages.toml`:

```toml
[language-server.pike-lsp]
command = "bun"
args = ["/path/to/pike-language-server/standalone/server.js", "--stdio"]
# Optional — see "Helix configuration" below:
# config = { diagnosticMode = "realtime" }

[[language]]
name = "pike"
scope = "source.pike"
file-types = ["pike", "pmod", "mmod"]
comment-token = "//"
indent = { tab-width = 2, unit = "  " }
roots = ["pike.json", ".git"]
language-servers = ["pike-lsp"]
```

Verify the language server is wired up:

```bash
hx --health pike
```

### Helix configuration

Helix passes a `config` block to the server as `initializationOptions`, which is
exactly where this server reads its settings from. Add the `config` key to the
`[language-server.pike-lsp]` block you already defined above — do not repeat the
block, or Helix will reject the file as a duplicate TOML table:

```toml
config = { diagnosticMode = "realtime" }  # "realtime" | "saveOnly" | "off"
```

### Features verified on Helix

Exercised against the standalone bundle using Helix 25.01.1's own client
capabilities, and confirmed to return real results:

- Document symbols, hover, goto-definition, find references
- Completion (trigger characters `.`, `>`, `:`, `!`) and signature help
- Rename and prepareRename — see the limitation below
- Document highlight, selection range, workspace symbols
- Formatting, inlay hints, code actions
- Diagnostics (pushed by the server)

Helix 25.01 has no semantic-token support, so the server's semantic tokens go
unused there; highlighting comes from the tree-sitter grammar instead.

**Rename limitation:** a *file-scope* declaration whose name collides with a
Pike stdlib or predef name (`write`, `count`, `size`, …) cannot be renamed — it
shadows the predef and propagates to dependent files by name, which the rename
engine cannot disambiguate. Locals, parameters, and class members are always
renameable, whatever they are called. This is not Helix-specific; it applies to
every client, VSCode included.

### Helix syntax highlighting with tree-sitter

Highlight queries alone are **not** enough — Helix also needs a compiled Pike
grammar, or it loads no parser and nothing is highlighted. You need both.

Add the grammar to the same `languages.toml`:

```toml
[[grammar]]
name = "pike"
source = { git = "https://github.com/TheSmuks/tree-sitter-pike", rev = "main" }
```

Then fetch and build it, and install the highlight queries:

```bash
hx --grammar fetch
hx --grammar build
mkdir -p ~/.config/helix/runtime/queries/pike/
cp queries/highlights.scm ~/.config/helix/runtime/queries/pike/highlights.scm
```

Confirm both parts are present — `hx --health pike` should report
`Tree-sitter parser: ✓` and `Highlight queries: ✓`. This repository ships no
textobject or indent queries, so those stay `✘`.

### Neovim with nvim-treesitter

nvim-treesitter uses tree-sitter queries for syntax highlighting. Copy
`queries/highlights.scm` from this repository to your nvim-treesitter queries
directory:

```bash
mkdir -p ~/.local/share/nvim/site/queries/pike/
cp queries/highlights.scm ~/.local/share/nvim/site/queries/pike/
```

```lua
-- In your init.lua or treesitter config:
require('nvim-treesitter.configs').setup {
  ensure_installed = { 'pike' }, -- requires tree-sitter-pike parser
  highlight = {
    enable = true,
    custom_captures = {
      -- Map @keyword.import to @include for consistent styling
      ['keyword.import'] = 'include',
      ['function.method'] = 'function',
      ['variable.parameter'] = 'variable',
    },
  },
}
```

The `custom_captures` map the audit-required captures to standard nvim-treesitter
highlight groups. The tree-sitter-pike parser must be installed separately
(via `:TSInstall pike` or your plugin manager).

## Generic LSP client configuration

The server requires:
- **Transport:** stdio
- **Command:** `bun /path/to/pike-language-server/standalone/server.js --stdio`
- **File types:** `.pike`, `.pmod`, `.mmod`
- **Trigger characters:** `.`, `>`, `:`

### Server capabilities

| Capability | Supported |
|------------|-----------|
| documentSymbol | Yes |
| definition | Yes |
| references | Yes |
| hover | Yes |
| completion | Yes |
| rename | Yes (with prepareRename) |
| diagnostics | Yes (pushed by server) |

## Troubleshooting

### "Parser not initialized" errors

The server initializes the tree-sitter parser on the `initialized` notification. If your client doesn't send this notification, parsing won't work. This is a bug in the client, not the server.

### No diagnostics

Diagnostics require Pike 8.0+ on PATH. Verify with:

```bash
pike --version
```

### No completion for stdlib symbols

The server includes a pre-built stdlib index (9,016 symbols, runtime-reconciled). This should work without any configuration. If completions are missing, check that `stdlib-autodoc.json` exists in the same directory as `server.js`.
