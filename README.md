# Pike Language Server

[![Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-blue.svg)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/TheSmuks/pike-language-server/blob/main/LICENSE)
[![Template](https://img.shields.io/badge/template-v0.2.0-blueviolet.svg)](./.template-version)

A tier-3 Language Server Protocol implementation for Pike. Works with VS Code, Neovim, Helix, and any LSP-capable editor.

## Features

- **Diagnostics** — real-time compilation errors from Pike, debounced at 500ms
- **Hover** — type info, AutoDoc documentation, stdlib signatures
- **Go-to-definition** — same-file scope chain, cross-file via inherit/import
- **Find references** — workspace-wide, including cross-file
- **Completion** — local scope, class members, stdlib (5,500+ symbols), predef builtins (283)
- **Rename** — workspace-wide, scope-aware, cross-file
- **Document symbols** — classes, functions, variables, enums
- **Semantic tokens** — syntax highlighting with 9 token types + 5 modifiers
- **Signature help** — parameter hints with active parameter tracking
- **Code actions** — remove unused variable, add missing import
- **Workspace symbol search** — cross-file, prefix matching, case-insensitive
- **Document highlights** — read/write highlighting for declarations and references
- **Folding ranges** — blocks, classes, comment groups
- **Background indexing** — workspace files indexed on startup
- **Persistent cache** — analysis reused across sessions

## Requirements

- [Pike](https://pike.lysator.liu.se/) 8.0+ (on PATH)
- [Bun](https://bun.sh/) runtime

Pike is the oracle for type information and diagnostics. Bun is the JavaScript runtime. You do **not** need Node.js unless developing the extension.

## Installation

### From source

```bash
git clone https://github.com/TheSmuks/pike-language-server.git
cd pike-language-server
bun install
bun run build:standalone
```

This produces a standalone server bundle in `standalone/`. Run it with:

```bash
bun standalone/server.js --stdio
```

Or use the wrapper script:

```bash
./bin/pike-language-server --stdio
```

### VS Code

1. Install the [Pike extension](https://marketplace.visualstudio.com/items?itemName=TheSmuks.pike) from the marketplace
2. The extension bundles and manages the server automatically

### Other editors

For Neovim, Helix, and other LSP clients, see [docs/other-editors.md](docs/other-editors.md).

## Configuration

The server supports these initialization options:

| Option | Default | Description |
|--------|---------|-------------|
| `diagnosticMode` | `"realtime"` | `"realtime"`, `"saveOnly"`, or `"off"` |

See [docs/configuration.md](docs/configuration.md) for full details.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

```bash
bun install          # install dependencies
bun run build        # typecheck + emit
bun test             # run all tests
bun run typecheck    # type-check only
bun run lint         # lint
```

## Architecture

The server uses a three-source resolution strategy:

1. **Tree-sitter** (syntactic) — real-time, sub-millisecond, partial
2. **Pike** (semantic) — debounced compilation, authoritative diagnostics and types
3. **Pre-built indices** — stdlib (5,505 symbols) + predef builtins (283 symbols)

See [docs/architecture.md](docs/architecture.md) for full system design.

## Design principles

- **Pike is the oracle.** The LSP does not implement its own type checker.
- **Tree-sitter for syntax.** [tree-sitter-pike](https://github.com/TheSmuks/tree-sitter-pike) v1.1 achieves 99.0% parse coverage.
- **Test harness against ground truth.** Every test derives expected output from Pike.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for a history of notable changes.

## License

This project is licensed under the [MIT License](./LICENSE).
