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
- `inference-*` — type inference patterns
- `scope-*` — scoping edge cases
- `rename-*` — rename testing (multi-file)

## Priority Levels

- **P0** — Required for Phase 1 diagnostic harness
- **P1** — Required for Phase 2–3 (hover, completion, navigation)
- **P2** — Required for Phase 4–5 (refactoring, advanced features)

## Corpus Files (73 committed)

### Basic Types and Variables

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 1 | `basic-types.pike` | All primitive types: int, float, string, void, mixed | P0 | Valid |
| 2 | `basic-collections.pike` | Array, mapping, multiset literals with strict_types | P0 | Valid |
| 3 | `basic-generics.pike` | `array(int)`, `mapping(string:int)`, `function(int:string)`, `multiset(string)` | P0 | Valid |
| 4 | `basic-nonstrict.pike` | No `#pragma strict_types`: type errors silently accepted, no unused-variable warnings | P0 | Valid |

### Classes and Inheritance

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 5 | `class-single-inherit.pike` | Single inheritance, `::` operator, parent method calls | P0 | Valid |
| 6 | `class-multi-inherit.pike` | Multiple inheritance, name collision, `A::value()` resolution | P0 | Valid |
| 7 | `class-virtual-inherit.pike` | Named inherit `inherit Logger : log`, scoped access `log::log()` | P0 | Valid |
| 8 | `class-this-object.pike` | `this`, `this_program`, `this_object()`, fluent pattern | P0 | Valid |
| 9 | `class-create.pike` | Constructor `create()`, `::create()` chaining, argument forwarding | P0 | Valid |
| 10 | `class-forward-refs.pike` | Forward class references, mutually recursive classes | P1 | Valid |
| 11 | `class-inherit-rename.pike` | `inherit Foo : alias` renaming, scoped access via alias | P1 | Valid |

### Functions and Closures

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 12 | `fn-types.pike` | Function type declarations, function pointers | P0 | Valid |
| 13 | `fn-lambda.pike` | Lambda expressions, anonymous functions, closure semantics | P0 | Valid |
| 14 | `fn-varargs.pike` | Variadic arguments `mixed ... args`, args array access | P0 | Valid |
| 15 | `fn-callbacks.pike` | Callback patterns, function references, lambda as argument | P0 | Valid |
| 16 | `fn-overload.pike` | Function overloading by argument types (multiple signatures) | P1 | Valid |

### Imports and Modules

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 17 | `import-stdlib.pike` | `import Stdio;`, using imported symbols | P0 | Valid |
| 18 | `import-nested.pike` | Nested module resolution `Calendar.ISO`, `ADT.Stack`, `Crypto.Random` | P0 | Valid |
| 19 | `import-pmod.pike` | `.pmod` directory module structure and imports | P1 | Valid |

### Error Cases — Type Errors

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 20 | `err-type-assign.pike` | Wrong type in assignment under strict_types | P0 | Error |
| 21 | `err-type-return.pike` | Wrong return type from function | P0 | Error |
| 22 | `err-type-call.pike` | Wrong argument types in function call | P0 | Error |
| 23 | `err-type-generic.pike` | Generic type violations: `array(int) = array(string)` | P0 | Error |

### Error Cases — Undefined Identifiers

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 24 | `err-undef-var.pike` | Reference to undefined variable | P0 | Error |
| 25 | `err-undef-fn.pike` | Call to undefined function | P0 | Error |
| 26 | `err-undef-class.pike` | Inherit from / instantiate undefined class | P0 | Error |
| 27 | `err-undef-member.pike` | Access to undefined object member | P0 | Error |

### Error Cases — Wrong Arity

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 28 | `err-arity-few.pike` | Too few arguments to function call | P0 | Error |
| 29 | `err-arity-many.pike` | Too many arguments to function call | P0 | Error |
| 30 | `err-arity-create.pike` | Wrong arity in `create()` / `::create()` | P0 | Error |

### Error Cases — Syntax / Recovery

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 31 | `err-syntax-basic.pike` | Basic syntax errors: missing semicolons, unmatched braces | P0 | Error |

### AutoDoc Documentation

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 32 | `autodoc-documented.pike` | `//!` doc comments, AutoDoc XML extraction, documented class + function | P0 | Valid |

### Modifier Combinations

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 33 | `mod-access.pike` | `protected`, `private`, `public`, `static` visibility | P0 | Valid |
| 34 | `mod-final.pike` | `final` methods and classes, override prevention | P0 | Valid |

### Cross-File References

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 35 | `cross-lib-base.pike` | Base class / library module for cross-file tests | P0 | Valid |
| 36 | `cross-lib-consumer.pike` | Inherits from `cross-lib-base.pike` (requires `-I .`) | P0 | Valid* |
| 37 | `cross_lib_module.pmod` | `.pmod` module file: functions, constants, classes | P0 | Valid |
| 38 | `cross-lib-user.pike` | Uses symbols from `cross_lib_module.pmod` (requires `-M .`) | P0 | Valid* |
| 39 | `cross-pmod-user.pike` | Uses `cross_pmod_dir.pmod/helpers.pike` via `.pmod` path | P1 | Valid |
| 40 | `cross-import-b.pike` | Imports `cross_import_a.pmod` (cross-file import test) | P1 | Valid |
| 41 | `cross-stdlib.pike` | Cross-file stdlib usage (`Stdio.read_file`) | P1 | Valid |
| 42 | `cross-inherit-simple-a.pike` | Simple cross-file inheritance (base) | P1 | Valid |
| 43 | `cross-inherit-simple-b.pike` | Simple cross-file inheritance (consumer) | P1 | Valid |
| 44 | `cross-inherit-chain-a.pike` | Multi-level inheritance chain (base) | P1 | Valid |
| 45 | `cross-inherit-chain-b.pike` | Multi-level inheritance chain (middle) | P1 | Valid |
| 46 | `cross-inherit-chain-c.pike` | Multi-level inheritance chain (consumer) | P1 | Valid |
| 47 | `cross-inherit-rename-a.pike` | Cross-file inherit with rename (base) | P1 | Valid |
| 48 | `cross-inherit-rename-b.pike` | Cross-file inherit with rename (consumer) | P1 | Valid |
| 49 | `cross-circular-a.pike` | Circular inheritance (part A) | P1 | Valid |
| 50 | `cross-circular-b.pike` | Circular inheritance (part B) | P1 | Valid |

