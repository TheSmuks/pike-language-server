# Decision 0006: LSP Server Architecture

**Date:** 2026-04-27
**Status:** Accepted
**Context:** Phase 2 — VSCode extension + LSP server with tree-sitter-based documentSymbol

## Decision

Phase 2 adds a VSCode extension and an LSP server that uses tree-sitter (WASM) to parse Pike source files and provide `textDocument/documentSymbol`. The extension and server live in a single package, communicate over stdio, and follow a strict parse-error-recovery policy.

## Extension Layout

Single-package monorepo. No workspace, no Lerna, no separate npm packages.

```
pike-language-server/
  client/
    extension.ts          # VSCode extension entry: activate, deactivate
  server/
    src/
      server.ts           # Main entry: create connection, register handlers
      parser.ts           # Tree-sitter init, parse cache, error recovery
      features/
        documentSymbol.ts # Tree-walk from root, extract declarations
        diagnostics.ts    # Report parse errors from ERROR nodes
  syntaxes/               # TextMate grammar (Phase 3+)
  package.json            # Extension manifest + dependencies
```

Bundled with esbuild into two outputs:
- `dist/client.js` — extension host bundle
- `dist/server.js` — LSP server bundle

The WASM grammar file (`tree-sitter-pike.wasm`, 290KB) is bundled alongside `dist/server.js` and loaded at server startup.

## Transport

**Stdio.** The extension spawns the server as a child process. JSON-RPC over stdin/stdout.

Reason: simplest, most portable, well-supported by `vscode-languageclient`. No socket management, no port conflicts, no HTTP overhead. Every VSCode extension that embeds an LSP server uses this pattern.

## Tree-sitter Integration

**WASM via web-tree-sitter@0.26.8.**

The tree-sitter grammar is loaded from a bundled `tree-sitter-pike.wasm` file (built from the `tree-sitter-pike` project). No native compilation required — works on all platforms (x64, ARM, macOS, Linux, Windows).

```typescript
import Parser from "web-tree-sitter";

await Parser.init();
const parser = new Parser();
const lang = await Parser.Language.load(pathToWasm);
parser.setLanguage(lang);
const tree = parser.parse(source);
```

Reason: the WASM binary is 290KB (negligible), init is ~50ms, grammar load is ~100ms. No node-gyp, no platform-specific builds, no native module headaches.

## Server Architecture

### `server/src/server.ts` — Main Entry

- Creates a stdio connection via `vscode-languageserver`
- Registers feature handlers: `documentSymbol`, `diagnostics`
- Manages document sync (full text on open/change/close)
- Initializes tree-sitter parser on startup
- Sends `initialize` response with server capabilities

### `server/src/parser.ts` — Tree-sitter Initialization and Parse Cache

Responsibilities:
1. Load the WASM grammar once at startup
2. Parse documents on demand, returning a tree-sitter `Tree`
3. Cache parsed trees keyed by `documentUri + version`
4. On `textDocument/didChange`, invalidate cache and re-parse
5. On `textDocument/didClose`, evict cache entry

The parser never throws on malformed input. Tree-sitter always produces a tree — ERROR nodes mark regions where parsing failed. The parser returns the tree regardless.

### `server/src/features/documentSymbol.ts` — Document Symbol Provider

Walks the tree-sitter tree from root, extracts declarations, maps node types to `SymbolKind` values:

| Tree-sitter node type      | LSP SymbolKind   | Notes                                    |
|----------------------------|------------------|------------------------------------------|
| `class_decl`               | Class            | Children: nested declarations            |
| `function_decl`            | Function         |                                          |
| `local_function_decl`      | Function         |                                          |
| `variable_decl`            | Variable         |                                          |
| `local_declaration`        | Variable         |                                          |
| `constant_decl`            | Constant         |                                          |
| `enum_decl`                | Enum             | Children: `enum_member` → EnumMember     |
| `typedef_decl`             | TypeParameter    |                                          |
| `import_decl`              | Module           |                                          |
| `inherit_decl`             | Module           |                                          |
| `lambda_expr`              | Function         | No name → skip for documentSymbol        |
| `anon_class`               | Class            | No name → skip                           |
| `anon_enum`                | Enum             | No name → skip                           |

Anonymous constructs (lambda, anon_class, anon_enum) have no stable name and are excluded from documentSymbol results. They may be represented in future features (semantic tokens, folding range) where position alone suffices.

The walk is recursive: class bodies contain function declarations, variable declarations, nested classes, etc. Each child symbol's range is contained within its parent's range.

### `server/src/features/diagnostics.ts` — Diagnostics Provider

Scans the tree for ERROR nodes. For each ERROR node:
- Emit a `Diagnostic` with severity `Error`
- Range covers the ERROR node's span
- Message: `"Parse error"` (tree-sitter does not provide detailed error messages)

Diagnostics are pushed on `textDocument/didChange` and `textDocument/didOpen`.

## Parse-Error Policy

On tree-sitter ERROR nodes:
1. **Return partial documentSymbol results.** All successfully parsed sibling declarations are included. Only the ERROR subtree is excluded.
2. **Surface a diagnostic** at the ERROR node's location.
3. **Never crash.** The server must remain responsive even if the entire file is unparseable (in which case, return an empty symbol list and a single diagnostic at line 0).

Error recovery strategy: tree-sitter guarantees a tree for any input. ERROR nodes are part of the tree. The documentSymbol walker skips ERROR subtrees but processes their siblings. This means a syntax error in one function does not prevent symbol extraction from other functions in the same file.

## Performance Targets

| Metric                         | Target     |
|--------------------------------|------------|
| Server cold start              | < 2s       |
| Tree-sitter WASM init          | ~50ms      |
| Grammar load                   | ~100ms     |
| Warm parse (per file)          | < 200ms    |
| Parse cache                    | Keyed by URI + version |

The parse cache prevents re-parsing unchanged documents. On `didChange`, only the changed document is re-parsed. The cache is bounded to open documents — `didClose` evicts the entry.

## Canary Lesson from Phase 1

Every code path must have a canary with non-trivial real input. For documentSymbol, this means at least one canary that produces a multi-level symbol tree with children (e.g., a class containing functions and variables, an enum with members). Single-level flat symbol lists are insufficient — they do not exercise the recursive walk or parent-child range containment.

## Consequences

- The server is a single-process, single-threaded Node.js program. Concurrency is not a concern — LSP handles one request at a time per document.
- The WASM grammar is bundled with the extension. Grammar updates require an extension release.
- `web-tree-sitter` is the only non-trivial dependency. The LSP protocol libraries (`vscode-languageserver`, `vscode-languageclient`) are thin wrappers over JSON-RPC.
- Phase 2 scope is limited to `documentSymbol` and `diagnostics`. Additional features (completion, hover, go-to-definition) are Phase 3+.
- The parse-error policy means users always get partial results, even in files with syntax errors. This matches the behavior of mature LSP servers (tsserver, rust-analyzer).
