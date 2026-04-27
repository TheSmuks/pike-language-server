# Pike Interface Reference

## 1. Summary

Pike 8.0.1116 provides no structured (JSON, AST, or machine-readable) output mode. All compiler diagnostics are human-readable text to stderr in a stable `<filepath>:<line>:<message>` format. Type information is primarily a compile-time artifact; runtime introspection via `typeof()` works for locals and expressions but degrades to `mixed` for object members. The `pike-ai-kb` MCP server exposes seven tools that partially cover diagnostics, hover, and completion needs, but cross-file navigation, workspace-wide symbol resolution, and reliable hover for object members remain uncovered gaps. Any language server must parse the text-based error format and accept that some type information is fundamentally unavailable outside the compiler internals.

## 2. Pike Command-Line Flags

| Flag | Long Form | Description | LSP Relevance |
|------|-----------|-------------|---------------|
| `-I <p>` | `--include-path=<p>` | Add directory to include search path | Must replicate project include paths for accurate diagnostics |
| `-M <p>` | `--module-path=<p>` | Add directory to module search path | Must replicate project module paths for import resolution |
| `-P <p>` | `--program-path=<p>` | Add directory to program search path | Same as above for program resolution |
| `-e <cmd>` | `--execute=<cmd>` | Execute a Pike statement without a script file | Useful for one-off type queries via `typeof()` |
| `-E <f>` | `--preprocess=<f>` | Run preprocessor only, emit result | Limited use — does not check types, only expands macros |
| `-v` | `--version` | Print Pike version string | Capability detection at server startup |
| `--dumpversion` | | Print bare version number (e.g. `8.0.1116`) | Machine-parseable version check |
| `--features` | | List compiled-in features | Detect available modules (e.g., MySQL, OpenGL) |
| `--info` | | Build info and paths | Debug logging |
| `--show-paths` | | Show master.pike, module/include/program paths | Essential — discover stdlib paths for completion data |
| `-w` | `--warnings` | Enable compiler warnings | Recommended for diagnostics; surfaces more issues |
| `-W` | `--no-warnings` | Suppress warnings | Not useful for LSP |
| `--picky-cpp` | | Enable suppressed preprocessor warnings | Optional stricter diagnostics |
| `--compiler-trace` | | Trace compilation steps | Debug only; extremely verbose |
| `-V <v>` | `--compat=<v>` | Compatibility mode for version `<v>` | Respect `#pike` directives in project files |
| `-rT` | `--strict_types` (implicit) | Enable `#pragma strict_types` globally | **Caution**: produces massive warning spam from master.pike and stdlib; use per-file `#pragma strict_types` instead |
| `-rt` | | Runtime type checking | Not useful for LSP diagnostics (runtime only) |
| `-D<sym>[=val]` | | Define preprocessor symbol | Must replicate project-level defines for accurate diagnostics |

### Environment Variables

| Variable | Effect | LSP Relevance |
|----------|--------|---------------|
| `LONG_PIKE_ERRORS` | Show full paths in error messages | Prefer this for reliable file resolution |
| `SHORT_PIKE_ERRORS` | Show only filenames | Avoid — loses path context |
| `PIKE_BACKTRACE_LEN` | Limit backtrace depth | Minor; useful for truncating runtime error output |

## 3. Diagnostic Output Format

### Format Specification

All compiler diagnostics are emitted to **stderr** as human-readable text by default. However, **structured output is available programmatically** via `compile_string` with a custom `CompilationHandler` (see §3b below).


**Error format:**
```
<filepath>:<line>:<message>
<filepath>:<line>:Expected: <expected_type>.
<filepath>:<line>:Got     : <actual_type>.
```

**Warning format:**
```
<filepath>:<line>:Warning: <message>
```

**Fatal format:**
```
Pike: Failed to compile script.
```

### Examples from Live Testing

**Type error:**
```
/tmp/test_type_error.pike:1:Bad type in assignment.
/tmp/test_type_error.pike:1:Expected: int.
/tmp/test_type_error.pike:1:Got     : string(103..116).
Pike: Failed to compile script.
```

