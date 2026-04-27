# Pike LSP Semantic Corpus — Manifest

This corpus exercises **semantic** features the Pike Language Server must handle.
tree-sitter-pike's corpus tests cover parse correctness; these files cover
type checking, cross-file resolution, diagnostics, and language semantics.

## File Naming Convention

- `basic-*` — basic types, variables, literals
- `class-*` — classes, inheritance, object semantics
- `fn-*` — functions, closures, lambdas
- `import-*` — imports, modules, path resolution
- `err-*` — files that intentionally produce Pike errors
- `cross-*` — cross-file references (pairs share a prefix)
- `stdlib-*` — standard library usage patterns
- `cpp-*` — preprocessor directives
- `enum-*` — enums and constants
- `compat-*` — version compatibility directives
- `mod-*` — modifier combinations (access, scope)
- `generic-*` — parameterized/generic types

## Priority Levels

- **P0** — Required for Phase 1 diagnostic harness
- **P1** — Required for Phase 2–3 (hover, completion, navigation)
- **P2** — Required for Phase 4–5 (refactoring, advanced features)

## Corpus Files

### Basic Types and Variables

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 1 | `basic-types.pike` | All primitive types: int, float, string, void, mixed, zero | P0 | Yes |
| 2 | `basic-collections.pike` | Array, mapping, multiset literals with `#pragma strict_types` | P0 | Yes |
| 3 | `basic-generics.pike` | `array(int)`, `mapping(string:int)`, `function(int:string)`, `multiset(string)` | P0 | Yes |
| 4 | `basic-type-conversions.pike` | Implicit and explicit casts, auto-conversion edge cases | P1 | No |
| 5 | `basic-string-types.pike` | String ranges `string(97..122)`, wide strings, Unicode | P1 | No |
| 6 | `basic-int-ranges.pike` | Int ranges `int(0..255)`, zero types, boolean patterns | P1 | No |

### Classes and Inheritance

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 7 | `class-single-inherit.pike` | Single inheritance, `::` operator, parent method calls | P0 | Yes |
| 8 | `class-multi-inherit.pike` | Multiple inheritance, name collision, scope resolution | P1 | No |
| 9 | `class-virtual-inherit.pike` | `inherit Foo : foo;` named/virtual inherit | P1 | No |
| 10 | `class-this-object.pike` | `this`, `this_program`, `this_object()` | P1 | No |
| 11 | `class-create.pike` | Constructor `create()`, `::create()` chaining, argument forwarding | P0 | Yes |
| 12 | `class-abstract.pike` | Abstract-like patterns (unimplemented methods in parent) | P2 | No |

### Functions and Closures

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 13 | `fn-types.pike` | Function type declarations, function pointers | P0 | Yes |
| 14 | `fn-lambda.pike` | Lambda expressions, anonymous functions, closure semantics | P0 | Yes |
| 15 | `fn-overload.pike` | Function overloading by argument types | P1 | No |
| 16 | `fn-varargs.pike` | Variadic arguments, `...` splat, `args` array | P1 | No |
| 17 | `fn-callbacks.pike` | Callback patterns, `call_out`, function references | P1 | No |

### Imports and Modules

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 18 | `import-stdlib.pike` | `import Stdio;`, using imported symbols | P0 | Yes |
| 19 | `import-pmod.pike` | `.pmod` module structure, `#pragma strict_types` interaction | P1 | No |
| 20 | `import-nested.pike` | Nested module resolution `ADT.Histogram`, `Calendar.ISO` | P1 | No |
| 21 | `import-relative.pike` | Relative imports, include path resolution | P1 | No |

### Error Cases — Type Errors

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 22 | `err-type-assign.pike` | Wrong type in assignment under strict_types | P0 | Yes |
| 23 | `err-type-return.pike` | Wrong return type from function | P0 | Yes |
| 24 | `err-type-call.pike` | Wrong argument types in function call | P0 | Yes |
| 25 | `err-type-member.pike` | Type mismatch accessing object member | P1 | No |
| 26 | `err-type-generic.pike` | Generic type violations: `array(int)` assigned `array(string)` | P1 | No |

### Error Cases — Undefined Identifiers

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 27 | `err-undef-var.pike` | Reference to undefined variable | P0 | Yes |
| 28 | `err-undef-fn.pike` | Call to undefined function | P0 | Yes |
| 29 | `err-undef-class.pike` | Inherit from undefined class | P1 | No |
| 30 | `err-undef-member.pike` | Access to undefined object member | P1 | No |

