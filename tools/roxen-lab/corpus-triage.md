# Corpus parse triage

Every file the shipped grammar fails to parse, with Pike's own verdict on it.

Method: `bun run scripts/roxen-corpus-parse.ts --json` for the failing set and
the ERROR/MISSING node it produces, then the lab oracle for the verdict:

```sh
docker run --rm -v /tank/projects/roxen-6.1:/corpus:ro pike-lsp/roxen-lab:6.1 \
  oracle --json /corpus/<path>
```

Corpus pinned at Roxen `4f1d04f82b3ea95f680cddab552d4912990c9c2f`; oracle built
on Pike v8.0.1116. Recorded 2026-07-30 against 442 files, 14 failing. Grammar
fixes since have taken it to **5**.

## Summary

| Classification | Files | Status |
|---|---|---|
| Grammar gap — named class expressions | 3 | **fixed** upstream (v1.4.0) |
| Grammar gap — declaration in a `for` condition | 1 | **fixed** upstream (v1.5.0) |
| Grammar gap — unclassified MISSING | 1 | open |
| Macro-expansion gap | 8 | **4 fixed**, 3 open, 1 reclassified |
| Genuinely invalid source | 2 | correct as-is |

**Pike accepts 12 of the 14.** So "Roxen shows syntax errors" is almost never
Roxen being unusual Pike — it is the grammar meeting constructs it does not
model, and, more often, meeting macros that the compiler would have expanded
first. The two exceptions are Roxen's own typos, one of them hidden inside an
`#ifdef` that is never on.

## Grammar gaps

The grammar rejects source Pike accepts. These belong upstream in
`tree-sitter-pike`, and return here as a rebuilt `server/tree-sitter-pike.wasm`
with regenerated goldens.

### Named class expressions (3 files)

Pike allows `class Name { … }` in expression position, optionally called
immediately. The grammar appears to admit only anonymous `class { … }` there.

| File | Line | Source |
|---|---|---|
| `server/config_interface/actions/patcher.pike` | 19 | `Write_back wb = class Write_back { … }` |
| `server/etc/modules/RoxenRPC.pmod/Client.pike` | 131 | `lock = class lambda17{ void lock(){}}();` |
| `server/modules/tags/rxmltags.pike` | 73 | `private object sexpr_funcs = class SExprFunctions { … }` |

Oracle: `semantic`, `ok`, `semantic` respectively.

**Fixed** in tree-sitter-pike `d96749b`. All three parse; the corpus went from
14 failures to 11 with nothing regressed.

The fix is worth reading before attempting the remaining grammar gaps, because
the obvious version of it is wrong. Adding `optional(field('name', …))` to
`anon_class` fixes all three files and keeps the grammar's own suite green —
and silently breaks `server/modules/scripting/webapp.pike`, which parsed
before:

```pike
#if 1
class Foo { int x; }
#else
constant z = 1;
#endif
```

Once a named class is a legal expression, `class Foo { … }` with no trailing
`;` can start an `expression_statement`, which then completes by running
through `preproc_conditional_expr` into the `#else` branch and consuming the
semicolon belonging to `constant z = 1;`.

That ambiguity cannot be resolved by precedence. Verified rather than assumed:
`prec.dynamic(2)` and `(20)` on `class_decl`, `(-1)` and `(-10)` on
`anon_class`, and `(-5)` on `preproc_conditional_expr` all leave the parse
byte-identical, because tree-sitter settles this conflict statically instead of
keeping both parses alive for GLR. Declaring
`[$.preproc_conditional_expr, $.declaration]` is reported as an unnecessary
conflict, so that is not the divergence point either. (This is why the same
`prec.dynamic` trick that fixed `variable_decl` and `function_decl` in 1.3.2
and 1.3.3 does not transfer — there, both parses do reach the same reduction
point.)

The shipped fix removes the ambiguity instead of trying to outrank it: a
separate `named_class_expr` node, reachable only from the right-hand side of an
assignment or initialiser, where a statement can never begin. `class Foo { … }`
standing alone is therefore still only ever a `class_decl`. A sibling
`class_instantiation` node covers `= class Foo { … }()`, which means something
different from `= class Foo { … }` — an object rather than a program.

**The lesson for the remaining gaps:** the grammar's own 232-test suite went
green on a change that broke real code. Always re-run
`bun run scripts/roxen-corpus-parse.ts --check` with the rebuilt WASM; its
`REGRESSED:`/`FIXED:` output is why the baseline records paths and not a count.

### Declaration in a `for` condition (1 file)

| File | Line | Source |
|---|---|---|
| `server/base_server/prototypes.pike` | 2468 | `for (keys; string key;) {` |

**Fixed** in tree-sitter-pike `v1.5.0`. Oracle: `semantic`.

This was first recorded here as an "iterator `for` loop", reading `for (keys;
…)` as iteration over `keys`. That was wrong, and the correction matters
because it changes what the grammar had to model. Pike has no iterator `for`.
This is the ordinary three-clause form: `keys` is the initialiser (evaluated
and discarded), and `string key` is a *declaration in the condition*, with no
initialiser.

