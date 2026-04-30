# 0021: Signature Help

**Status**: Accepted
**Date**: 2026-04-30
**Decision Maker**: LSP team

## Context

LSP clients provide parameter hints when a user types `(` or `,` inside a function call. The server must identify the enclosing call expression, resolve the callee to a declaration, extract parameter information, and track which parameter is active based on comma position.

Pike function calls are represented in tree-sitter as `postfix_expr` nodes with parenthesized arguments. Arguments may be wrapped in an `argument_list` node, and comma-separated arguments may be further wrapped in `comma_expr` nodes.

## Decision

### Call Expression Detection

Walk up from the cursor node to find a `postfix_expr` that contains `(` and `)` children. This identifies the enclosing call.

### Callee Resolution

Extract the callee name from the first child of the `postfix_expr`. For arrow access (`d->speak`), extract the method name after `->`. For dot access (`Module.func`), extract after `.`.

Resolution order:
1. Local/workspace function declarations (via symbol table)
2. Stdlib autodoc index (by `predef.<name>` key)

### Parameter Extraction

For local functions:
- Find the scope containing the function declaration (class scope for methods, file scope for top-level functions)
- Find the child function scope whose range overlaps with the declaration range
- Collect parameters from that scope

For stdlib functions:
- Parse parameters from the signature string in the autodoc entry
- Split by commas respecting nested parentheses

### Active Parameter Tracking

Count commas before the cursor position inside the argument list. Arguments wrapped in `argument_list` and `comma_expr` nodes require recursive descent.

**MUST**:
- Trigger on `(` and `,`
- Resolve callee to local declaration or stdlib entry
- Track active parameter via comma count
- Return null when not inside a call expression

**SHOULD**:
- Show parameter types from declarations
- Show documentation from stdlib autodoc

**MAY**:
- Support nested calls in the future
- Support method resolution through type inference (currently only direct method calls)

## Consequences

### Positive
- Standard LSP signature help for all local functions and stdlib functions
- Active parameter tracking gives precise parameter hints

### Negative
- Method resolution only works for direct calls (`d->speak()`) not chained inference
- Stdlib functions with qualified names (`predef.ADT.BitBuffer.feed`) are not matched by simple name
- Parameters in `comma_expr` wrappers require recursive comma counting

### Neutral
- Signature help is tree-sitter based and synchronous — no PikeWorker needed
- The `argument_list` → `comma_expr` nesting is a tree-sitter-pike quirk

## Alternatives Considered

### PikeWorker-based signature help
Using the Pike runtime to resolve signatures would handle all cases but adds latency. Tree-sitter + symbol table covers the common cases without subprocess overhead.

### No recursive comma counting
Flattening the argument list by text scanning was considered but would be fragile with nested calls and strings. Recursive AST walking is more reliable.