### Error Cases — Wrong Arity

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 31 | `err-arity-few.pike` | Too few arguments to function call | P0 | Yes |
| 32 | `err-arity-many.pike` | Too many arguments to function call | P0 | Yes |
| 33 | `err-arity-create.pike` | Wrong arity in `create()` / `::create()` | P1 | No |

### Error Cases — Syntax / Recovery

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 34 | `err-syntax-basic.pike` | Basic syntax errors: missing semicolons, unmatched braces | P0 | Yes |
| 35 | `err-syntax-partial.pike` | Partial programs: incomplete class/function bodies | P1 | No |

### Modifier Combinations

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 36 | `mod-access.pike` | `protected`, `private`, `public`, `static` visibility | P0 | Yes |
| 37 | `mod-final.pike` | `final` methods and classes, override prevention | P1 | No |
| 38 | `mod-inline.pike` | `inline`, `local`, `nomask` modifiers | P2 | No |
| 39 | `mod-attribute.pike` | `__deprecated__`, custom attributes | P2 | No |

### Version Compatibility

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 40 | `compat-78.pike` | `#pike 7.8` compatibility mode | P1 | No |
| 41 | `compat-74.pike` | `#pike 7.4` compatibility mode | P2 | No |

### Cross-File References

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 42 | `cross-lib-base.pike` | Base class / library module for cross-file tests | P0 | Yes |
| 43 | `cross-lib-consumer.pike` | Inherits/imports from `cross-lib-base.pike` | P0 | Yes |
| 44 | `cross-lib-module.pmod` | `.pmod` module file for import resolution | P1 | No |
| 45 | `cross-lib-user.pike` | Uses symbols from `cross-lib-module.pmod` | P1 | No |

### Standard Library Usage

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 46 | `stdlib-fileio.pike` | `Stdio.File`, `Stdio.read_file`, `Stdio.write_file` | P0 | Yes |
| 47 | `stdlib-string.pike` | `String.Buffer`, `String.trim_whites`, `String.split` | P1 | No |
| 48 | `stdlib-array.pike` | `Array.map`, `Array.filter`, `Array.sort` | P1 | No |
| 49 | `stdlib-mapping.pike` | `Mapping`, `m_delete`, `m_sizeof` | P1 | No |
| 50 | `stdlib-concurrent.pike` | `Concurrent.Promise`, `Concurrent.Future` | P2 | No |

### Preprocessor

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 51 | `cpp-ifdef.pike` | `#if`, `#ifdef`, `#ifndef`, `#else`, `#elif`, `#endif` | P0 | Yes |
| 52 | `cpp-define.pike` | `#define`, `#undef`, macro expansion | P1 | No |
| 53 | `cpp-include.pike` | `#include`, `#string` directives | P1 | No |

### Enums and Constants

| # | File | Feature(s) | Priority | Exists |
|---|------|------------|----------|--------|
| 54 | `enum-basic.pike` | `enum` declaration, enum values, typed enums | P0 | Yes |
| 55 | `constant-basic.pike` | `constant` declarations, constant expressions | P1 | No |
| 56 | `enum-flags.pike` | Bit-flag enum patterns, `|` combinations | P2 | No |

## Summary

| Category | P0 | P1 | P2 | Total |
|----------|----|----|----|----|
| Basic types | 3 | 3 | 0 | 6 |
| Classes | 2 | 3 | 1 | 6 |
| Functions | 2 | 3 | 0 | 5 |
| Imports | 1 | 3 | 0 | 4 |
| Type errors | 3 | 2 | 0 | 5 |
| Undefined | 2 | 2 | 0 | 4 |
| Arity | 2 | 1 | 0 | 3 |
| Syntax/recovery | 1 | 1 | 0 | 2 |
| Modifiers | 1 | 1 | 2 | 4 |
| Compat | 0 | 1 | 1 | 2 |
| Cross-file | 2 | 2 | 0 | 4 |
| Stdlib | 1 | 3 | 1 | 5 |
| Preprocessor | 1 | 2 | 0 | 3 |
| Enums/consts | 1 | 1 | 1 | 3 |
| **Total** | **22** | **28** | **6** | **56** |