Declarations are legal there because Pike does not special-case conditions per
statement — `comma_expr` itself carries `simple_type2 local_name_list`
(language.yacc), so a declaration is valid in every position taking a comma
expression. `local_name_list` does not require an initialiser, which is why
`string key` alone parses. Confirmed against pike v8.0.1116: `if (string x)`,
`while (string x)` and `for (0; string k;)` all compile.

The grammar had `cond_decl` for `if`/`while`/`switch`/`catch` but required an
initialiser, and `for`'s condition accepted no declaration at all. Both were
fixed: the initialiser is now optional, and `for`'s condition takes `cond_decl`.

Worth knowing about the Roxen line itself: **it compiles to a loop that never
runs.** An uninitialised declaration evaluates to 0, so the condition is false
on the first test — measured, not inferred (`for (keys; string key;) { n++; }`
leaves `n == 0`). Pike accepts it with only an unused-variable warning. So
`find_in_misc_forwarded`'s `case_insensitive` branch is dead code. That is a
Roxen defect, not a grammar one, and is out of scope here — but it is the kind
of thing this server should eventually be able to point out.

### Unclassified structural failure (1 file)

| File | Line | Node |
|---|---|---|
| `server/etc/modules/DBManager.pmod` | 331 | MISSING, at `protected class SqlFileSplitIterator` |

Oracle: `semantic` — the file is valid Pike. A MISSING node means the parser
inserted a token to recover, so the defect is upstream of the reported position.

**Classified: the modifier block is modelled as a statement block.** Minimal
reproduction, four lines:

```pike
private
{
  string v;
  protected class Inner { int y; }
}
```

The inserted token is a `;`, and its parent is a `local_declaration` whose
children are `modifier type identifier`. The enclosing node is a `block`
spanning lines 29–986 — the body of `private { … }` at line 28, which the
grammar admits through `declaration`'s `$.block` alternative.

Pike's modifier block groups *declarations*, not statements. The braces do not
open a scope, which is measurable rather than inferred: pike compiles
`{ int hidden = 3; } int main(){ return hidden == 3 ? 0 : 1; }` and the
variable is visible outside the braces (exit 0). It also accepts the
reproduction above, warning only that `v` is unused.

A class declaration, meanwhile, is genuinely not a statement — pike rejects
`int main(){ class Inner { int y = 7; } return 0; }` with *syntax error,
unexpected TOK_RETURN*. So the grammar is right to want a `;` inside a `block`
and wrong to have routed this body there.

The fix is a `modifier_block` rule bodied like `class_body`
(`seq('{', repeat($.declaration), '}')`), replacing `$.block` in `declaration`.
**Three attempts at it all hit unresolvable LR conflicts** and were reverted:

- Admitting `$._stmt` alongside `$.declaration` collides with
  `macro_statement`, whose body is a `block`.
- Keeping the `';'` alternative collides `_stmt`'s `;` with
  `class_body_repeat1`'s.
- Dropping both still collides `identifier_expr` / `macro_invocation` /
  `macro_invocation_stmt` / `macro_statement`.

Routing `_definition`'s bare `{ … }` through the new rule additionally fails
54 of the grammar's own 234 corpus tests, which wrap expression snippets in a
top-level bare block — a construct pike rejects outright
(`{ (int)1.5; }` at file scope is a syntax error, modifier or not), so those
fixtures would have to be rewritten first.

This is one file of 442 and the corpus floor is 1 regardless (see below), so
it is parked rather than forced. Read
[[tree-sitter-pike-conflict-resolution]] before picking it up.

## Macro-expansion gaps

The grammar sees a macro invocation where the compiler would have seen the
expansion. Four of the original eight are now fixed by teaching the grammar the
positions a macro call can occupy; the rest are recorded below with what each
would still cost.

| File | Line | Construct | Status |
|---|---|---|---|
| `server/base_server/global_variables.pike` | 53, 65, 110, 179, 231 | `function(DEFVAR) defvar = o->defvar;` — a macro inside a `function(…)` type | **fixed** |
| `server/config_interface/actions/cachestatus.pike` | 189, 229, 327, 333, 346 | `"<tr " BODY_TR_ATTRS (row) ">"` — a macro between adjacent string literals | **fixed** |
| `server/modules/proxies/proxy.pike` | 209, 220, 618, 653, 661 | `CASE_ASSIGN(x)` as a `case` label; `SERVER_DEBUG(…)` as a bare statement | **fixed** |
| `server/protocols/http.pike` | 3249 | `LOG_HANDLE_END()` as a statement with no `;` | **fixed** |
| `server/base_server/hosts.pike` | 71, 77, 93, 121, 148 | `ISIP(ip, mixed foo; …)` — macro whose arguments are statements | open |
| `server/etc/modules/RXML.pmod/module.pmod` | 4708, 5705, 5710 | `iter-- DO_IF_DEBUG (, debug_iter++)` and `COND_PROF_ENTER(mixed id=…, …)` | open |
| `server/etc/roxen_master.pike` | 676 | an `if` whose condition and body sit on opposite sides of an `#else` | open |
| ~~`server/base_server/roxenloader.pike`~~ | 1429 | **not a grammar gap** — see below | reclassified |

