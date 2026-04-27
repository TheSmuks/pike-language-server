# Pike Language Server

[![Changelog](https://img.shields.io/badge/changelog-Keep%20a%20Changelog-blue.svg)](./CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/TheSmuks/pike-language-server/blob/main/LICENSE)
[![Template](https://img.shields.io/badge/template-v0.2.0-blueviolet.svg)](./.template-version)

A tier-3 Language Server Protocol implementation for Pike, with VSCode as the primary client.

## About

Pike Language Server provides IDE-quality language support for the Pike programming language. It uses `pike` itself as the oracle for type information and diagnostics, and tree-sitter-pike as the syntactic parser.

### Design principles

- **Pike is the oracle.** Diagnostics, types, and symbol information come from invoking `pike` (via pike-ai-kb's MCP tools where possible). The LSP does not implement its own type checker.
- **Tree-sitter for syntax.** Parsing uses [tree-sitter-pike](https://github.com/TheSmuks/tree-sitter-pike) v1.1, which achieves 99.0% parse coverage on the Pike 8 distribution.
- **Test harness against ground truth.** Every test derives expected output from `pike`, not from hand-written expectations.

## Requirements

- [Pike](https://pike.lysator.liu.se/) 8.0+
- [Node.js](https://nodejs.org/) 22+
- [VS Code](https://code.visualstudio.com/) 1.85+ (for the extension)
- [tree-sitter-pike](https://github.com/TheSmuks/tree-sitter-pike) v1.1

## Getting Started

### Prerequisites

- Pike 8.0+ installed and on PATH
- Node.js 22+
- bun (package manager)

### Installation

```bash
git clone https://github.com/TheSmuks/pike-language-server.git
cd pike-language-server
bun install
bun run build
```

### Configuration

See [docs/configuration.md](docs/configuration.md) for LSP and extension configuration options.

## Project Structure

```
server/          # LSP server (TypeScript, vscode-languageserver-node)
extension/       # VSCode extension that hosts the server
harness/         # Test harness — invokes pike, captures ground truth, compares LSP output
corpus/          # Pike files covering language features the LSP must handle
docs/            # Investigation results, interface documentation, decisions
```

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development guidelines.

## Architecture

See [docs/architecture.md](./docs/architecture.md) for system design and component overview.

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for a history of notable changes.

## License

This project is licensed under the [MIT License](./LICENSE).
