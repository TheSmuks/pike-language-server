<div align="center">

<img src="icon.png" width="112" alt="Pike Language Server logo" />

# Pike Language Server

**Rich, IDE-grade language support for [Pike](https://pike.lysator.liu.se/) in Visual Studio Code** — diagnostics, completion, navigation, refactoring, and formatting, powered by the Pike compiler itself.

<!-- template-v0.8.39 -->
[![Marketplace](https://img.shields.io/github/v/release/TheSmuks/pike-language-server?label=marketplace&logo=visualstudiocode&color=0066b8)](https://marketplace.visualstudio.com/items?itemName=thesmuks.pike-language-server)
[![CI](https://github.com/TheSmuks/pike-language-server/actions/workflows/ci.yml/badge.svg)](https://github.com/TheSmuks/pike-language-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/TheSmuks/pike-language-server/blob/main/LICENSE)

[Install](#installation) · [Features](#features) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Contributing](./CONTRIBUTING.md)

</div>

---

## Why

Pike is a powerful language with a sparse tooling story. This extension brings a modern editing experience to `.pike`, `.pmod`, and `.mmod` files by using **`pike` itself as the semantic oracle** — diagnostics, types, and symbol resolution come from the real compiler, not heuristics — with [tree-sitter-pike](https://github.com/TheSmuks/tree-sitter-pike) providing fast, incremental syntax parsing.

The extension bundles and manages the language server automatically. Install it, open a Pike file, and it just works.

## Installation

**Prerequisites**

- **Pike 8.0+** — install from [pike.lysator.liu.se](https://pike.lysator.liu.se/) and make sure `pike` is on your `PATH` (or set [`pike.languageServer.path`](#configuration)).
- **VS Code 1.85+**

**Install**

Get **[Pike Language Server](https://marketplace.visualstudio.com/items?itemName=thesmuks.pike-language-server)** from the Marketplace, or from the command line:

```bash
code --install-extension thesmuks.pike-language-server
```

Open any `.pike`, `.pmod`, or `.mmod` file and the server starts automatically. The status bar item (bottom-right) shows its state — click it to open the output channel.

## Features

A comprehensive LSP feature set, all backed by real compiler information:

**Diagnostics**
- Live compilation errors and warnings straight from `pike`, debounced while you type
- Three modes: `realtime`, `saveOnly`, or `off`, with version-gated supersession and cross-file propagation

**Navigation**
- Go-to-definition and find-references, workspace-wide and across `inherit`/`import` chains
- Go-to-implementation for inherited symbols
- Document & workspace symbols, document highlights, folding ranges
- Call hierarchy and type hierarchy

**Completion**
- Scope-aware local completions with priority ranking
- Member completion through multi-level inheritance, for both `->` and `.` access with type inference
- Chained-call resolution (`getContainer()->getItem()->…`)
- **5,500+ stdlib symbols** (Stdio, Gtk2, Sql, Protocols, …) and **283 predef builtins**, with auto-import suggestions
- Snippet completions with parameter placeholders and commit characters

**Refactoring & editing**
- Scope-aware, cross-file, type-aware **rename**
- **Code actions** — remove unused variable, add missing import, generate getters/setters, generate AutoDoc
- **Signature help** with active-parameter tracking
- **Formatting** — full-document and on-type, with optional operator spacing
- **Code lenses** (reference counts), **document links** (`#include` paths), **inlay hints** (inferred types)

**Information**
- **Hover** — types, AutoDoc, stdlib signatures, cross-file resolution
- **Semantic tokens** for precise highlighting
- Smart, scope-aware selection ranges

## Configuration

Configure under **Settings → Extensions → Pike Language Server**, or in `settings.json`. The most common settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `pike.languageServer.path` | `"pike"` | Path to the Pike binary. Must be Pike 8.0 or newer. |
| `pike.languageServer.pikeHome` | `""` | Pike installation root (e.g. `/usr/local/pike/8.0.1116`). Overrides auto-detection when set. |
| `pike.languageServer.modulePaths` | `[]` | Additional module search paths (`-M`). |
| `pike.languageServer.includePaths` | `[]` | Additional include search paths (`-I`). |
| `pike.languageServer.diagnosticMode` | `"realtime"` | When to report diagnostics: `realtime`, `saveOnly`, or `off`. |
| `pike.languageServer.diagnosticDebounceMs` | `500` | Debounce for realtime diagnostics, in ms (100–5000). |
| `pike.languageServer.maxNumberOfProblems` | `100` | Max diagnostics reported per file (1–1000). |
| `pike.languageServer.indexing.mode` | `"openFiles"` | Startup indexing: `openFiles` (fastest start), `full` (immediate global features), or `auto`. |
| `pike.languageServer.format.operatorSpacing` | `false` | Add spaces around operators when formatting. |
| `pike.languageServer.memory.budgetMb` | `512` | Heap budget (MB) before the server sheds non-essential index entries. |
| `pike.languageServer.trace.server` | `"off"` | LSP protocol tracing (`off`/`messages`/`verbose`) for debugging. |

There are 25+ settings in total — including worker lifecycle, background indexing, and hibernation tuning — all discoverable in the Settings UI.

## Troubleshooting

**Server won't start**
1. Click the status bar item to open **Output → Pike Language Server**.
2. Confirm `pike --version` works in your terminal and reports 8.0 or newer.
3. Check that `pike.languageServer.path` points to a working Pike binary.

**Diagnostics not appearing** — ensure `pike.languageServer.diagnosticMode` is `realtime` or `saveOnly`.

**Status bar shows a warning icon** — click it to inspect the error. Common causes: Pike not found, version too old, or file permissions.

For deeper diagnosis, set `pike.languageServer.trace.server` to `verbose` and check the output channel.

## Architecture

A **Tier-3 LSP**: `pike` is the semantic oracle and [tree-sitter-pike](https://github.com/TheSmuks/tree-sitter-pike) is the syntactic parser. The server is TypeScript (`vscode-languageserver-node`) split into 60+ focused modules, following a strict style budget (500-line files, 50-line functions, explicit error handling, bounded caches).

Correctness is anchored to the compiler: the test suite derives every expected result from `pike` itself — no hand-written expectations — across ~490 Pike (PUnit) tests, a 90-file language corpus, and TypeScript LSP integration tests.

See **[docs/architecture.md](./docs/architecture.md)** for the full design and **[docs/decisions/](./docs/decisions/)** for the decision records.

## Contributing

Contributions are welcome. Quick start:

```bash
bun install          # install dependencies
bun run build        # build server + client
bun run test:all     # TypeScript + Pike test suites
bun run typecheck    # type-check
bun run fmt:check    # formatting check
```

See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for guidelines and **[docs/ci.md](./docs/ci.md)** for the CI pipeline.

## Links

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=thesmuks.pike-language-server)
- [Changelog](./CHANGELOG.md) · [License (MIT)](./LICENSE)
- [Pike language](https://pike.lysator.liu.se/) · [tree-sitter-pike](https://github.com/TheSmuks/tree-sitter-pike)
