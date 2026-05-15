# Wiki Index

> Content catalog. Every wiki page listed under its type with a one-line summary.
> Read this first to find relevant pages for any query.
> Last updated: 2026-05-15 | Total pages: 17

## Entities

- [[pike]] -- The Pike programming language: dynamic, interpreted, v8.0+
- [[tree-sitter-pike]] -- Tree-sitter grammar for Pike, v1.2.2, C++ WASM parser
- [[pike-ai-kb]] -- pike-ai-kb MCP server: 7 runtime tools, the LSP's oracle interface
- [[vscode]] -- VSCode as primary LSP client, extension host, Remote-SSH
- [[other-editors]] -- Neovim, Helix, and generic LSP client setup guides

## Concepts

- [[architecture-audit]] -- First and second pass audit findings with severity ratings and fix status
- [[background-indexing]] -- Startup workspace indexing strategy: Bun Glob, yield-based, workDoneProgress
- [[ci-architecture]] -- GitHub Actions CI: 5 workflow files, caching, parallelization
- [[deployment-context]] -- SSH shared server constraints: CPU, memory, inotify, zombie subprocesses
- [[known-limitations]] -- Comprehensive catalog of current and resolved limitations by phase
- [[pike-worker]] -- Pike subprocess manager: idle eviction, caching, zombie prevention
- [[semantic-tokens]] -- DeclKind-to-TokenType mappings (11 types, 5 modifiers)
- [[signature-help]] -- Parameter hints: call detection, callee resolution, comma counting
- [[tier-3-lsp]] -- Three-source resolution boundary: tree-sitter + Pike oracle + pre-built indices
- [[two-speed-diagnostics]] -- Fast tree-sitter lint (<5ms) + slow Pike compilation (~500ms)
- [[type-inference]] -- 5-layer inference: return tracking, assignment narrowing, typeof, depth limits

## Comparisons

- [[lsp-approaches]] -- How gopls, rust-analyzer, clangd, tsserver solve hard LSP problems

## Queries

