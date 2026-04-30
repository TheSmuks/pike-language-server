# 0020: Semantic Token Type and Modifier Mapping

**Status**: Accepted
**Date**: 2026-04-30
**Decision Maker**: LSP team

## Context

The LSP 3.16+ specification introduces semantic tokens — a way for language servers to communicate syntax highlighting information that goes beyond what TextMate grammars can provide. The server needs a defined mapping from Pike's declaration types (`DeclKind`) to LSP `SemanticTokenTypes` and `SemanticTokenModifiers`.

Pike's `DeclKind` values are:
- `function`, `class`, `variable`, `constant`, `enum`, `enum_member`
- `typedef`, `parameter`, `inherit`, `import`

The LSP spec defines standard token types (`class`, `enum`, `function`, `variable`, etc.) and modifiers (`declaration`, `definition`, `readonly`, `static`, `deprecated`, etc.).

## Decision

### Token Type Mapping

| DeclKind | LSP TokenType | Index | Rationale |
|----------|---------------|-------|-----------|
| `class` | `class` | 0 | Direct match |
| `enum` | `enum` | 1 | Direct match |
| `enum_member` | `enumMember` | 2 | Direct match |
| `function` | `function` | 3 | Top-level and nested functions |
| `function` (in class) | `method` | 4 | Promoted based on scope context |
| `variable` | `variable` | 5 | Local and top-level variables |
| `constant` | `variable` + `readonly` | 5 | Constants are read-only variables |
| `parameter` | `parameter` | 6 | Direct match |
| `typedef` | `type` | 7 | Type alias declarations |
| `inherit` | `namespace` | 8 | Inheritance brings in a namespace |
| `import` | `namespace` | 8 | Import brings in a namespace |

### Token Modifier Mapping

| Modifier | Bit | Applied When |
|----------|-----|--------------|
| `declaration` | 0 | All symbol table declarations |
| `definition` | 1 | All symbol table declarations (Pike conflates declaration and definition) |
| `readonly` | 2 | `constant` declarations |
| `static` | 3 | Declarations inside a class scope |
| `deprecated` | 4 | Marked `@deprecated` in AutoDoc |

### Method vs Function

Pike does not syntactically distinguish methods from functions — a method is simply a function declared inside a class body. The token producer (US-013) must check the scope context to decide whether a `function` declaration should be emitted as `method` (index 4) or `function` (index 3).

**MUST**:
- Token type and modifier indices follow LSP spec (legend ordering)
- The legend order MUST NOT change after client initialization without capability renegotiation
- `method` type is only used for `function` declarations inside a class scope

**SHOULD**:
- `deprecated` modifier should be populated from AutoDoc XML when available
- `static` modifier should distinguish class-level from instance declarations

**MAY**:
- Future iterations may add additional modifiers (`abstract`, `async`, etc.)
- Future iterations may add `namespace` declarations for Pike modules

## Consequences

### Positive

- Standard LSP token types ensure compatibility with all LSP clients
- Simple mapping — one DeclKind to one token type (except function/method scope distinction)
- Modifier bitmask is extensible — new modifiers can be added without breaking existing clients

### Negative

- Function/method distinction requires scope context — adds complexity to the token producer
- `namespace` is a slight semantic mismatch for `inherit` and `import` — but the LSP has no better fit
- Constants share the `variable` type — clients must check the `readonly` modifier to distinguish

### Neutral

- The legend is a wire contract — indices must remain stable once published
- Token production (US-013) and handler registration (US-014) are separate stories

## Alternatives Considered

### Custom token types

Using custom token types (e.g., `pike:inherit`, `pike:import`) would be more semantically precise but reduces client compatibility. Standard types with modifiers provide better out-of-the-box highlighting.

### Separate type for constants

Using a dedicated `constant` token type was considered. However, the LSP standard `variable` type with the `readonly` modifier is the convention used by TypeScript, Python, and other LSP servers.

### No method distinction

Treating all functions as `function` regardless of scope was considered. However, most editors apply different highlighting for methods vs standalone functions, and the distinction is valuable for readability.