**Parse of the above:**
- File: `/tmp/test_type_error.pike`
- Line: `1`
- Message: `Bad type in assignment.`
- Expected type: `int`
- Actual type: `string(103..116)` (range-constrained string)

**Missing main (not an error):**
```
Error: /tmp/test.pike has no main().
```
This is printed when a file compiles successfully but has no `main()` — and the **exit code is 0**, not 1. A language server must not treat this as a diagnostic error.

**Compilation failure exit code:** 1 (errors) with `Pike: Failed to compile script.` as the final line.

### Parsing Strategy for LSP

**Preferred: use `CompilationHandler` (§3b).** Invoke `compile_string` with a custom handler via a Pike introspection script. The handler produces structured JSON. No regex parsing needed.

**Fallback: stderr text parsing (§3a).** If the handler approach is unavailable, parse stderr:

1. Read stderr line by line.
2. Match `^(.+):(\d+):(?:Warning: )?(.+)$` for primary diagnostics.
3. If the next line matches `^\1:\2:Expected: (.+)\.$`, capture expected type.
4. If the next line matches `^\1:\2:Got     : (.+)\.$`, capture actual type.
5. Ignore the `Pike: Failed to compile script.` sentinel.
6. Map to LSP `Diagnostic` with `range` set to the reported line, severity based on presence of `Warning:`.
### Stability

The format has been unchanged since at least Pike 7.8. It is stable across Pike versions and unlikely to change. However, it is not formally documented as a stable interface — it is simply the existing compiler output.

### §3b. Structured Output via CompilationHandler (Verified)

The stderr text format is **not the only option**. Pike's `compile_string(source, filename, handler)` accepts a custom `CompilationHandler` object that receives errors as structured callbacks:

```pike
object handler = class {
  array diagnostics = ({});
  void compile_error(string file, int line, string msg) {
    diagnostics += ({ (["file": file, "line": line, "message": msg]) });
  }
  void compile_warning(string file, int line, string msg) {
    diagnostics += ({ (["file": file, "line": line, "message": msg, "severity": "warning"]) });
  }
}();

mixed err = catch {
  program p = compile_string("#pragma strict_types\n" + source, filepath, handler);
};
// handler->diagnostics is now a structured array
```

Combined with `Standards.JSON.encode()`, a Pike script can emit JSON diagnostics:

```json
{"diagnostics":[{"line":2,"message":"Bad type in assignment.","file":"test.pike"},{"line":2,"message":"Expected: int.","file":"test.pike"}]}
```

**Key properties:**
- Same data as stderr output — handler receives identical file, line, and message strings
- No column information (handler receives line only, same as stderr)
- `CompilationHandler` is a documented stable API in Pike's reference manual
- Error categorization still requires message text matching ("Bad type in assignment", "Undefined identifier", etc.)
- Works with `#pragma strict_types` prepended to source

### §3c. Type Information via AutoDoc (Verified)

`Tools.AutoDoc.PikeExtractor` extracts type information from Pike source as XML:

```bash
pike -x extract_autodoc <file.pike>  # produces <file.pike>.xml
```

XML output includes:
- Method return types: `<returntype><int/></returntype>`
- Method argument types: `<argument name='a'><type><int/></type></argument>`
- Generic types: `<array><valuetype><string/></valuetype></array>`, `<mapping><indextype><string/></indextype><valuetype><int/></valuetype></mapping>`
- Inheritance: `<inherit name='Foo'><classname>Foo</classname></inherit>`
- Source positions: `<source-position file='file.pike' first-line='5'/>`

**Critical limitation: only for members with `//!` doc comments.** Undocumented members (variables and methods without a preceding `//! Doc` comment) are invisible to AutoDoc.

### §3d. Error Format Stability

Only Pike 8.0.1116 is installed on this system. The `CompilationHandler` interface (`compile_error(string, int, string)`) is documented in Pike's official reference manual and is part of the stable API. Error message strings ("Bad type in assignment.", "Expected:", "Got:") are embedded in the C compiler source (`src/program.c`) and have not changed across the Pike 8.0.x series. The stderr text format `<file>:<line>:<message>` has been unchanged since at least Pike 7.8. The `LONG_PIKE_ERRORS`/`SHORT_PIKE_ERRORS` environment variables control path length but not format structure.
## 4. Built-in Tools (`pike -x`)

