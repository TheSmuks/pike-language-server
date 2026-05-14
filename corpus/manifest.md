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

## Corpus Files (80 committed)

### Basic types and variables

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 1 | `basic-int-ranges.pike` | Int ranges | P0 | Valid |
| 2 | `basic-string-types.pike` | String types | P0 | Valid |
| 3 | `basic-type-conversions.pike` | Type conversions | P0 | Valid |

### Imports and modules

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 4 | `import-relative.pike` | Relative | P0 | Valid |

### Error cases

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 5 | `err-syntax-partial.pike` | Syntax partial | P0 | Valid |
| 6 | `err-type-member.pike` | Type member | P0 | Valid |

### Standard library usage

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 7 | `stdlib-array.pike` | Array | P0 | Valid |
| 8 | `stdlib-mapping.pike` | Mapping | P0 | Valid |
| 9 | `stdlib-string.pike` | String | P0 | Valid |

### 

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 10 | `autodoc-documented.pike` | `//!` doc comments, AutoDoc XML extraction, documented class + function | P0 | Valid |
| 11 | `basic-collections.pike` | Array, mapping, multiset literals with strict_types | P0 | Valid |
| 12 | `basic-generics.pike` | `array(int)`, `mapping(string:int)`, `function(int:string)`, `multiset(string)` | P0 | Valid |
| 13 | `basic-nonstrict.pike` | No `#pragma strict_types`: type errors silently accepted, no unused-variable warnings | P0 | Valid |
| 14 | `basic-types.pike` | All primitive types: int, float, string, void, mixed | P0 | Valid |
| 15 | `class-create.pike` | Constructor `create()`, `::create()` chaining, argument forwarding | P0 | Valid |
| 16 | `class-forward-refs.pike` | Forward class references, mutually recursive classes | P0 | Valid |
| 17 | `class-inherit-rename.pike` | `inherit Foo : alias` renaming, scoped access via alias | P0 | Valid |
| 18 | `class-multi-inherit.pike` | Multiple inheritance, name collision, `A::value()` resolution | P0 | Valid |
| 19 | `class-single-inherit.pike` | Single inheritance, `::` operator, parent method calls | P0 | Valid |
| 20 | `class-this-object.pike` | `this`, `this_program`, `this_object()`, fluent pattern | P0 | Valid |
| 21 | `class-virtual-inherit.pike` | Named inherit `inherit Logger : log`, scoped access `log::log()` | P0 | Valid |
| 22 | `compat-pike78.pike` | `#pike 7.8` compatibility directive | P0 | Valid |
| 23 | `constant-basic.pike` | `constant` declarations, constant expressions | P0 | Valid |
| 24 | `cpp-define.pike` | `#define`, `#undef`, macro expansion | P0 | Valid |
| 25 | `cpp-ifdef.pike` | `#if`, `#ifdef`, `#ifndef`, `#else`, `#elif`, `#endif` | P0 | Valid |
| 26 | `cpp-include.pike` | `#include`, `#string` directives | P0 | Valid |
| 27 | `cross_lib_module.pmod` | `.pmod` module file: functions, constants, classes | P0 | Valid |
| 28 | `cross-circular-a.pike` | Circular inheritance (part A) | P0 | Valid |
| 29 | `cross-circular-b.pike` | Circular inheritance (part B) | P0 | Valid |
| 30 | `cross-import-b.pike` | Imports `cross_import_a.pmod` (cross-file import test) | P0 | Valid* |
| 31 | `cross-inherit-chain-a.pike` | Multi-level inheritance chain (base) | P0 | Valid |
| 32 | `cross-inherit-chain-b.pike` | Multi-level inheritance chain (middle) | P0 | Valid |
| 33 | `cross-inherit-chain-c.pike` | Multi-level inheritance chain (consumer) | P0 | Valid |
| 34 | `cross-inherit-rename-a.pike` | Cross-file inherit with rename (base) | P0 | Valid |
| 35 | `cross-inherit-rename-b.pike` | Cross-file inherit with rename (consumer) | P0 | Valid |
| 36 | `cross-inherit-simple-a.pike` | Simple cross-file inheritance (base) | P0 | Valid |
| 37 | `cross-inherit-simple-b.pike` | Simple cross-file inheritance (consumer) | P0 | Valid |
| 38 | `cross-lib-base.pike` | Base class / library module for cross-file tests | P0 | Valid |
| 39 | `cross-lib-consumer.pike` | Inherits from `cross-lib-base.pike` (requires `-I .`) | P0 | Valid* |
| 40 | `cross-lib-user.pike` | Uses symbols from `cross_lib_module.pmod` (requires `-M .`) | P0 | Valid* |
| 41 | `cross-pmod-user.pike` | Uses `cross_pmod_dir.pmod/helpers.pike` via `.pmod` path | P0 | Valid* |
| 42 | `cross-stdlib.pike` | Cross-file stdlib usage (`Stdio.read_file`) | P0 | Valid |
| 43 | `enum-basic.pike` | `enum` declaration, enum values, typed enums | P0 | Valid |
| 44 | `err-arity-create.pike` | Wrong arity in `create()` / `::create()` | P0 | Error |
| 45 | `err-arity-few.pike` | Too few arguments to function call | P0 | Error |
| 46 | `err-arity-many.pike` | Too many arguments to function call | P0 | Error |
| 47 | `err-syntax-basic.pike` | Basic syntax errors: missing semicolons, unmatched braces | P0 | Error |
| 48 | `err-type-assign.pike` | Wrong type in assignment under strict_types | P0 | Error |
| 49 | `err-type-call.pike` | Wrong argument types in function call | P0 | Error |
| 50 | `err-type-generic.pike` | Generic type violations: `array(int) = array(string)` | P0 | Error |
| 51 | `err-type-return.pike` | Wrong return type from function | P0 | Error |
| 52 | `err-undef-class.pike` | Inherit from / instantiate undefined class | P0 | Error |
| 53 | `err-undef-fn.pike` | Call to undefined function | P0 | Error |
| 54 | `err-undef-member.pike` | Access to undefined object member | P0 | Error |
| 55 | `err-undef-var.pike` | Reference to undefined variable | P0 | Error |
| 56 | `fn-callbacks.pike` | Callback patterns, function references, lambda as argument | P0 | Valid |
| 57 | `fn-lambda.pike` | Lambda expressions, anonymous functions, closure semantics | P0 | Valid |
| 58 | `fn-overload.pike` | Function overloading by argument types (multiple signatures) | P0 | Valid |
| 59 | `fn-types.pike` | Function type declarations, function pointers | P0 | Valid |
| 60 | `fn-varargs.pike` | Variadic arguments `mixed ... args`, args array access | P0 | Valid |
| 61 | `import-nested.pike` | Nested module resolution `Calendar.ISO`, `ADT.Stack`, `Crypto.Random` | P0 | Valid |
| 62 | `import-pmod.pike` | `.pmod` directory module structure and imports | P0 | Valid* |
| 63 | `import-stdlib.pike` | `import Stdio;`, using imported symbols | P0 | Valid |
| 64 | `inference-assign.pike` | Assignment inference: constructor/function assignment, member access | P0 | Valid |
| 65 | `inference-chained.pike` | Chained inference: a()->b()->c() cascading access | P0 | Valid |
| 66 | `inference-failure.pike` | Inference failure: mixed returns, unknown types, unresolvable | P0 | Error |
| 67 | `inference-return.pike` | Return type inference: typed function returns, caller member access | P0 | Valid |
| 68 | `mod-access.pike` | `protected`, `private`, `public`, `static` visibility | P0 | Valid |
| 69 | `mod-final.pike` | `final` methods and classes, override prevention | P0 | Valid |
| 70 | `nested-scope-chain.pike` | Deeply nested scopes, scope chain traversal | P0 | Valid |
| 71 | `rename-base.pike` | Base class for rename tests | P0 | Valid |
| 72 | `rename-child.pike` | Child class inheriting base | P0 | Valid |
| 73 | `rename-crossfile-cat.pike` | Cross-file rename test: Cat class | P0 | Valid |
| 74 | `rename-crossfile-dog.pike` | Cross-file rename test: Dog class | P0 | Valid |
| 75 | `rename-crossfile-main.pike` | Cross-file rename test: consumer | P0 | Valid |
| 76 | `rename-main.pike` | Main file using base and child | P0 | Valid |
| 77 | `scope-for-catch.pike` | For-loop and catch-block variable scoping | P0 | Valid |
| 78 | `scope-shadow-params.pike` | Variable shadowing, parameter name conflicts | P0 | Valid |
| 79 | `stdlib-fileio.pike` | `Stdio.File`, `Stdio.read_file`, `Stdio.write_file` | P0 | Valid |

### Miscellaneous

| # | File | Feature(s) | Priority | Status |
|---|------|------------|----------|--------|
| 80 | `cross_import_a.pmod` | cross_import_a.pmod | P1 | Valid |


## Summary

| Category | Count | Valid | Error |
|----------|-------|-------|-------|
| Basic types and variables | 3 | 3 | 0 |
| Imports and modules | 1 | 1 | 0 |
| Error cases | 2 | 2 | 0 |
| Standard library usage | 3 | 3 | 0 |
|  | 70 | 57 | 13 |
| Miscellaneous | 1 | 1 | 0 |
| **Total**                        | **80** | **67** | **13** |

> **Note:** 10 file(s) on disk not yet committed to the manifest. Run `bun run scripts/manifest.ts --sync` to add them.