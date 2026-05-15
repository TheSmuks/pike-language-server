---
title: Other Editors
created: 2026-05-15
updated: 2026-05-15
type: entity
tags:
  - editor
  - neovim
  - helix
  - tooling
sources:
  - raw/articles/other-editors.md
---

# Other Editors

Using the Pike Language Server with editors beyond VSCode. The server communicates over stdio using the standard LSP protocol and works with any LSP-capable editor.

Related: [[vscode]], [[tree-sitter-pike]]

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

---

## Neovim (Verified)

Tested with Neovim 0.10.4 and [nvim-lspconfig](https://github.com/neovim/nvim-lspconfig).

### Setup with nvim-lspconfig

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
        return lspconfig.util.find_git_ancestor(fname) or vim.fn.getcwd()
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

```lua
lspconfig.pike_lsp.setup({
  settings = {
    pike = {
      diagnosticMode = "realtime",  -- "realtime" | "saveOnly" | "off"
    },
  },
})
```

### Tree-sitter Highlighting (nvim-treesitter)

Copy `queries/highlights.scm` from the repository to your nvim-treesitter queries directory:

```bash
mkdir -p ~/.local/share/nvim/site/queries/pike/
cp queries/highlights.scm ~/.local/share/nvim/site/queries/pike/
```

Then configure nvim-treesitter:

```lua
require('nvim-treesitter.configs').setup {
  ensure_installed = { 'pike' },
  highlight = {
    enable = true,
    custom_captures = {
      ['keyword.import'] = 'include',
      ['function.method'] = 'function',
      ['variable.parameter'] = 'variable',
    },
  },
}
```

Install the tree-sitter-pike parser via `:TSInstall pike` or your plugin manager.

---

## Helix (Unverified)

Helix uses `languages.toml` for LSP configuration:

```toml
[language-server.pike-lsp]
command = "bun"
args = ["/path/to/pike-language-server/standalone/server.js", "--stdio"]

language
name = "pike"
language-servers = ["pike-lsp"]
```

Note: Helix support is not yet verified. If you test it, please file an issue or PR with results.

### Helix Syntax Highlighting

Copy `queries/highlights.scm` from this repository to your Helix config directory:

```bash
mkdir -p ~/.config/helix/runtime/queries/pike/
cp queries/highlights.scm ~/.config/helix/runtime/queries/pike/highlights.scm
```

Helix will automatically use the queries for Pike files.

---

## Generic LSP Client Configuration

The server requires:
- **Transport:** stdio
- **Command:** `bun /path/to/pike-language-server/standalone/server.js --stdio`
- **File types:** `.pike`, `.pmod`, `.mmod`
- **Trigger characters:** `.`, `>`, `:`

### Server Capabilities

| Capability | Supported |
|------------|-----------|
| documentSymbol | Yes |
| definition | Yes |
| references | Yes |
| hover | Yes |
| completion | Yes |
| rename | Yes (with prepareRename) |
| diagnostics | Yes (pushed by server) |

---

## Troubleshooting

### "Parser not initialized" errors

The server initializes the tree-sitter parser on the `initialized` notification. If your client doesn't send this notification, parsing won't work. This is a bug in the client, not the server.

### No diagnostics

Diagnostics require Pike 8.0+ on PATH. Verify with:

```bash
pike --version
```

### No completion for stdlib symbols

The server includes a pre-built stdlib index (5,505 symbols). This should work without any configuration. If completions are missing, check that `stdlib-autodoc.json` exists in the same directory as `server.js`.
