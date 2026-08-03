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

## Corpus Files (83 committed)

### Basic types and variables

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 1 | `basic-collections.pike` | Array, mapping, multiset literals with strict_types | P0 | Valid |
| 2 | `basic-generics.pike` | `array(int)`, `mapping(string:int)`, `function(int:string)`, `multiset(string)` | P0 | Valid |
| 3 | `basic-int-ranges.pike` | Int ranges | P0 | Valid |
| 4 | `basic-nonstrict.pike` | No `#pragma strict_types`: type errors silently accepted, no unused-variable warnings | P0 | Valid |
| 5 | `basic-string-types.pike` | String types | P0 | Valid |
| 6 | `basic-type-conversions.pike` | Type conversions | P0 | Valid |
| 7 | `basic-types.pike` | All primitive types: int, float, string, void, mixed | P0 | Valid |

### Classes and inheritance

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 8 | `class-create.pike` | Constructor `create()`, `::create()` chaining, argument forwarding | P0 | Valid |
| 9 | `class-forward-refs.pike` | Forward class references, mutually recursive classes | P0 | Valid |
| 10 | `class-inherit-rename.pike` | `inherit Foo : alias` renaming, scoped access via alias | P0 | Valid |
| 11 | `class-multi-inherit.pike` | Multiple inheritance, name collision, `A::value()` resolution | P0 | Valid |
| 12 | `class-single-inherit.pike` | Single inheritance, `::` operator, parent method calls | P0 | Valid |
| 13 | `class-this-object.pike` | `this`, `this_program`, `this_object()`, fluent pattern | P0 | Valid |
| 14 | `class-virtual-inherit.pike` | Named inherit `inherit Logger : log`, scoped access `log::log()` | P0 | Valid |

### Functions and closures

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 15 | `fn-callbacks.pike` | Callback patterns, function references, lambda as argument | P0 | Valid |
| 16 | `fn-lambda.pike` | Lambda expressions, anonymous functions, closure semantics | P0 | Valid |
| 17 | `fn-overload.pike` | Function overloading by argument types (multiple signatures) | P0 | Valid |
| 18 | `fn-types.pike` | Function type declarations, function pointers | P0 | Valid |
| 19 | `fn-varargs.pike` | Variadic arguments `mixed ... args`, args array access | P0 | Valid |

### Imports and modules

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 20 | `import-nested.pike` | Nested module resolution `Calendar.ISO`, `ADT.Stack`, `Crypto.Random` | P0 | Valid |
| 21 | `import-pmod.pike` | `.pmod` directory module structure and imports | P0 | Valid* |
| 22 | `import-relative.pike` | Relative | P0 | Valid |
| 23 | `import-stdlib.pike` | `import Stdio;`, using imported symbols | P0 | Valid |

### Error cases

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 24 | `err-arity-create.pike` | Wrong arity in `create()` / `::create()` | P0 | Error |
| 25 | `err-arity-few.pike` | Too few arguments to function call | P0 | Error |
| 26 | `err-arity-many.pike` | Too many arguments to function call | P0 | Error |
| 27 | `err-syntax-basic.pike` | Basic syntax errors: missing semicolons, unmatched braces | P0 | Error |
| 28 | `err-syntax-partial.pike` | Syntax partial | P0 | Valid |
| 29 | `err-type-assign.pike` | Wrong type in assignment under strict_types | P0 | Error |
| 30 | `err-type-call.pike` | Wrong argument types in function call | P0 | Error |
| 31 | `err-type-generic.pike` | Generic type violations: `array(int) = array(string)` | P0 | Error |
| 32 | `err-type-member.pike` | Type member | P0 | Valid |
| 33 | `err-type-return.pike` | Wrong return type from function | P0 | Error |
| 34 | `err-undef-class.pike` | Inherit from / instantiate undefined class | P0 | Error |
| 35 | `err-undef-fn.pike` | Call to undefined function | P0 | Error |
| 36 | `err-undef-member.pike` | Access to undefined object member | P0 | Error |
| 37 | `err-undef-var.pike` | Reference to undefined variable | P0 | Error |

### AutoDoc documentation

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 38 | `autodoc-documented.pike` | `//!` doc comments, AutoDoc XML extraction, documented class + function | P0 | Valid |

### Modifier combinations

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 39 | `mod-access.pike` | `protected`, `private`, `public`, `static` visibility | P0 | Valid |
| 40 | `mod-final.pike` | `final` methods and classes, override prevention | P0 | Valid |

### Standard library usage

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 41 | `stdlib-array.pike` | Array | P0 | Valid |
| 42 | `stdlib-fileio.pike` | `Stdio.File`, `Stdio.read_file`, `Stdio.write_file` | P0 | Valid |
| 43 | `stdlib-mapping.pike` | Mapping | P0 | Valid |
| 44 | `stdlib-string.pike` | String | P0 | Valid |

### Preprocessor

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 45 | `cpp-define.pike` | `#define`, `#undef`, macro expansion | P0 | Valid |
| 46 | `cpp-ifdef.pike` | `#if`, `#ifdef`, `#ifndef`, `#else`, `#elif`, `#endif` | P0 | Valid |
| 47 | `cpp-include.pike` | `#include`, `#string` directives | P0 | Valid |