| Tool | Description | LSP Relevance |
|------|-------------|---------------|
| `hilfe` | Interactive REPL. Evaluates expressions, declares variables/classes. `typeof()` works for runtime type queries. | Can be used for ad-hoc type queries but is interactive (not batch-friendly). Limited practical use for LSP. |
| `cgrep` | Context-aware grep — aware of tokens, strings, comments. | Could power a workspace symbol search, but it searches text, not AST. Marginal value over standard grep. |
| `precompile` | Convert `.pmod`/`.pike` to `.c` (C code generation). | Not relevant for LSP. |
| `dump` | Compile and dump as bytecode `.o` files. | Not relevant for LSP (no introspection of the bytecode is exposed). |
| `test_pike` | Run Pike's own test suite. | Not relevant for project LSP. |
| `extract_autodoc` | Extract autodoc documentation from Pike/C source. | Could populate hover documentation from doc comments. Worth investigating as a doc source. |
| `pike_to_html` | Syntax highlighting to HTML. | Not relevant for LSP. |

**Verdict:** None of the built-in tools directly provide AST, type, or cross-reference information. `extract_autodoc` has secondary value for documentation hover content.

## 5. Type Information Availability

### What Pike CAN Report

| Source | What it provides | Access method |
|--------|-------------------|---------------|
| Compiler errors | Expected vs. actual types at error sites | Parse stderr (see §3) |
| `typeof(expr)` at runtime | Type string for any expression: `int`, `string(101..111)`, `mapping(int(0..2):string(97..98))` | Evaluate in hilfe or `pike -e` |
| `typeof(local_var)` at runtime | Type of local variables in scope | Evaluate in hilfe |
| `indices(object)` at runtime | Member names (as strings) of an object | Evaluate in hilfe |
| `pike-list-methods` (pike-ai-kb) | Method names and signatures for a module/class | MCP tool call |
| `pike-signature` (pike-ai-kb) | Exact type signature of a specific symbol | MCP tool call |

### What Pike CANNOT Report (Critical Limitations)

| Gap | Details |
|-----|---------|
| `typeof(o->member)` returns `mixed` | Runtime introspection of object members **loses all type information**. The compiler knows the type; the runtime does not expose it. |
| No function parameter types at runtime | `typeof(my_function)` returns `function` — not the full signature with parameter types. |
| No cross-file type flow | Types determined by the compiler during whole-program analysis are not queryable after compilation. |
| No generic type instantiation | `array(int)` at compile time becomes just `array` at runtime. |
| No inheritance chain query | Cannot programmatically list what a class inherits without source analysis. |
| No unused/import analysis | No tool reports which imports are unused or which symbols are unresolved. |

### Implications for Language Server

The type information gap means:
- **Hover for locals and expressions**: Feasible via `typeof()` evaluation.
- **Hover for object members**: Fundamentally limited — `typeof(o->member)` returns `mixed`. The LSP would need source-level type inference or compiler integration to do better.
- **Completion**: Member names are discoverable via `indices()`, but types are not.
- **Diagnostics**: Compiler errors provide type mismatch details, but only after compilation.

## 6. Compilation Modes

| Mode | How | What it checks | Exit codes | LSP use |
|------|-----|----------------|------------|---------|
| Full compile + run | `pike file.pike` | Syntax, types, link | 0 (success), 1 (compile error) | **Problem**: requires `main()`, exits 0 even for "no main" |
| Syntax check | `pike -e 'compile_string(Stdio.read_file("file.pike"))'` | Syntax + type check | Throws on error | Best option for diagnostics — no main() needed |
| Preprocess only | `pike -E file.pike` | Macro expansion only | 0 | Limited — no type checking |
| Strict types | `pike -rT file.pike` or `#pragma strict_types` in file | Stricter type enforcement | Same as full compile | **Caution**: `-rT` flag causes massive warning spam from master.pike; prefer per-file pragma |
| Compatibility | `pike -V 7.8 file.pike` | Version-specific semantics | Same as full compile | Respect project's `#pike` directives |

