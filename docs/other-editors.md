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

Pass initialization options in the setup call:

```lua
lspconfig.pike_lsp.setup({
  settings = {
    pike = {
      diagnosticMode = "realtime",  -- "realtime" | "saveOnly" | "off"
    },
  },
})
```

## Helix

Helix uses `languages.toml` for LSP configuration. Add to your `languages.toml`:

```toml
[language-server.pike-lsp]
command = "bun"
args = ["/path/to/pike-language-server/standalone/server.js", "--stdio"]

[[language]]
name = "pike"
language-servers = ["pike-lsp"]
```

Note: Helix support is not yet verified. If you test it, please file an issue or PR with results.

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

The server includes a pre-built stdlib index (5,505 symbols). This should work without any configuration. If completions are missing, check that `stdlib-autodoc.json` exists in the same directory as `server.js`.
