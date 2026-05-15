---
source_url: docs/architecture.md
ingested: 2026-05-15
sha256: 9251aacc646d0b06592bc7cfce90f1022d7d0f6c4cafa3b10f85549685aacfb4
---

# Architecture

> This document describes the system design and component structure. Keep it updated as the project evolves.

## Overview

Pike Language Server is a tier-3 LSP implementation for the Pike programming language. It uses tree-sitter-pike as its syntactic parser and invokes the Pike compiler (`pike`) as an oracle for semantic information — diagnostics, types, and symbol resolution.

## System Diagram

```mermaid
graph TD
    VSCode[VSCode Extension] -->|LSP Protocol| Server[LSP Server]
    Server -->|Parse| TS[tree-sitter-pike]
    Server -->|Fast Lint| LintLayer[Lint Layer]
    LintLayer -->|structural checks| TS
    Server -->|Diagnostics/Types/Symbols| Oracle[Pike Oracle]
    Oracle -->|via MCP| KB[pike-ai-kb]
    Oracle -->|direct invocation| Pike[pike binary]
    Server -->|Completion| Completion[Completion Engine]
    Completion -->|type inference| TypeResolver[Type Resolver]
    Completion -->|stdlib index| AutoImport[Auto-Import]
    Server -->|Code Actions| CodeAction[Code Actions]
    CodeAction -->|arity fix| ArityFix[H2 Arity Quick-Fix]
    CodeAction -->|template| Autodoc[AU1 Autodoc //!!]
    CodeAction -->|accessors| GetterSetter[GS1 Getters/Setters]
    Server -->|Inlay Hints| InlayHints[Inlay Hints]
    InlayHints -->|type hints| TypeResolver
    InlayHints -->|param labels| TypeResolver
    Server -->|Signature Help| SigHelp[Signature Help]
    SigHelp -->|constructor| TypeResolver
    SigHelp -->|method resolution| TypeResolver
    Server -->|Test| Harness[Test Harness]
    Harness -->|Ground Truth| Pike
    Harness -->|Compare| Server
```

## Project Structure

```
server/           # LSP server (TypeScript, vscode-languageserver-node)
client/          # VSCode extension that hosts the LSP server
harness/          # Test harness — invokes pike, captures ground truth, compares LSP output
corpus/           # Pike files covering language features the LSP must handle
  files/          # Actual Pike source files
  manifest.md     # Inventory of files and what features each exercises
docs/             # Investigation results, interface documentation
  decisions/      # Architecture Decision Records
decisions/        # Root-level decision documents (template convention)
```

## Core Components

### LSP Server (`server/`)

TypeScript application using `vscode-languageserver-node`. Handles LSP protocol, manages document state, coordinates between tree-sitter parsing and pike oracle queries.

### VSCode Extension (`client/`)

Hosts the LSP server as a subprocess. Registers Pike as a language for `.pike`, `.pmod`, `.mmod` files. Provides configuration UI.

### Test Harness (`harness/`)

Invokes `pike` on corpus files, captures output, produces structured ground-truth snapshots. Compares LSP output against ground truth. Includes canary tests for harness integrity.

### Corpus (`corpus/`)

Pike source files exercising the language features the LSP must handle: cross-module imports, inheritance, generic types, version compatibility, the full type system.

## Feature Modules

### Fast Lint Layer (`server/src/features/lintRules/`)

Tree-sitter-based lint rules running on every keystroke (<5ms). Detects structural issues: unused variables/parameters (P3001/P3002), unreachable code (P3003), missing return statements (P3004), unused imports (P3005). Lint diagnostics are suppressed on lines where the Pike compiler provides diagnostics — Pike is always authoritative.

### Completion Engine (`server/src/features/completion.ts`, `completionTrigger.ts`)

Multi-stage completion: (1) keyword, (2) scoped local symbols from symbol table, (3) dot/arrow member access with type resolution, (4) chained call type inference via `resolveChainedType`/`decomposePostfixChain`, (5) auto-import suggestions from stdlib reverse index. Commit characters (`.` and `(`) for immediate acceptance.

### Signature Help (`server/src/features/signatureHelp.ts`)

Type-aware: resolves `Dog("Rex",` to constructor `create()` params, and `d->bark("hi",` to method signature via type -> class -> method lookup. Active parameter tracking highlights which parameter the cursor is on.

### Inlay Hints (`server/src/features/inlayHints.ts`)

Two modes: (1) type hints for untyped variable declarations (G1), (2) parameter name labels at call sites with `comma_expr` unwrapping and method resolution (G2).

### Code Actions (`server/src/features/codeAction.ts`, `autodocTemplate.ts`, `getterSetter.ts`)

- **Arity quick-fix** (H2): Adds/removes argument slots for "Wrong number of arguments" diagnostics.
- **Autodoc template** (AU1): `//!!` trigger above a declaration generates a `//!` skeleton with `@param` and `@returns` sections.
- **Getters/setters** (GS1): Generates `get_x()` / `set_x(value)` methods for class member variables.

### Type Resolver (`server/src/features/typeResolver.ts`)

Centralized type inference: resolves member access (`obj.field`), arrow access (`obj->method`), chained calls, and constructor types. Uses symbol table scope lookup with range-overlap for class scope discovery.

### PikeWorker (`server/src/features/pikeWorker.ts`)

Manages the Pike compiler subprocess with priority queue, idle eviction, and SIGKILL escalation. Supports `warmUp()` for pre-warming during initialization.

## Two-Speed Diagnostics

The LSP uses a two-speed diagnostic architecture:

| Speed | Source | Latency | Trigger | Scope |
|-------|--------|---------|---------|-------|
| Fast | tree-sitter lint | <5ms | Every keystroke | Structural issues |
| Slow | Pike compiler | ~500ms | Debounced | Semantic issues |

Lint diagnostics are suppressed on lines where Pike provides diagnostics, preventing duplicate/conflicting messages.

## External Integrations

| Dependency | Purpose | Version |
|------------|---------|---------|
| [tree-sitter-pike](https://github.com/TheSmuks/tree-sitter-pike) | Syntactic parser (WASM) | v1.2.2 |
| [pike-ai-kb](https://github.com/TheSmuks/pike-ai-kb) | Pike semantics oracle (MCP tools) | latest |
| `pike` binary | Ground truth for diagnostics, types, symbols | 8.0+ |
| `vscode-languageserver-node` | LSP protocol implementation | latest |
| `stdlib-autodoc.json` | Stdlib API index for auto-import/signature help | bundled |

## Development Environment

- Node.js 22+
- bun package manager
- Pike 8.0+ on PATH
- VS Code 1.85+ for extension development
