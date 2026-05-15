---
title: Signature Help
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - signature-help
  - adr
sources:
  - raw/articles/decisions-0021-signature-help.md
---

# Signature Help

Signature help provides parameter hints when a user types `(` or `,` inside a
function call. The server identifies the enclosing call expression, resolves
the callee to a declaration, extracts parameter information, and tracks which
parameter is active based on comma position.

## Trigger Characters

- `(` — opens a new call expression
- `,` — advances to the next parameter

## Call Expression Detection

Walk up from the cursor node in the tree-sitter AST to find a `postfix_expr`
that contains `(` and `)` children. This identifies the enclosing call.

For arrow access (`d->speak()`), the method name is extracted from after `->`.
For dot access (`Module.func()`), the name is extracted from after `.`.

## Callee Resolution (Two Sources)

Resolution follows a strict priority order:

1. **Local/workspace function declarations** — via the symbol table. Find the
   scope containing the function declaration (class scope for methods, file
   scope for top-level functions). Collect parameters from that scope.
2. **Stdlib autodoc index** — by `predef.<name>` key. Parse parameters from
   the signature string in the autodoc entry, splitting by commas while
   respecting nested parentheses.

If neither source resolves the callee, the handler returns `null`.

## Active Parameter Tracking

Count commas before the cursor position inside the argument list. Pike's
tree-sitter grammar wraps arguments in `argument_list` nodes, and
comma-separated arguments may be further wrapped in `comma_expr` nodes.
Accurate comma counting requires **recursive descent** through these wrapper
nodes rather than text scanning (which would be fragile with nested calls and
strings).

```
argument_list
├── comma_expr          ← recursive descent needed
│   ├── argument
│   └── argument
└── argument
```

## Implementation Properties

- **Synchronous and tree-sitter based** — no PikeWorker subprocess needed.
  Response is immediate.
- **Scope-aware** — methods are distinguished from functions by checking
  whether the callee declaration is inside a class scope.
- **Stdlib-aware** — parameter types and documentation from the autodoc index
  are shown for standard library functions.

## Limitations

- Method resolution only works for direct calls (`d->speak()`), not chained
  inference (`getDog()->speak()`).
- Stdlib functions with qualified names (`predef.ADT.BitBuffer.feed`) are not
  matched by simple name.
- Nested calls inside argument lists are not fully supported.

## Related

- [[pike]] — the language and its call expression syntax
- [[type-inference]] — callee resolution for function signatures uses type inference
- [[known-limitations]] — nested calls inside argument lists not fully supported
- [[pike-ai-kb]] — provides the stdlib autodoc index for signature lookup
