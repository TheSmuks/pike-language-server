---
title: Pike
created: 2026-05-15
updated: 2026-05-15
type: entity
tags:
  - pike
  - language
sources:
  - raw/articles/pike-interface.md
  - raw/articles/existing-tooling.md
---

# Pike

Pike is a dynamic, interpreted programming language used primarily for web applications and system scripting. The language is actively maintained at version 8.0+.

## Key Characteristics

- **Dynamic and interpreted**: Pike code is evaluated at runtime with no separate compilation step for normal usage.
- **Strongly typed at runtime**: Types are checked during execution; the `typeof` function provides limited type introspection.
- **C-like syntax**: Familiar brace-delimited blocks, preprocessor directives, and module system.

## Relevance to the LSP

The Pike language presents several challenges and constraints for language server development:

- **No structured output**: Pike does not natively produce machine-parseable diagnostics or AST output in a structured format (e.g., JSON).
- **CompilationHandler**: Used to capture JSON-formatted diagnostics from the Pike compiler, serving as the primary bridge for error reporting in the LSP.
- **`pike -x` tools**: Pike ships with a set of built-in tools accessible via `pike -x <tool>`, which provide limited introspection and utility capabilities.
- **Limited type introspection**: The `typeof` construct is the main mechanism for runtime type queries, offering no deep static analysis capabilities.

## Relationships

- [[pike-ai-kb]] -- MCP server that queries Pike at runtime for symbol and module information.
- [[tree-sitter-pike]] -- Tree-sitter grammar providing fast syntactic parsing of Pike source files.
- [[tier-3-lsp]] -- The tier-3 scope classification under which the Pike LSP operates.
- [[two-speed-diagnostics]] -- Fast lint layer that Pike enables via CompilationHandler.