*Cross-file files require the corpus directory to be on the module/include path.

### Standard Library Usage

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 51 | `stdlib-fileio.pike` | `Stdio.File`, `Stdio.read_file`, `Stdio.write_file` | P0 | Valid |

### Preprocessor

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 52 | `cpp-ifdef.pike` | `#if`, `#ifdef`, `#ifndef`, `#else`, `#elif`, `#endif` | P0 | Valid |
| 53 | `cpp-define.pike` | `#define`, `#undef`, macro expansion | P1 | Valid |
| 54 | `cpp-include.pike` | `#include`, `#string` directives | P1 | Valid |

### Enums and Constants

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 55 | `enum-basic.pike` | `enum` declaration, enum values, typed enums | P0 | Valid |
| 56 | `constant-basic.pike` | `constant` declarations, constant expressions | P1 | Valid |

### Compatibility

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 57 | `compat-pike78.pike` | `#pike 7.8` compatibility directive | P1 | Valid |

### Type Inference

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 58 | `inference-return.pike` | Return type inference: typed function returns, caller member access | P1 | Valid |
| 59 | `inference-assign.pike` | Assignment inference: constructor/function assignment, member access | P1 | Valid |
| 60 | `inference-chained.pike` | Chained inference: a()->b()->c() cascading access | P1 | Valid |
| 61 | `inference-failure.pike` | Inference failure: mixed returns, unknown types, unresolvable | P1 | Error |

### Scoping

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 62 | `scope-for-catch.pike` | For-loop and catch-block variable scoping | P1 | Valid |
| 63 | `scope-shadow-params.pike` | Variable shadowing, parameter name conflicts | P1 | Valid |
| 64 | `nested-scope-chain.pike` | Deeply nested scopes, scope chain traversal | P1 | Valid |

### Rename Testing

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 65 | `rename-base.pike` | Base class for rename tests | P1 | Valid |
| 66 | `rename-child.pike` | Child class inheriting base | P1 | Valid |
| 67 | `rename-main.pike` | Main file using base and child | P1 | Valid |
| 68 | `rename-crossfile-dog.pike` | Cross-file rename test: Dog class | P1 | Valid |
| 69 | `rename-crossfile-cat.pike` | Cross-file rename test: Cat class | P1 | Valid |
| 70 | `rename-crossfile-main.pike` | Cross-file rename test: consumer | P1 | Valid |

## Summary

| Category | Count | Valid | Error |
|----------|-------|-------|-------|
| Basic types | 4 | 4 | 0 |
| Classes | 7 | 7 | 0 |
| Functions | 5 | 5 | 0 |
| Imports | 3 | 3 | 0 |
| Type errors | 4 | 0 | 4 |
| Undefined identifiers | 4 | 0 | 4 |
| Arity errors | 3 | 0 | 3 |
| Syntax/recovery | 1 | 0 | 1 |
| AutoDoc | 1 | 1 | 0 |
| Modifiers | 2 | 2 | 0 |
| Cross-file | 16 | 16 | 0 |
| Stdlib | 1 | 1 | 0 |
| Preprocessor | 3 | 3 | 0 |
| Enums/consts | 2 | 2 | 0 |
| Compat | 1 | 1 | 0 |
| Type inference | 4 | 3 | 1 |
| Scoping | 3 | 3 | 0 |
| Rename | 6 | 6 | 0 |
| **Total** | **73** | **58** | **13** |

## Planned but Not Yet Created (P1/P2)

These entries are tracked for future expansion.

| File | Feature(s) | Priority |
|------|------------|----------|
| `basic-type-conversions.pike` | Implicit and explicit casts | P1 |
| `basic-string-types.pike` | String ranges, wide strings | P1 |
| `basic-int-ranges.pike` | Int ranges, zero types | P1 |
| `class-abstract.pike` | Abstract-like patterns | P2 |
| `import-relative.pike` | Relative imports | P1 |
| `err-type-member.pike` | Type mismatch on member access | P1 |
| `compat-74.pike` | `#pike 7.4` compatibility | P2 |
| `stdlib-string.pike` | `String.Buffer`, trim, split | P1 |
| `stdlib-array.pike` | `Array.map`, `Array.filter`, sort | P1 |
| `stdlib-mapping.pike` | `Mapping`, `m_delete` | P1 |
| `stdlib-concurrent.pike` | `Concurrent.Promise`, `Concurrent.Future` | P2 |
| `enum-flags.pike` | Bit-flag enum patterns | P2 |
| `mod-inline.pike` | `inline`, `local`, `nomask` modifiers | P2 |
| `mod-attribute.pike` | `__deprecated__`, custom attributes | P2 |
| `err-syntax-partial.pike` | Partial/incomplete programs | P1 |