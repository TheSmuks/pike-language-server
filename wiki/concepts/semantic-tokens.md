---
title: Semantic Tokens
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - semantic-tokens
  - adr
sources:
  - raw/articles/decisions-0020-semantic-tokens.md
---

# Semantic Tokens

Semantic tokens provide syntax highlighting information beyond what TextMate
grammars can offer. The LSP 3.16+ specification allows the server to communicate
token types and modifiers for precise editor coloring. The Pike Language Server
maps its internal `DeclKind` values to standard LSP token types.

## Token Type Mapping (11 Entries)

| DeclKind | LSP TokenType | Index | Rationale |
|----------|---------------|-------|-----------|
| `class` | `class` | 0 | Direct match |
| `enum` | `enum` | 1 | Direct match |
| `enum_member` | `enumMember` | 2 | Direct match |
| `function` (top-level) | `function` | 3 | Standalone functions |
| `function` (in class) | `method` | 4 | Promoted based on scope context |
| `variable` | `variable` | 5 | Local and top-level variables |
| `constant` | `variable` + `readonly` | 5 | Constants are read-only variables |
| `parameter` | `parameter` | 6 | Direct match |
| `typedef` | `type` | 7 | Type alias declarations |
| `inherit` | `namespace` | 8 | Inheritance brings in a namespace |
| `import` | `namespace` | 8 | Import brings in a namespace |

Note: `function` maps to either `function` (index 3) or `method` (index 4)
depending on scope context. This is the only DeclKind with a dual mapping.

## Token Modifier Mapping (5 Modifiers)

| Modifier | Bit | Applied When |
|----------|-----|--------------|
| `declaration` | 0 | All symbol table declarations |
| `definition` | 1 | All symbol table declarations (Pike conflates declaration and definition) |
| `readonly` | 2 | `constant` declarations |
| `static` | 3 | Declarations inside a class scope |
| `deprecated` | 4 | Marked `@deprecated` in AutoDoc |

## Method vs Function Distinction

Pike does not syntactically distinguish methods from functions — a method is
simply a function declared inside a class body. The token producer must check
the **scope context** to decide whether a `function` declaration should be
emitted as `method` (index 4) or `function` (index 3).

This distinction matters because most editors apply different highlighting for
methods vs standalone functions, and the visual separation aids readability.

## Wire Contract

The legend order (token type indices and modifier bits) is a wire contract.
Once published during client initialization, the indices **must not change**
without capability renegotiation. Adding new types or modifiers appends to the
end of the legend; existing indices remain stable.

## Design Choices

- **Standard LSP types** over custom types (`pike:inherit`) — ensures
  compatibility with all LSP clients out of the box.
- **`variable` + `readonly`** for constants instead of a dedicated `constant`
  type — follows the convention used by TypeScript, Python, and other LSP
  servers.
- **`namespace`** for `inherit`/`import` — slight semantic mismatch but the
  LSP spec has no better fit for these concepts.

## Related

- [[tier-3-lsp]] — semantic tokens are capability #8 in scope
- [[pike-ai-kb]] — AutoDoc data populates the `deprecated` modifier
- [[tree-sitter-pike]] — DeclKind values come from the tree-sitter grammar parse output
- [[known-limitations]] — only class-scope symbols get tokens; block-scope not yet supported