The four fixes, all in `tree-sitter-pike`:

- `_function_type` accepts `'(' identifier ')'`, for a macro standing in for a
  whole signature (`#define DEFVAR mixed...:object`). The `:` that the real
  signature form requires is what keeps the two apart.
- `string_concat` accepts a `macro_invocation` among its elements, so a
  function-like macro can sit between literals as long as it expands to a
  string.
- `macro_argument_fragment` accepts an argument that begins with a binary
  operator — `DO_IF_DEBUG (+ sprintf (…))` splices onto what precedes the
  invocation. Ranked below `_expr` so `(-x)` stays unary negation.
- `macro_invocation_bare_stmt` accepts an invocation as a statement with no
  `;`, for macros whose expansion carries its own terminator. This one needs
  three declared conflicts and `prec.dynamic(-2)`: static precedence looks like
  it works and silently breaks `macro_statement` (7 of the grammar's own tests),
  because tree-sitter then settles `identifier • '('` before GLR ever sees it.
  The empty argument list stays out of `macro_argument_list` and lives on the
  bare form alone — allowing it there makes `int foo();` a macro invocation as
  readily as a function prototype.

`proxy.pike` also does `#include <proxyauth.pike>`, splicing in an entire Pike
program textually — that turned out not to block the parse.

### roxenloader.pike is invalid source, not a macro gap

Line 1429 ends `report_debug("DESTRUCT(%O)\n%s\n", x, describe_backtrace(backtrace()))`
with a **colon** instead of a semicolon. The oracle agrees the grammar is right
to reject it:

```
syntax error, unexpected ':', expecting TOK_LEX_EOF or ';'
```

It compiles today only because the whole function sits under
`#ifdef TRACE_DESTRUCT`, which is off, so the compiler never reads it. That
makes it a second entry in "genuinely invalid source" — a Roxen defect the
grammar surfaces correctly — and it raises the corpus floor from 1 to 2.

## Genuinely invalid source

| File | Line | Verdict |
|---|---|---|
| `server/modules/graphics/rimage/plugins/scale.pike` | 17, 25 | `syntax` |
| `server/base_server/roxenloader.pike` | 1429 | `syntax` — `:` where a `;` belongs (see above) |

```
scale.pike:17: syntax error, unexpected TOK_RETURN, expecting TOK_LEX_EOF or ';'
scale.pike:25: syntax error, unexpected TOK_RETURN, expecting TOK_LEX_EOF or ';'
```

Lines 16 and 24 end a `m->set_channel(…)` call with no semicolon. Pike rejects
the file and so does the grammar; both are right. This is a bug in Roxen's own
source, and the grammar reporting an error here is correct behaviour — the
corpus baseline should keep expecting exactly one failure for this file.

## The preprocessor is now modelled, not swallowed

Separate from the parse failures above, and worth more than all of them: a
`#define` used to be a single opaque `preprocessor_directive` token, so no
identifier inside any macro body had a node or a position, and hover,
definition, completion and references could answer nothing there.

`preproc_define` now carries `name`, `parameters` and `body` fields, with the
body a permissive token sequence — a macro body is not necessarily an
expression or a statement. Across this corpus that is **1403 defines, every one
of them, exposing 4479 identifiers** that no LSP request could previously see.

Three external-scanner tokens make it work, because all three depend on
something the LR lexer cannot: whether a paren abuts the macro name
(function-like or not), where the logical line ends, and what to do with body
punctuation. The scanner must consume line continuations itself — tree-sitter
skips anonymous whitespace extras inside the generated lexer, so once the
scanner declines a position it is not consulted again until after the next real
token, and a body token on a spliced line would never reach it.

`string_literal` gained `\`+newline as a splice while proving this out:
`pike -e 'write("%O", "a\<newline>b")'` prints `"ab"`, and cgi.pike's
`#define LONGHEADER` relies on it.

## Status

Triage is complete: every failing file is classified and carries the oracle's
verdict. `corpus-baseline.json` now records **5 failing of 442**, down from 9.

Fixed since the last revision: the four macro-position gaps listed above.
Reclassified: `roxenloader.pike` is invalid Pike, not a macro gap.

Still open: `DBManager.pmod`'s modifier block (classified, every route to a fix
hit an LR conflict); `hosts.pike`'s declaration-bearing macro arguments, which
`macro_argument_stmts` deliberately excludes because declarations collide with
its type and parameter arguments; `RXML.pmod`'s macro juxtaposed onto a `for`
update clause with an empty leading argument; and `roxen_master.pike`'s `if`
split across an `#else`, which needs the grammar to model conditional
compilation as structure rather than as invisible extras.

The floor is 2, not 1: `scale.pike` and `roxenloader.pike` are both invalid
Pike and must keep failing.