### Recommended Diagnostic Approach

```
pike -e 'compile_string(Stdio.read_file("PATH"), "PATH")' 2>&1
```

This compiles the file without executing it, does not require `main()`, and produces the full set of type errors and warnings. It is the closest thing to a "check-only" mode that Pike offers.

### Caveats

- Files without `main()` that are compiled via `pike file.pike` produce `Error: file has no main().` with **exit code 0** — not 1. Do not treat this as a compilation failure.
- `-E` only preprocesses; it does not catch type errors. Useless for diagnostics.
- `-rT` applies strict_types globally including to master.pike and stdlib, producing hundreds of irrelevant warnings. Always use the file-local `#pragma strict_types` instead.

## 7. Runtime Introspection

### `typeof(expr)`

Returns a Pike type string representing the compile-time type of the expression, evaluated at runtime.

```
> typeof(42);
(1) Result: int
> typeof("foo");
(2) Result: string(102..111)
> typeof((<>"a", "b">));
(3) Result: multiset(string(97..98))
> typeof(mapping(int:string));
(4) Result: type(mapping(int:string))
```

**Limitation:** `typeof(o->member)` returns `mixed` for any object member. The compiler knows the declared type, but this information is not preserved into runtime representation.

### `indices(object)`

Returns the names of an object's members as an array of strings.

```
> indices(Stdio.File);
(1) Result: ({ /* 52 elements */
    "open",
    "close",
    "read",
    ...
})
```

**Limitation:** Returns only names, not types or signatures.

### `compile_string(code)`

Compiles a Pike code string without executing it. Throws on syntax or type errors. This is the programmatic gateway to syntax checking.

```pike
catch {
    compile_string("int x = \"wrong\";", "test");
};
```

The error will be thrown as an array with the same text format as compiler stderr output.

### `hilfe` (Interactive REPL)

Accessed via `pike -x hilfe`. Supports:
- Expression evaluation
- Variable and class declaration
- `typeof()` queries
- Import statements

**Not batch-friendly.** Hilfe is designed for interactive use and does not have a clean batch/eval mode. For LSP purposes, `pike -e '...'` is preferable.

## 8. What pike-ai-kb Already Covers

| MCP Tool | What it provides | LSP Feature Mapping |
|----------|-------------------|---------------------|
| `pike-evaluate` | Execute arbitrary Pike code and return results | Execute code for ad-hoc queries; not directly mapped to LSP features |
| `pike-check-syntax` | Compile a file without executing; returns success/failure + errors | **Diagnostics** — primary tool for on-save/on-type checking |
| `pike-describe-symbol` | Runtime introspection of a symbol (type, value, documentation) | **Hover** — type and doc for symbols queryable at runtime |
| `pike-list-modules` | List all installed Pike modules | **Completion** — top-level module name completion |
| `pike-list-methods` | List methods of a class or module with signatures | **Completion** — method name and signature completion; **Hover** — signature display |
| `pike-validate-example` | Compile + optionally run a code snippet; validate correctness | **Diagnostics** — for validating completions or quick-fix suggestions |
| `pike-signature` | Get exact type signature of a specific symbol | **Hover** — precise signature display; **SignatureHelp** |

### Coverage Assessment

- **Diagnostics**: Covered by `pike-check-syntax`. Parses the text error format.
- **Hover (types)**: Partially covered. `pike-signature` and `pike-describe-symbol` work for stdlib and top-level symbols. **Fails for object members** (returns `mixed`).
- **Completion (stdlib)**: Covered by `pike-list-modules` and `pike-list-methods` for standard library symbols.
- **Completion (project)**: Not covered. No tool indexes project-local symbols.
- **Go to Definition**: Not covered. No tool provides source location of symbol declarations.
- **Find References**: Not covered. No tool provides cross-reference data.
- **Rename**: Not covered. No tool provides rename semantics.
- **Workspace Symbols**: Not covered. No tool indexes project symbols.

## 9. What We Still Need to Build

