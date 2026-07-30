# Corpus parse triage

Every file the shipped grammar fails to parse, with Pike's own verdict on it.

Method: `bun run scripts/roxen-corpus-parse.ts --json` for the failing set and
the ERROR/MISSING node it produces, then the lab oracle for the verdict:

```sh
docker run --rm -v /tank/projects/roxen-6.1:/corpus:ro pike-lsp/roxen-lab:6.1 \
  oracle --json /corpus/<path>
```

Corpus pinned at Roxen `4f1d04f82b3ea95f680cddab552d4912990c9c2f`; oracle built
on Pike v8.0.1116. Recorded 2026-07-30 against 442 files, 14 failing.

## Summary

| Classification | Files |
|---|---|
| Grammar gap | 5 |
| Macro-expansion gap | 8 |
| Genuinely invalid source | 1 |

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

Oracle: `semantic`, `ok`, `semantic` respectively. One grammar rule fixes all
three, which makes this the highest-value fix in the set.

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
verdict. The upstream grammar work (named class expressions, the iterator `for`
loop, and narrowing the `DBManager.pmod` MISSING) has **not** been done, and the
WASM has not been rebuilt — so `corpus-baseline.json` still records 14.
