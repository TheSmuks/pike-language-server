<div align="center">

# Pike Language Server

**Full-featured language support for [Pike](https://pike.lysator.liu.se/) in Visual Studio Code.**

[![version](https://img.shields.io/endpoint?url=https%3A%2F%2Fmarketplace.visualstudio.com%2F_items%2FitemName%2Fthesmuks.pike-language-server%3Faction%3Dversions)](https://marketplace.visualstudio.com/items?itemName=thesmuks.pike-language-server) <!-- template-v0.8.8 -->
[![license](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/TheSmuks/pike-language-server/blob/main/LICENSE)

| [Installation](#installation) · [Features](#features) · [Configuration](#configuration) · [Architecture](#architecture) · [Testing](#testing) · [Contributing](./CONTRIBUTING.md)

</div>

---

## Installation

### Prerequisites

- **Pike 8.0+** — Download from [pike.lysator.liu.se](https://pike.lysator.liu.se/) and ensure `pike` is on your `PATH`
- **VS Code 1.85+**

### Install the Extension

Install **Pike Language Server** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=thesmuks.pike-language-server). The extension bundles and manages the LSP server automatically — no separate installation needed.

Open any `.pike`, `.pmod`, or `.mmod` file and the server starts immediately. The status bar item (bottom-right) shows the server state.

---

## Features

The server implements **23 LSP providers** covering diagnostics, navigation, editing, and rich language features:

### Diagnostics

- Real-time compilation errors and warnings from `pike` (debounced)
- Three modes: `realtime`, `saveOnly`, or `off`
- Pull diagnostics support

### Navigation

| Feature | Description |
|---------|-------------|
| Go-to-definition | Same-file scope resolution, cross-file via inherit/import chains |
| Find references | Workspace-wide, including cross-file references |
| Implementation | Jump to concrete implementations for inherited symbols |
| Document symbols | Classes, functions, variables, enums, constants |
| Workspace symbols | Cross-file search with prefix matching |
| Document highlights | Read/write highlighting for references under cursor |
| Folding ranges | Blocks, classes, comment groups |

### Completion

- Local scope completions with priority ranking
- Class member completions across multi-level inheritance chains
- **5,500+ stdlib symbols** (Stdio, Gtk2, Sql, Protocols, etc.)
- **283 predef builtins** (`write`, `werror`, `foreach`, etc.)
- Arrow (`->`) and dot (`.`) member access with type inference
- Auto-import suggestions for stdlib symbols
- Chained call resolution (`getContainer()->getItem()->`)
- Commit characters for functions (`(`) and classes (`.`, `(`)
- Snippet completions with parameter placeholders

### Editing

- **Rename** — workspace-wide, scope-aware, cross-file, type-aware receiver filtering
- **Code actions** — remove unused variable, add missing import, generate getters/setters, generate AutoDoc
- **Signature help** — parameter hints with active parameter tracking
- **Formatting** — indentation normalization via on-type and full-document formatting
- **Code lenses** — reference counts on declarations
- **Document links** — clickable `#include` paths
- **Inlay hints** — inferred types on untyped variables

### Rich Information

- **Hover** — type info, AutoDoc documentation, stdlib signatures, cross-file resolution
- **Call hierarchy** — incoming/outgoing call hierarchy for functions and methods
- **Semantic tokens** — syntax highlighting with 9 token types + 5 modifiers
- **Selection ranges** — smart scope-aware selection expansion

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

## Architecture

A **Tier-3 LSP** implementation — uses `pike` as oracle for semantic information and [tree-sitter-pike](https://github.com/TheSmuks/tree-sitter-pike) as syntactic parser.

```
pike-language-server/
├── server/src/           # LSP server (TypeScript, vscode-languageserver-node)
│   ├── server.ts         # Entry point — creates the LSP connection
│   ├── serverCapabilities.ts
│   ├── serverLifecycle.ts
│   └── features/         # 60+ focused modules, all under 500 lines
│       ├── pikeWorker.ts         # Pike subprocess management
│       ├── workspaceIndex.ts     # Per-file symbol table index
│       ├── completion*.ts        # Completion engine (9 modules)
│       ├── navigation*.ts        # Navigation handlers (7 modules)
│       ├── symbolTable.ts        # Symbol table construction
│       ├── typeResolver.ts       # Type inference and resolution
│       ├── hoverHandler.ts       # Hover provider
│       └── ...
├── client/               # VSCode extension hosting the LSP server
├── harness/              # Test harness — invokes pike, captures ground truth
├── corpus/               # 85 Pike files covering language features
├── tests/                # Test suites
│   ├── pike/            # PUnit tests — Pike-language test suite (487 tests)
│   ├── lsp/             # In-process LSP integration tests
│   └── perf/            # Performance benchmarks
└── docs/                 # Architecture, decisions, known limitations
    └── decisions/        # Architecture Decision Records
```

### Design Principles

- **Pike is the oracle.** Every test derives expected output from `pike` — no hand-written expectations.
- **Fail-fast.** Runtime JSON validation on all Pike subprocess responses. Assertions at boundaries.
- **Bounded by default.** LRU caches with caps, bounded queues, no unbounded growth.
- **TigerStyle code.** 500-line file limit, 50-line function limit, explicit error handling throughout.

See [docs/architecture.md](./docs/architecture.md) for the full system design and [docs/decisions/](./docs/decisions/) for architecture decision records.

---

## Testing

The project has two test layers:

### TypeScript Tests (bun test)

```bash
bun test                        # Run all TS tests (harness + perf)
bun test tests/lsp/             # LSP integration tests only
bun run test:harness            # Harness tests only
```

### Pike Tests (PUnit)

The Pike test suite uses [PUnit](./modules/PUnit.pmod/) and covers language analysis, LSP protocol handling, and server behavior via Pike's own `compile_string` introspection.

```bash
bun run test:pike               # Run all Pike tests (487 tests)
bash scripts/test-pike.sh       # Run directly
bun run test:all                # Run TS + Pike tests together
```

**Test directory structure:**

```
tests/pike/
├── run_tests.pike              # PUnit test runner entry point
├── PUnitSmokeTests.pike        # Framework smoke tests (13)
├── DefinitionTests.pike        # Go-to-definition via Program.defined (18)
├── DiagnosticsTests.pike       # Diagnostic normalization (18)
├── CompilationHandlerTests.pike # Compilation handler (13)
├── VersionTests.pike           # Pike version detection (5)
├── IncrementalSyncTests.pike   # Edit-compile cycle simulation (10)
├── StateConsistencyTests.pike  # Isolation and determinism (18)
├── CompletionTests.pike        # Completion context tests (16)
├── HoverTests.pike             # Hover/type inference tests (20)
├── LintRulesTests.pike         # Static lint rule detection (23)
├── SignatureTests.pike         # Function signature parsing (25)
├── SymbolTableTests.pike       # Symbol extraction tests (23)
├── JsonRpcProtocolTests.pike   # JSON-RPC 2.0 protocol (46)
├── LspLifecycleTests.pike      # LSP initialize/shutdown lifecycle (33)
├── LspDocumentTests.pike       # textDocument/didOpen/Change/Close/Save (50)
├── WorkerProtocolTests.pike    # Worker IPC protocol (57)
├── ProtocolEdgeCaseTests.pike  # Edge cases: malformed JSON, boundary values (101)
├── LspProtocol.pmod            # Shared protocol builder/validator helpers
└── TestBootstrap.pmod          # Test bootstrap utilities
```

### Adding New Pike Tests

1. Create a new `.pike` file in `tests/pike/`:

```pike
//! MyTests.pike — Description of what these tests cover
import PUnit;

void test_my_feature() {
  assert_equal(1 + 1, 2);
}
```

2. Import shared helpers as needed:
   - `import Common;` — for `DiagnosticHandler`, `get_pike_version`, `normalize_diagnostics`
   - `import LspProtocol;` — for JSON-RPC/LSP message builders and validators

3. Run your test file:

```bash
bash scripts/test-pike.sh tests/pike/MyTests.pike
```

The PUnit runner auto-discovers all `test_*` functions in each file. No registration needed.

---

## Development

```bash
bun install                  # Install dependencies
bun run build                # Build server + client
bun test                     # Run default test suite (harness + perf)
bun test tests/lsp/          # Run LSP integration tests
bun run test:all             # Run TS + Pike tests together
bun run typecheck            # Type-check the project
bun run fmt:check            # Check formatting
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for contribution guidelines and [docs/ci.md](./docs/ci.md) for the CI pipeline.

---

## Troubleshooting

### Server won't start

1. Open **Output → Pike Language Server** (click the status bar item)
2. Verify `pike --version` works from your terminal
3. Check `pike.languageServer.path` points to a working Pike binary

### Diagnostics not appearing

Ensure `pike.languageServer.diagnosticMode` is set to `realtime` or `saveOnly`.

### Status bar shows warning icon

Click the status bar item to open the output channel and inspect the error. Common causes: Pike binary not found, version too old, or file permissions.

---

## Links

- [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=thesmuks.pike-language-server)
- [Source repository](https://github.com/TheSmuks/pike-language-server)
- [Changelog](./CHANGELOG.md)
- [License](./LICENSE) (MIT)
- [Pike language](https://pike.lysator.liu.se/)
- [tree-sitter-pike](https://github.com/TheSmuks/tree-sitter-pike)