### Enums and constants

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 48 | `constant-basic.pike` | `constant` declarations, constant expressions | P0 | Valid |
| 49 | `enum-basic.pike` | `enum` declaration, enum values, typed enums | P0 | Valid |

### Cross-file references

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 50 | `cross-circular-a.pike` | Circular inheritance (part A) | P1 | Valid |
| 51 | `cross-circular-b.pike` | Circular inheritance (part B) | P1 | Valid |
| 52 | `cross-import-b.pike` | Imports `cross_import_a.pmod` (cross-file import test) | P1 | Valid* |
| 53 | `cross-inherit-chain-a.pike` | Multi-level inheritance chain (base) | P1 | Valid |
| 54 | `cross-inherit-chain-b.pike` | Multi-level inheritance chain (middle) | P1 | Valid |
| 55 | `cross-inherit-chain-c.pike` | Multi-level inheritance chain (consumer) | P1 | Valid |
| 56 | `cross-inherit-rename-a.pike` | Cross-file inherit with rename (base) | P1 | Valid |
| 57 | `cross-inherit-rename-b.pike` | Cross-file inherit with rename (consumer) | P1 | Valid |
| 58 | `cross-inherit-simple-a.pike` | Simple cross-file inheritance (base) | P1 | Valid |
| 59 | `cross-inherit-simple-b.pike` | Simple cross-file inheritance (consumer) | P1 | Valid |
| 60 | `cross-lib-base.pike` | Base class / library module for cross-file tests | P1 | Valid |
| 61 | `cross-lib-consumer.pike` | Inherits from `cross-lib-base.pike` (requires `-I .`) | P1 | Valid* |
| 62 | `cross-lib-user.pike` | Uses symbols from `cross_lib_module.pmod` (requires `-M .`) | P1 | Valid* |
| 63 | `cross-pmod-user.pike` | Uses `cross_pmod_dir.pmod/helpers.pike` via `.pmod` path | P1 | Valid* |
| 64 | `cross-stdlib.pike` | Cross-file stdlib usage (`Stdio.read_file`) | P1 | Valid |

### Compatibility

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 65 | `compat-pike78.pike` | `#pike 7.8` compatibility directive | P1 | Valid |

### Type inference

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 66 | `inference-assign.pike` | Assignment inference: constructor/function assignment, member access | P1 | Valid |
| 67 | `inference-chained.pike` | Chained inference: a()->b()->c() cascading access | P1 | Valid |
| 68 | `inference-failure.pike` | Inference failure: mixed returns, unknown types, unresolvable | P1 | Error |
| 69 | `inference-return.pike` | Return type inference: typed function returns, caller member access | P1 | Valid |

### Scoping

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 70 | `nested-scope-chain.pike` | Deeply nested scopes, scope chain traversal | P1 | Valid |
| 71 | `scope-for-catch.pike` | For-loop and catch-block variable scoping | P1 | Valid |
| 72 | `scope-shadow-params.pike` | Variable shadowing, parameter name conflicts | P1 | Valid |

### Rename testing

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 73 | `rename-base.pike` | Base class for rename tests | P1 | Valid |
| 74 | `rename-child.pike` | Child class inheriting base | P1 | Valid |
| 75 | `rename-crossfile-cat.pike` | Cross-file rename test: Cat class | P1 | Valid |
| 76 | `rename-crossfile-dog.pike` | Cross-file rename test: Dog class | P1 | Valid |
| 77 | `rename-crossfile-main.pike` | Cross-file rename test: consumer | P1 | Valid |
| 78 | `rename-main.pike` | Main file using base and child | P1 | Valid |

### Miscellaneous

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 79 | `cross_import_a.pmod` | cross_import_a.pmod | P1 | Valid |
| 80 | `cross_lib_module.pmod` | `.pmod` module file: functions, constants, classes | P1 | Valid |
| 81 | `lint-unreachable.pike` | lint-unreachable.pike | P1 | Valid |
| 82 | `lint-unused-var.pike` | lint-unused-var.pike | P1 | Valid |
| 83 | `sig-help-classes.pike` | sig-help-classes.pike | P1 | Valid |


## Summary

| Category | Count | Valid | Error |
|----------|-------|-------|-------|
| Basic types and variables | 7 | 7 | 0 |
| Classes and inheritance | 7 | 7 | 0 |
| Functions and closures | 5 | 5 | 0 |
| Imports and modules | 4 | 4 | 0 |
| Error cases | 14 | 2 | 12 |
| AutoDoc documentation | 1 | 1 | 0 |
| Modifier combinations | 2 | 2 | 0 |
| Standard library usage | 4 | 4 | 0 |
| Preprocessor | 3 | 3 | 0 |
| Enums and constants | 2 | 2 | 0 |
| Cross-file references | 15 | 15 | 0 |
| Compatibility | 1 | 1 | 0 |
| Type inference | 4 | 3 | 1 |
| Scoping | 3 | 3 | 0 |
| Rename testing | 6 | 6 | 0 |
| Miscellaneous | 5 | 5 | 0 |
| **Total**                        | **83** | **70** | **13** |
