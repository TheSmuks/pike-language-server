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

## Corpus Files (35 committed)

### Basic Types and Variables

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 1 | `basic-types.pike` | All primitive types: int, float, string, void, mixed | P0 | Valid |
| 2 | `basic-collections.pike` | Array, mapping, multiset literals with strict_types | P0 | Valid |
| 3 | `basic-generics.pike` | `array(int)`, `mapping(string:int)`, `function(int:string)`, `multiset(string)` | P0 | Valid |

### Classes and Inheritance

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 4 | `class-single-inherit.pike` | Single inheritance, `::` operator, parent method calls | P0 | Valid |
| 5 | `class-multi-inherit.pike` | Multiple inheritance, name collision, `A::value()` resolution | P0 | Valid |
| 6 | `class-virtual-inherit.pike` | Named inherit `inherit Logger : log`, scoped access `log::log()` | P0 | Valid |
| 7 | `class-this-object.pike` | `this`, `this_program`, `this_object()`, fluent pattern | P0 | Valid |
| 8 | `class-create.pike` | Constructor `create()`, `::create()` chaining, argument forwarding | P0 | Valid |

### Functions and Closures

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 9 | `fn-types.pike` | Function type declarations, function pointers | P0 | Valid |
| 10 | `fn-lambda.pike` | Lambda expressions, anonymous functions, closure semantics | P0 | Valid |
| 11 | `fn-varargs.pike` | Variadic arguments `mixed ... args`, args array access | P0 | Valid |
| 12 | `fn-callbacks.pike` | Callback patterns, function references, lambda as argument | P0 | Valid |

### Imports and Modules

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 13 | `import-stdlib.pike` | `import Stdio;`, using imported symbols | P0 | Valid |
| 14 | `import-nested.pike` | Nested module resolution `Calendar.ISO`, `ADT.Stack`, `Crypto.Random` | P0 | Valid |

### Error Cases — Type Errors

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 15 | `err-type-assign.pike` | Wrong type in assignment under strict_types | P0 | Error |
| 16 | `err-type-return.pike` | Wrong return type from function | P0 | Error |
| 17 | `err-type-call.pike` | Wrong argument types in function call | P0 | Error |
| 18 | `err-type-generic.pike` | Generic type violations: `array(int) = array(string)` | P0 | Error |

### Error Cases — Undefined Identifiers

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 19 | `err-undef-var.pike` | Reference to undefined variable | P0 | Error |
| 20 | `err-undef-fn.pike` | Call to undefined function | P0 | Error |
| 21 | `err-undef-class.pike` | Inherit from / instantiate undefined class | P0 | Error |
| 22 | `err-undef-member.pike` | Access to undefined object member | P0 | Error |

### Error Cases — Wrong Arity

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 23 | `err-arity-few.pike` | Too few arguments to function call | P0 | Error |
| 24 | `err-arity-many.pike` | Too many arguments to function call | P0 | Error |
| 25 | `err-arity-create.pike` | Wrong arity in `create()` / `::create()` | P0 | Error |

### Error Cases — Syntax / Recovery

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 26 | `err-syntax-basic.pike` | Basic syntax errors: missing semicolons, unmatched braces | P0 | Error |

### Modifier Combinations

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 27 | `mod-access.pike` | `protected`, `private`, `public`, `static` visibility | P0 | Valid |
| 28 | `mod-final.pike` | `final` methods and classes, override prevention | P0 | Valid |

### Cross-File References

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 29 | `cross-lib-base.pike` | Base class / library module for cross-file tests | P0 | Valid |
| 30 | `cross-lib-consumer.pike` | Inherits from `cross-lib-base.pike` (requires `-I .`) | P0 | Valid* |
| 31 | `cross_lib_module.pmod` | `.pmod` module file: functions, constants, classes | P0 | Valid |
| 32 | `cross-lib-user.pike` | Uses symbols from `cross_lib_module.pmod` (requires `-M .`) | P0 | Valid* |

*Cross-file files require the corpus directory to be on the module/include path.

### Standard Library Usage

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 33 | `stdlib-fileio.pike` | `Stdio.File`, `Stdio.read_file`, `Stdio.write_file` | P0 | Valid |

### Preprocessor

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 34 | `cpp-ifdef.pike` | `#if`, `#ifdef`, `#ifndef`, `#else`, `#elif`, `#endif` | P0 | Valid |

### Enums and Constants

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 35 | `enum-basic.pike` | `enum` declaration, enum values, typed enums | P0 | Valid |

## Summary

| Category | Count | Valid | Error |
|----------|-------|-------|-------|
| Basic types | 3 | 3 | 0 |
| Classes | 5 | 5 | 0 |
| Functions | 4 | 4 | 0 |
| Imports | 2 | 2 | 0 |
| Type errors | 4 | 0 | 4 |
| Undefined identifiers | 4 | 0 | 4 |
| Arity errors | 3 | 0 | 3 |
| Syntax/recovery | 1 | 0 | 1 |
| Modifiers | 2 | 2 | 0 |
| Cross-file | 4 | 4 | 0 |
| Stdlib | 1 | 1 | 0 |
| Preprocessor | 1 | 1 | 0 |
| Enums/consts | 1 | 1 | 0 |
| **Total** | **35** | **23** | **12** |

## Planned but Not Yet Created (P1/P2)

These entries are tracked for future expansion. They are not required for Phase 1.

| File | Feature(s) | Priority |
|------|------------|----------|
| `basic-type-conversions.pike` | Implicit and explicit casts | P1 |
| `basic-string-types.pike` | String ranges, wide strings | P1 |
| `basic-int-ranges.pike` | Int ranges, zero types | P1 |
| `class-abstract.pike` | Abstract-like patterns | P2 |
| `fn-overload.pike` | Function overloading by argument types | P1 |
| `import-pmod.pike` | `.pmod` module structure | P1 |
| `import-relative.pike` | Relative imports | P1 |
| `err-type-member.pike` | Type mismatch on member access | P1 |
| `compat-78.pike` | `#pike 7.8` compatibility | P1 |
| `compat-74.pike` | `#pike 7.4` compatibility | P2 |
| `stdlib-string.pike` | `String.Buffer`, trim, split | P1 |
| `stdlib-array.pike` | `Array.map`, `Array.filter`, sort | P1 |
| `stdlib-mapping.pike` | `Mapping`, `m_delete` | P1 |
| `stdlib-concurrent.pike` | `Concurrent.Promise`, `Concurrent.Future` | P2 |
| `cpp-define.pike` | `#define`, `#undef`, macro expansion | P1 |
| `cpp-include.pike` | `#include`, `#string` directives | P1 |
| `constant-basic.pike` | `constant` declarations | P1 |
| `enum-flags.pike` | Bit-flag enum patterns | P2 |
| `mod-inline.pike` | `inline`, `local`, `nomask` modifiers | P2 |
| `mod-attribute.pike` | `__deprecated__`, custom attributes | P2 |
| `err-syntax-partial.pike` | Partial/incomplete programs | P1 |