### Gaps Between pike-ai-kb and a Functional LSP

| Gap | Priority | Approach |
|-----|----------|----------|
| **Project symbol indexing** | Critical | Must build. Parse `.pike`/`.pmod` files to extract top-level declarations (classes, methods, constants, inherits). No existing tool provides this. |
| **Cross-file import resolution** | Critical | Must build. Resolve `import` and `inherit` statements to actual files. Pike does not expose its resolver. |
| **Go to Definition** | High | Depends on symbol indexing + import resolution. Must trace an identifier to its declaration source. |
| **Object member type resolution** | High | The `typeof(o->member) → mixed` limitation means we need source-level type inference. Parse the class definition to extract member types from declarations. |
| **Project-aware completion** | High | stdlib completion is covered; project-local completion requires the symbol index. |
| **Diagnostic aggregation** | Medium | `pike-check-syntax` handles single-file checking. Multi-file impact analysis (change file A → does file B break?) requires orchestration. |
| **Hover documentation from autodoc** | Medium | `extract_autodoc` could feed doc comments into hover content. Needs integration. |
| **Find References** | Medium | Text-based search with `cgrep` or similar. True semantic references require more than Pike provides. |
| **Rename** | Low | Text-based with heuristics. Pike has no rename refactoring support. |
| **Code actions / quick-fix** | Low | No foundation in Pike or pike-ai-kb. Would be entirely custom. |

### Architecture Implication

The LSP must maintain its own **project model** (symbol table, import graph, type cache) built by parsing source files. Pike and pike-ai-kb cannot provide this on demand — they lack cross-file visibility and lose type information at runtime boundaries.

## 10. Key Findings for Tier-3 Scope

### Can Pike Provide Type Information for Hover?

**Partially.**

| Context | Available? | Source |
|---------|-----------|--------|
| Local variable type | Yes | `typeof(var)` in runtime eval |
| Expression type | Yes | `typeof(expr)` in runtime eval |
| Function return type (stdlib) | Yes | `pike-signature` |
| Function parameter types (stdlib) | Yes | `pike-signature` |
| Object member type | **No** | `typeof(o->member)` returns `mixed` |
| Inherited member type | **No** | Same limitation |
| Generic instantiation | **No** | `array(int)` → `array` at runtime |

**Verdict:** Hover works for stdlib and for local/inline expressions. It fails for any object member access. Source-level parsing is required to cover object members, which is a large portion of practical Pike code.

### Can Pike Provide Diagnostics?

**Yes.**

`pike-check-syntax` (or raw `compile_string()`) provides full syntax and type checking for individual files. The error format is stable and parseable (see §3). This is sufficient for tier-3.

**Caveats:**
- Errors reference line numbers only (no column information).
- The error format is text, not structured — parsing is required.
- Cross-file errors (import not found, etc.) surface during compilation but only for the file being compiled.

### Can Pike Provide Completion?

**Partially.**

| Context | Available? | Source |
|---------|-----------|--------|
| Standard library modules | Yes | `pike-list-modules` |
| Standard library methods | Yes | `pike-list-methods` |
| Standard library signatures | Yes | `pike-signature` |
| Project-local symbols | **No** | No tool indexes project files |
| Object members (names) | Yes | `indices(object)` |
| Object members (types) | **No** | No type info available at runtime |
| Keyword completion | N/A | Static list — trivially implementable |

**Verdict:** stdlib completion is well-covered. Project-local completion must be built from scratch using source parsing.

### Summary of Tier-3 Scope Implications

1. **Diagnostics are achievable** with modest effort (parse stderr, map to LSP Diagnostic).
2. **Hover requires a two-tier approach**: use `pike-signature`/`pike-describe-symbol` for stdlib; build source-level type extraction for project code and object members.
3. **Completion requires a project symbol index** — the single largest piece of new infrastructure.
4. **Navigation (go-to-def, find references)** is entirely on us to build; Pike provides nothing.
5. **The `typeof() → mixed` limitation for object members is the fundamental constraint** — it means any non-trivial hover or completion for project code requires parsing Pike source, not querying Pike at runtime.
