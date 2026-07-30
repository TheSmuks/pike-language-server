# Corpus parse triage

Every file the shipped grammar fails to parse, with Pike's own verdict on it.

Method: `bun run scripts/roxen-corpus-parse.ts --json` for the failing set and
the ERROR/MISSING node it produces, then the lab oracle for the verdict:

```sh
docker run --rm -v /tank/projects/roxen-6.1:/corpus:ro pike-lsp/roxen-lab:6.1 \
  oracle --json /corpus/<path>
```

Corpus pinned at Roxen `4f1d04f82b3ea95f680cddab552d4912990c9c2f`; oracle built
on Pike v8.0.1116. Recorded 2026-07-30 against 442 files, 14 failing. Named
class expressions have since been fixed upstream, taking it to 11.

## Summary

| Classification | Files | Status |
|---|---|---|
| Grammar gap — named class expressions | 3 | **fixed** upstream |
| Grammar gap — iterator `for` | 1 | open |
| Grammar gap — unclassified MISSING | 1 | open |
| Macro-expansion gap | 8 | open |
| Genuinely invalid source | 1 | correct as-is |

**Pike accepts 13 of the 14.** So "Roxen shows syntax errors" is almost never
Roxen being unusual Pike — it is the grammar meeting constructs it does not
model, and, more often, meeting macros that the compiler would have expanded
first.

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

### Iterator `for` loop (1 file)

| File | Line | Source |
|---|---|---|
| `server/base_server/prototypes.pike` | 2468 | `for (keys; string key;) {` |

Pike's three-clause `for` also has an iterator form, `for (iterable; type var;)`,
which the grammar does not model. Oracle: `semantic`.

### Unclassified structural failure (1 file)

| File | Line | Node |
|---|---|---|
| `server/etc/modules/DBManager.pmod` | 331 | MISSING, at `protected class SqlFileSplitIterator` |

Oracle: `semantic` — the file is valid Pike. A MISSING node means the parser
inserted a token to recover, so the defect is upstream of the reported position
and needs narrowing before a grammar change. Not yet reduced to a minimal case.

## Macro-expansion gaps

The grammar sees a macro invocation where the compiler would have seen the
expansion. Fixing these means either expanding Roxen's macros or teaching the
grammar to tolerate a macro call in these positions; neither is in scope for
this change, and none of them is a defect in the grammar's model of Pike.

| File | Line | Construct |
|---|---|---|
| `server/base_server/global_variables.pike` | 53, 65, 110, 179, 231 | `function(DEFVAR) defvar = o->defvar;` — a macro inside a `function(…)` type |
| `server/base_server/hosts.pike` | 71, 77, 93, 121, 148 | `ISIP(ip, mixed foo; …)` — macro whose arguments are statements |
| `server/base_server/roxenloader.pike` | 1428 | `report_debug(…)` under `#ifdef`, spanning a directive boundary |
| `server/config_interface/actions/cachestatus.pike` | 189, 229, 327, 333, 346 | `"<tr " BODY_TR_ATTRS ">"` — a macro between adjacent string literals |
| `server/etc/modules/RXML.pmod/module.pmod` | 4540, 4546, 4565, 4571, 4708 | `DO_IF_DEBUG (+ sprintf(…))` and `iter-- DO_IF_DEBUG (, …)` — macro arguments that begin with an operator |
| `server/etc/roxen_master.pike` | 676 | assignment inside an `#ifdef`-guarded block |
| `server/modules/proxies/proxy.pike` | 209, 220, 618, 653, 661 | `CASE_ASSIGN(x)` as a `case` label; `SERVER_DEBUG(…)` as a bare statement |
| `server/protocols/http.pike` | 3249 | `LOG_HANDLE_END()` as a statement with no `;` |

`proxy.pike` also fails the preprocessor outright: it does
`#include <proxyauth.pike>`, splicing in an entire Pike program textually.

## Genuinely invalid source

| File | Line | Verdict |
|---|---|---|
| `server/modules/graphics/rimage/plugins/scale.pike` | 17, 25 | `syntax` |

```
scale.pike:17: syntax error, unexpected TOK_RETURN, expecting TOK_LEX_EOF or ';'
scale.pike:25: syntax error, unexpected TOK_RETURN, expecting TOK_LEX_EOF or ';'
```

Lines 16 and 24 end a `m->set_channel(…)` call with no semicolon. Pike rejects
the file and so does the grammar; both are right. This is a bug in Roxen's own
source, and the grammar reporting an error here is correct behaviour — the
corpus baseline should keep expecting exactly one failure for this file.

## Status

Triage is complete: every failing file is classified and carries the oracle's
verdict. Named class expressions are fixed upstream and the WASM here is
rebuilt, so `corpus-baseline.json` now records 11. The iterator `for` loop and
the `DBManager.pmod` MISSING are untouched, as are the eight macro-expansion
gaps. The floor is 1: `scale.pike` is invalid Pike and must keep failing.
