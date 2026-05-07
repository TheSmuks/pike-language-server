# Pike Language Server

**Visual Studio Code extension for Pike programming language support.**

[![version](https://img.shields.io/endpoint?url=https%3A%2F%2Fmarketplace.visualstudio.com%2F_items%2FitemName%2Fthesmuks.pike-language-server%3Faction%3Dversions)](https://marketplace.visualstudio.com/items?itemName=thesmuks.pike-language-server)
[![template](https://img.shields.io/badge/template-v0.3.7-beta-green)](https://github.com/TheSmuks/ai-project-template)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/TheSmuks/pike-language-server/blob/main/LICENSE)

Language support for Pike — diagnostics, completion, go-to-definition, hover, references, rename, formatting, and more. Works with Pike 8.0 and newer.

---

## Getting Started

### 1. Install Pike

Download and install Pike 8.0 or newer from [pike.lysator.liu.se](https://pike.lysator.liu.se/).

Ensure `pike` is on your `PATH`:

```bash
pike --version  # should print Pike 8.0 or higher
```

### 2. Install the Extension

Install the **Pike Language Server** extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=thesmuks.pike-language-server).

The extension bundles and manages the LSP server automatically — no separate server installation needed.

### 3. Open a Pike File

Open any `.pike`, `.pmod`, or `.mmod` file in VS Code. The extension activates automatically.

The status bar item (bottom-right) shows the server state: spinning while starting, zap icon while running, warning on error.

---

## Features

### Diagnostics
- Real-time compilation errors and warnings as you type (debounced)
- Three modes: realtime, save-only, or off

### Navigation
- **Go-to-definition** — same-file scope resolution, cross-file via inherit/import
- **Find references** — workspace-wide, including cross-file
- **Document symbols** — classes, functions, variables, enums

### Completion
- Local scope completions
- Class member completions (including inherited members across multi-level inheritance chains)
- stdlib symbol completions (5,500+ symbols: Stdio, Gtk2, Sql, etc.)
- Predef builtin completions (283 symbols: `write`, `werror`, `foreach`, etc.)
- Arrow (`->`) and dot (`.`) member access completions with type inference

### Editing
- **Rename** — workspace-wide, scope-aware, cross-file, type-aware receiver filtering
- **Code actions** — remove unused variable, add missing import
- **Signature help** — parameter hints with active parameter tracking
  - **Formatting** — indentation normalization

### Additional Features
- **Hover** — type info, AutoDoc documentation, stdlib signatures
- **Workspace symbols** — cross-file search with prefix matching
- **Document highlights** — read/write highlighting for references
- **Folding ranges** — blocks, classes, comment groups
- **Semantic tokens** — syntax highlighting with 9 token types + 5 modifiers

---

## Configuration

Settings are available under **Extensions → Pike Language Server** in VS Code Settings, or directly in `settings.json`:

| Setting | Default | Description |
|---------|---------|-------------|
| `pike.languageServer.path` | `pike` | Path to the Pike binary. Must be Pike 8.0 or newer. |
| `pike.languageServer.diagnosticMode` | `realtime` | When to report diagnostics: `realtime`, `saveOnly`, or `off` |
| `pike.languageServer.diagnosticDebounceMs` | `500` | Debounce interval (ms) for realtime diagnostics. Range: 100–5000. |
| `pike.languageServer.maxNumberOfProblems` | `100` | Maximum diagnostic problems reported per file. Range: 1–1000. |

---

## Requirements

fz|- **Pike** 8.0 or newer (must be on `PATH`)
- **VS Code** 1.85.0 or later

---

## Troubleshooting

### Server won't start

1. Open the **Output → Pike Language Server** channel (click the status bar item)
2. Check that `pike --version` works from your terminal
3. Verify `pike.languageServer.path` points to a working Pike binary

### Diagnostics not appearing

Ensure `pike.languageServer.diagnosticMode` is set to `realtime` or `saveOnly`.

### Status bar shows warning icon

Click the status bar item to open the output channel and inspect the error. Common causes: Pike binary not found, version too old, or file permissions.

---

## Links

- [Marketplace](https://marketplace.visualstudio.com/items?itemName=thesmuks.pike-language-server)
- [Source repository](https://github.com/TheSmuks/pike-language-server)
- [Changelog](./CHANGELOG.md)
- [License](./LICENSE)
