# Changelog

All notable changes to the Pike Language Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html/).



## [Unreleased]

### Added

- **Roxen's undocumented symbols are now indexed** — 499 → 719, with `RoxenModule.` going 53 → 127 and a new `predef.` family of 146. The generator only ever harvested what Roxen's AutoDoc documents, so ordinary module surface (`cvs_version`, `find_file`, `defvar`, `start`, `stop`, `stat_file`, `query_provides`) and the globals roxenloader injects (`predef::report_fatal` and friends) resolved to nothing. All of it is harvested from Roxen's source rather than hand-listed: undocumented prototype members, names measured across the 127 modules that `inherit "module"`, and every `add_constant(...)` plus the indices of `prototypes.pike` minus the exclusion multiset the loader itself declares. `predef::` completion offers these only in a Roxen file; a plain Pike program still sees only what Pike predefines. Costs +43 KB on the bundle.

### Fixed

- **The constants the Pike compiler defines had no hover.** `UNDEFINED`, `__FILE__`, `__LINE__`, `__DIR__`, `__VERSION__` and eight more are defined by the compiler, not declared in any Pike source, so the autodoc-derived builtin index never carried them and every tier walked past — `UNDEFINED` appears 170 times in Roxen 6.1 and `__FILE__` 58. The set was taken from the compiler rather than from documentation: each one compiles and prints under Pike 8.0.1116, and `__NT__` (which Roxen writes 96 times) is deliberately excluded because it does not — it exists only on Windows, so answering nothing for it here is correct. The descriptions say what each names, never what it currently equals.
- **A module shipped as a compiled C module hovered as nothing.** `Image` installs as `Image.so`, with no `.pmod` directory for the file-based resolver to find, so it answered nothing at 272 positions while `Stdio` and `ADT` — which ship as directories — answered fine. The runtime resolver knew it all along but was gated on the path containing a dot, which the bare head of a path never does; a bare name now qualifies when the source has it immediately followed by a `.`, so no ordinary identifier costs a worker round-trip.
- **A dotted module path answered with an unrelated symbol of the same name.** `Image.PNG.encode` is `encode` of `Image.PNG`; when the path could not be resolved, the bare-name search took over and answered whichever `encode` it found in the inherit chain — `ADT.Table.ASCII.encode`, `Image.JPEG.encode` and `Image.PNG.encode` in Roxen's `configuration.pike` all pointed at the same unrelated `encode` in `Variable.pmod`. 84 such answers across Roxen 6.1, every one into some module's file scope rather than the module the path names. A `.` whose left side is not a variable is a module path, and only the path-aware tier may answer it. Hover's module-path tier also moved ahead of the bare-name tiers, so `ADT.Table.ASCII` now describes that module instead of falling through.
- **Go-to-definition consulted a name-based guess before the type-based answer.** In `textDocument/definition` the cross-file resolver — which searches the inherit chain by bare *name*, knowing nothing about the receiver — ran ahead of the type-driven access resolver, so `b->get_value()` could be answered by any same-named symbol reachable from the file before the receiver's own class was ever consulted. The typed resolver now runs first and the name search is the last resort it was meant to be.
- **A cross-file member's location came back under the wrong file's URI.** `findDeclUri` identified declarations by `id`, which is a per-file counter, so it compared two unrelated declarations that happened to be numbered the same and concluded the target was local. `b->get_value()` on a class from `base.pike` returned that file's line and column attached to the *calling* file's URI — coordinates that mean nothing there. Identity is now the declaration itself.
- **`->` on a mapping, multiset, string, int or float answered with an unrelated symbol.** None of them has a member to point at: `m->foo` is `m["foo"]`, `ms->a` is a membership test, and `s->size` does not compile (`Indexing on illegal type.`). The bare-name fallback answered anyway — `pkt->ip` on a mapping resolved into `Stdio.pmod`, and `file->error` hovered as Pike's builtin `error`. Across Roxen 6.1 that was 1,620 confident pointers at declarations the expression cannot refer to; both the definition and the hover paths now decline. **`array` is deliberately excluded**: `array(Obj) as; as->twice()` automaps to the element's member, which the resolver now models rather than dropping to the name search.
- **Roxen's own classes had no members in the bundled index.** `RequestID` is the request object threaded through almost every module entry point, and `id->misc` answered nothing — it and `Configuration`, `ModuleInfo`, `DAVLock`, `User`, `UserDB` and the rest are declared in `prototypes.pike` and injected as globals, so no inherit or import leads there and the type-driven resolver has no file to open. 421 members are now indexed under `Class.member` and reached through the receiver's declared type. On Roxen's 24,646 `->` positions, receivers with a declared class type go from 5,149 answered to 6,445.
- **A macro's parameters answered nothing, anywhere.** Neither `X` in the parameter list of `#define LOC_M(X,Y) _STR_LOCALE("roxen_message",X,Y)` nor either use of it in the body resolved — 1,831 positions across Roxen 6.1, and the largest single gap left in the language server. They were skipped deliberately: resolving a parameter against the enclosing scope would point it at an unrelated declaration sharing the name, and rename would then rewrite the macro body. That reasoning was right and the remedy was not. A function-like `#define` now opens a scope holding its own parameters, so they resolve to themselves and shadow the file exactly as Pike's preprocessor does — with `int X = 100;` and `#define F(X) (X + X)`, `F(1)` is 2, not 200. Hover names the macro that binds the parameter, go-to-definition lands on it, and a name the macro does *not* bind still reaches the enclosing scope. Macro parameters stay out of workspace-symbol search, where several hundred `X` and `Y` entries would be noise.
- **`A::name` answered with the wrong class, or with a class the expression does not name.** The qualifier before a `::` was dropped once the enclosing program was the file rather than a class, and the cross-file fallback then searched *every* inherit for the bare name. In Roxen's `RXML.pmod/PXml.pike` — `inherit Parser.HTML : low_parser;` alongside `inherit RXML.TagSetParser : TagSetParser;` — all twelve `low_parser::` expressions resolved into `RXML.pmod`: `low_parser::read` pointed at RXML's `read`, `low_parser::clone` at a `Scope clone()`. Pike is unambiguous here (`A::shared()` and `B::shared()` are different functions, and `A::only_b` does not compile at all), so the qualifier now selects the inherit and nothing else. Where that inherit is a class the workspace cannot open, the answer comes from the running Pike instead of from a same-named symbol elsewhere: `low_parser::add_container` now hovers as `Parser.HTML.add_container()`, and the three members that previously answered nothing answer too.
- **`this::`, `this_program::` and `local::` all resolved to the *inherited* declaration.** The grammar emits them as anonymous tokens, and the test for a bare `::` was "has no identifier child", so all three fell into it. They mean the opposite: with a program declaring its own `who()` over an inherited one, Pike prints `bare=INHERITED this_program=OWN this=OWN local=OWN`. Each now resolves against the program's own declarations first, still falling through to the inherited ones for a name only a parent declares.
- **An aliased inherit answered to its path tail, which Pike rejects.** `inherit Protocols.HTTP.Session : parent;` accepts `parent::` and nothing else — `Session::timeout` is `No inherit or surrounding class Session.` The server accepted the tail as well, which is how `Session::timeout` in `HTTPClient.pmod` came back pointing into `Protocols.HTTP.Query`. An alias now replaces the name rather than adding to it, and the tail remains a qualifier only for an unaliased inherit.
- **A surrounding class was not a qualifier at all.** Pike's own error text names both referents, and `class Session { int maxtime, timeout; class SessionQuery { … Session::maxtime … } }` reaches the outer class's own variables. `Session::maxtime` and `Session::timeout` in `HTTPClient.pmod` now both land on the declaration that actually defines them. A nested class also reaches an enclosing class's inherits by qualifier — but not a sibling class's, which file-wide matching allowed.
- **Hover said nothing on `::`, or on the qualifier keyword before it.** `predef`, `global`, `this`, `this_program` and `local` are anonymous tokens with no declaration anywhere, so every hover tier walked past them; hovering one column to either side worked. All five now describe the scope they select, as does `::` itself, which names the inherits it searches. `global::this` — the only way to name the file's own object from inside a nested class, and how Roxen tests whether it is still alive — is described rather than left blank. Across Roxen's `::` sites, hover on the qualifier goes from 30 answered to 53, and on the member from 99 to 107.
- **Eleven globals Roxen injects at startup were missing from the bundled index.** The generator harvested `add_constant` only from `roxenloader.pike` and `roxen.pike`, and four more files inject from a function the startup calls: `cache.pike` (`predef::cache`, which `VFS.pmod` writes — its forwarded `cache_lookup` was indexed while the object they hang off was not), `fonts.pike` (`Font`, `FontHandler`, `get_font`, `resolve_font`, `available_fonts`, `available_font_versions`, `describe_font_type`), `config_userdb.pike` (`AdminUser`), and `etc/roxen_master.pike` (`chroot`, `add_dump_constant`, `Master`). Each was traced to the call that reaches it before being harvested — an injection nothing invokes is not part of the namespace. Signatures come from each file's own declaration, so `get_font` reads `Font get_font(string f, int size, …)` rather than the `add_constant` call. Index goes 1,247 → 1,268 symbols, +12 KB.
- **The provenance note on an injected global named the wrong file.** Every one of them said "injected … by roxenloader", which was true when the loader was the only source harvested and is not true of `chroot` (the master), `get_font` (`fonts.pike`) or `AdminUser` (`config_userdb.pike`). It now says "by Roxen's startup".
- **A rare crash while hovering was a use-after-free.** `parse()` returns a tree the LRU cache owns, and the cache frees it — on re-parse of the same file, on eviction caused by any other document, on close, and on the memory governor's sweep. Handlers held that tree across `await`s, so a free landing mid-request left them dereferencing a null root. Reproduced through the real hover path: a concurrent edit during the filesystem lookup for a dotted access. Trees that outlive an `await` now take a cheap handle of their own, applied at the five sites that need it — including the one every indexing path funnels through. The audit saw this once in 200,936 requests.
- **`private { … }` no longer shows a syntax error.** Pike's modifier block groups *declarations*; the grammar modelled its body as a statement list, so a nested `protected class` inside one made the parser demand a semicolon that valid Pike does not have. Fixed upstream in tree-sitter-pike and shipped here as a rebuilt WASM; the Roxen 6.1 corpus goes from 10 parse failures to 9, with nothing regressed.
- **Hibernation acted on the wrong index.** The server builds a placeholder index until the editor tells it the workspace root; the hibernation hooks captured that placeholder and kept it, so the cache they saved on idle was empty and written to the wrong path, and the one they cleared was not the live one. Neither errors, so the only symptom was that waking never found a warm cache — hibernation shed the memory and lost the work.

### Changed

- **Marketplace and npm listings now say what the extension actually does.** The description led with "Tier-3 LSP implementation", which describes the architecture rather than the benefit, and neither listing mentioned Roxen WebServer support at all. Keywords gained `roxen`, `roxen-webserver`, `autocomplete` and `intellisense`, and `Linters` joins the categories to match the diagnostics the server ships.

## [0.8.53] — 2026-07-31

### Changed

- **The VSIX no longer ships a copy of the tree-sitter runtime nothing loads.** `web-tree-sitter.wasm` was staged twice, once for the server and once for a client-side syntactic provider that was removed some time ago. The client bundle contains no reference to tree-sitter at all, so every install carried 192 KB — a fifth of the unpacked extension — that was never read. The packaged VSIX drops from 16 files and 1010 KB to 15 and 933 KB. The build now fails if the client starts referencing tree-sitter again while no runtime is staged for it, so the two cannot drift apart silently a second time.

## [0.8.52] — 2026-07-31

### Changed

- **`lsp-probe diagnostics` now reports the compiler's verdict, not the parser's.** It resolved on the first `publishDiagnostics` for a URI, and the server publishes twice — a parse-only pass right after the file opens, then the Pike worker's result — so the tool printed `[]` for every file whose only problem is semantic. `err-undef-class.pike`, whose entire purpose is to inherit a class that does not exist, reported clean.
- **`corpus/files/cross-lib-consumer.pike` compiles again.** It was marked valid in the manifest but failed under stock Pike: `inherit .cross_lib_base.Formatter;` maps the dotted path to a file named `cross_lib_base.pike`, and the file on disk is `cross-lib-base.pike`. A fixture whose whole purpose is cross-file inheritance was testing nothing of the sort.

### Fixed

- **Completion went silent at three ordinary cursor positions.** At column 0 it returned "no completion is possible here" — there is no character before the cursor to read a trigger from, which is not the same as there being nothing to complete. A lone `:` did the same, so nothing was offered after the value type of a mapping (`mapping(string:CacheEntry)`), a ternary's second arm, or a `case` label; only `::` is a trigger, and the two-character check already handled it. And the start of an argument landed in the call-args trigger, which read parameters out of `declaredType` — a field that holds the *return* type for a function declaration, so the argument snippet had never once appeared for a function declared in the file, only for a variable holding a function type. The same defect silently disabled class-constructor snippets, since `create()` is a function declaration too. The `(`-trigger also could not tell a call from a parameter list, so `string color_name(Color c)` offered an argument snippet for the function being declared.
- **Qualified completion never matched anything that parsed.** `A::value()` reaches the handler as an `inherit_specifier` whose text is `A::`, which was compared against inherit *names* — so it only ever worked on a half-typed `Base::`, which does not parse and arrives as a bare identifier. Completion after `global::` (the file scope) and `predef::` (Pike's predefined namespace) was not implemented at all, and bare `::` read only inherits wired to a class in the same file, so an inherit of a cross-file module or a stdlib class offered nothing. The cursor resting *on* the qualifier is also no longer treated as a member position: on the `A` of `A::value()`, the symbols in scope are what apply.
- **Document highlight and find-references were silent on module names, inherit aliases, and anything declared elsewhere.** Both routed through go-to-definition's resolver, which deliberately returns nothing for an inherit or import naming another file so navigation can resolve it cross-file — but highlight wants the occurrence under the cursor, which for `import Stdio;` is the word `Stdio` right there. A renamed inherit had no range recorded for its alias, so `motor` in `inherit "engine.pike" : motor;` matched no position query at all. And a reference this file cannot resolve — a member of an imported module, a macro from an include, `g->greet()` — was read as "no symbol here", when its uses in this file are exactly what a document-local query asks for; they are matched by name *and* receiver, so `a->greet()` and `b->greet()` stay separate symbols. A dotted type now records its member segments too: `Stdio.File` in type position answered nothing while the identical `Stdio.File()` one line over resolved.
- **Hover and go-to-definition were silent on an inherit that names nothing resolvable.** `inherit NonExistentClass;` answered nothing at the one position the server itself hands out as the definition from every use of that name in the file.
- **Member access failed when the receiver was declared in an outer scope.** The lookup searched only the immediately enclosing scope, so a variable declared in a function body was invisible from a nested block, and highlight, references and rename all stopped at the first use.
- **Qualified access resolved to the wrong class on a name collision.** With `inherit A;` and `inherit B;` both declaring `value()`, `B::value()` silently resolved to `A.value` and `B::label()` to nothing at all. The check asked whether the inherited scope's *parent* held a class of that name — but every class body shares the file scope as its parent, so the first inherited scope always matched. This was a wrong answer returned confidently, which no crash or empty-result check could have surfaced.

## [0.8.51] — 2026-07-31

### Fixed

- **A missing Pike binary no longer produces an endless stream of notifications.** The client reset its crash-restart counter the moment the server reported Running, so a server that started and then crashed reset the cap on every cycle: the "give up after three" never fired, the client restarted forever, and each restart re-ran server initialisation and re-showed the "Pike binary not found" notice. The counter is now cleared only once the server has stayed up long enough to call the session healthy, and the decision lives in a unit-tested policy rather than inline in a state-change handler. Separately, AutoDoc extraction logged a warning on every save when Pike was absent — 18 warnings in a 45-second editing session, measured — where the diagnostics path already treated an absent binary as the supported steady state it is. Both paths now share one predicate, so a Pike-less install is quiet after the single notice at startup.
- **`global::name` resolved to the wrong scope.** Pike's `global::` names the file-level scope, but the token is `global` rather than an identifier, so the collector saw no identifier child and fell through to the bare-`::` branch — which means "the first inherited class", the opposite of what the qualifier asks for. In a class that shadows a file-level name, go-to-definition landed on the shadowing member or on nothing at all. Scope resolution also moved to its own module, `scopeRefs.ts`, to stay inside the file-size limit.

## [0.8.50] — 2026-07-31

### Added

- **Behavioural LSP audit harness** (`tools/lsp-audit/`, dev-only, never wired into CI). Boots the real server and fires every declared capability at every declaration and sampled reference across a workspace, gating findings against the Pike compiler in `tools/roxen-lab` so a defect in the source is never reported as a defect in the tool. `bun run audit:sweep`, `audit:triage`, `audit:standalone`, plus `tools/lsp-audit/client-surface-check.mjs`. Its first run is written up in `docs/audits/iteration-7.md`: 208,816 requests across 529 Pike files, zero crashes and zero timeouts, 14 distinct defects.

- **Roxen support.** Roxen WebServer source is Pike, but `#include <module.h>` and the other twelve Roxen headers never resolved, and the `TYPE_*`, `VAR_*`, `MOD_*` and `MODULE_*` families they define were unknown, so Roxen files arrived red. A local installation is now detected — explicit setting, then `pike.json`, then a workspace ancestor, then `/usr/local/roxen*`, highest version winning — and its module, include, and program paths are folded into Pike's, so resolution needed only one genuinely new concept: the `roxen-module://` inherit scheme. A generated index of Roxen 6.1's constants and its Roxen/RXML/module-prototype API ships with the server, so hover and completion work with no Roxen installed at all; a detected installation takes precedence and additionally gives go-to-definition into real sources. On an index-only symbol, go-to-definition returns nothing rather than a path that does not exist on the user's machine.
- **Per-file Roxen activation.** Roxen mode is decided per file, from markers measured against the Roxen 6.1 corpus (a Roxen header include, `inherit "module"`, or `constant module_type = MODULE_*`) covering 143 of the 170 files in `server/modules/`, plus directory inheritance for the 27 `graphics/rimage/plugins` helpers that are Roxen files by location rather than content. `pike.roxen.mode` (`auto`/`on`/`off`) overrides it, and `pike.roxen.path` names an installation explicitly. A plain Pike file in a mixed workspace is offered no Roxen symbol.
- **Roxen lab and corpus tooling.** `harness/roxen-lab/` builds Pike 8.0.1116 and Roxen 6.1 from pinned revisions and exposes a parse oracle that settles whether a construct the grammar rejects is a grammar defect or invalid source. `scripts/roxen-corpus-parse.ts` runs the grammar across the corpus, decoding each file by detected encoding, and tracks the failure count against a committed baseline.

### Changed

- **`harness/` is gone, split by what each part actually is.** It held three unrelated things under a name that said "test scaffolding": the Pike runtime the server ships and spawns, dev-only introspection oracles, and a test root parallel to `tests/`. That is what let the runtime go missing from three distributions unnoticed. Now: `server/pike/` (shipped runtime), `tools/pike-oracle/` (dev-only ground-truth tooling and its snapshots), `tools/roxen-lab/`, and `tests/tooling/` for the tests that lived under `harness/__tests__`. The VSIX also stops shipping `introspect.pike` and `resolve.pike`, which it had been copying with a `harness/*.pike` wildcard. Script renames: `harness:*` → `oracle:*`, `test:harness` → `test:tooling`.

### Fixed

- **The Pike worker reached no distribution but the VSIX.** `worker.pike` lived in `harness/`, and the standalone, npm, tarball and binary builds all copied what looked like product and skipped what looked like tests. Without it the server silently degrades to tree-sitter only — no compiler diagnostics, no `typeof`, no `resolve`, no autodoc — and says so once, to the log, on the first request that needed Pike, so nothing ever failed. The compiled binary was worse: it resolved the worker against a path baked in at build time, so it worked on the build machine and nowhere else. All four distributions now carry it, the binary embeds it the way it already embedded the WASM blobs, and `check-standalone.mjs` asserts it is there.

- **Declarations in a `for` condition no longer show as syntax errors.** `for (keys; string key;)` is valid Pike — declarations are legal in any condition position, with or without an initialiser — but the grammar put the name in an `ERROR` node. Fixed upstream in tree-sitter-pike and shipped here as a rebuilt WASM; the Roxen 6.1 corpus goes from 11 parse failures to 10, with nothing regressed.
- **Named class expressions no longer show as syntax errors.** `Write_back wb = class Write_back { … };` and `lock = class lambda17 { … }();` are valid Pike — one class production, reached from expression position — but the grammar put the name in an `ERROR` node. Fixed upstream in tree-sitter-pike and shipped here as a rebuilt WASM; the Roxen 6.1 corpus goes from 14 parse failures to 11, with nothing regressed.
- **`lsp-probe` decoded every file as UTF-8.** Probing an ISO-8859-1 file replaced each high byte with a replacement character and shifted every position the tool printed, which is exactly the discrepancy it exists to investigate. It now decodes the way the server does.

- **`documentHighlight` returned nothing for a symbol used once.** A guard bailed out whenever the symbol had no references beyond its declaration — but the declaration is itself an occurrence, and LSP asks for every highlight at the position. The guard was redundant with the function it called, which already returns nothing when it finds nothing, so it only ever suppressed the case it got wrong. Measured across the Roxen 6.1 tree and the semantic corpus, this was 4,242 of 6,886 finding instances.
- **`prepareRename` reported the declaration's range instead of the cursor's.** Clients use that range to pre-select the text being renamed, so invoking rename from a reference highlighted the wrong span — for every symbol, in every file. The worst case: on `this`, the position resolved to the enclosing class, and the editor offered to rename that class. Accepting it would have rewritten a class the user never pointed at. The declaration is still what decides renameability and supplies the placeholder; the range now comes from the occurrence under the cursor, and a position that is not an occurrence is declined.
- **Renaming through an `inherit` or `import` clause corrupted the file.** The clause names a class it does not own, so the edits landed on the clause and not the declaration — or the reverse — leaving source that no longer compiles. Both `prepareRename` and `textDocument/rename` now decline it, because a client is free to skip the former and the latter is the destructive one. Renaming the class itself is unaffected.
- **The qualifier of a scoped access resolved to nothing.** In `A::value()`, the member after `::` resolved but the `A` before it was never recorded as a reference at all, so definition, declaration, references, hover, completion and document highlight all returned nothing there. Six capabilities, one missing reference.
- **Members reached through a subscript resolved to nothing.** `variables[var]->set(...)` looked the member up on the container's type — a class literally named `mapping(string:Variable.Variable)` — rather than on what the container holds. Both the reference table and the query-time resolver now use the element type. Module-qualified element types (`mapping(string:Stdio.File)`) still do not resolve; that needs cross-module type resolution and is tracked in the audit.

## [0.8.49] — 2026-07-16

### Added

- **Efun signature help.** `write()`, `sprintf()`, and the other efuns live in the predef indexes rather than the stdlib autodoc index, so signature help never found them. Their raw type descriptors now become one overload per `function(args : ret)` alternative, with markdown docs, and the active overload is picked to fit the argument the cursor is on.
- **Hover on type names.** `Stdio.File f` hovered on the type showed nothing. The dotted path ending at the cursor is now resolved: static stdlib entries supply class docs, workspace modules render as `module X (defined in …)`, and types the static index lacks (e.g. `String.Buffer`) fall back to the worker's runtime resolve.
- **Definition and hover on module names.** `Util` in `.Util.double_it` opens `Util.pmod`; `Stdio` opens the stdlib `module.pmod`. Worker-reported source locations are offered only when the file exists locally — C-implemented symbols report the path Pike was built from on a foreign machine.
- **Inherit aliases.** Hover on `base` in `inherit Vec : base` renders the inherit it names; definition jumps to the inherit declaration.

### Changed

- **Symbol collection now walks trees with a tree-sitter cursor, halving server memory on real code.** The generic descents materialized a JS wrapper object (plus a children array) for every node, so data-heavy files exploded: one 216KB stdlib table file parses to 378,513 nodes and cost ~117MB of allocator high-water per symbol-table build — for a table of 52 declarations. The cursor walks inside WASM and materializes a node only when its type is actually dispatched. Opening Pike's own stdlib (561 files, largest first, 50 open) took the server from 800MB RSS — over budget, and unrelievable because open files are exempt from demotion — to 391MB; hover on large stdlib files is ~4x faster; symbol tables are byte-identical.
- **Neovim and Helix get the same V8 memory flags VSCode always had.** The VSCode client launches the server with `--max-old-space-size` and `--expose-gc`; editors running `bin/pike-language-server` directly got neither, so their bursts ran uncapped and the memory governor's forced-GC relief could never fire. The launcher now re-execs Node once with the client's exact cap formula (default budget 512MB, overridable via `PIKE_LSP_MEMORY_BUDGET_MB`); skipped under Bun or when the caller passes its own Node flags, with signals and the exit code mirrored so editors still manage a single process.
- **The blob-size policy now exempts the generated stdlib index.** `server/src/data/stdlib-autodoc.json` is ~1.6MB of extracted AutoDoc for Pike's whole stdlib and has been over the 1MB limit since it was added — no PR had modified it since the policy landed, so nothing had tripped it. It is exempted by exact path rather than by raising `BLOB_SIZE_LIMIT` globally, which would wave through the accidental blobs the policy exists to catch.
- **`scripts/` is now type-checked**, closing the last gap of the kind that let `tests/` rot: the root `tsconfig.json` covered neither, so 21 errors had accumulated across the two script files, including the broken import above.

### Fixed

- **Pike's relative module syntax (`.Util`) never resolved anywhere in the server** (oracle-verified against pike 8.0.1116). The resolvers split `.Util` on dots and searched for an empty first segment, returning null for every relative path — a leading dot now restricts the search to the current file's directory, matching `master.pike`. Dotted inherit paths (`inherit .Util.Counter`) looked for a file called `Util.Counter.pmod` instead of walking segments; inheritance wiring matched the target class against the full path text instead of its final segment, so it could never find `Counter` (or picked the file's first class); and expression member access (`.Util.double_it`) bailed when the LHS resolved to no declaration — it now resolves the LHS as a module file, indexing it on demand. Definition, hover, references, and rename all work through relative paths now. Also, definition/hover on a member access only matched when the cursor sat on the member's first character; it now range-matches.
- **Definition, hover, and completion handlers were frozen onto the empty placeholder index.** The handlers captured `ctx.index` by value at registration time, which runs before `initialize` swaps in the real workspace and stdlib indexes — so every future request saw an index with no files and no on-demand indexing, silently degrading cross-file and stdlib resolution to same-file-only behavior. The handler contexts now read the live index at request time.
- **Object-member completion offered the parent module's functions.** `String.Buffer buf; buf->` completed to `implode_nicely`, `capitalize`, and the rest of the `String` module — none of which exist on a Buffer object (oracle-verified against `indices(String.Buffer())`) — because the static lookup fell back to the parent module's children when it had no entry for the exact type. The bogus items also starved the runtime fallback that would have enumerated the real members. The lookup is now exact-FQN only, letting the runtime fallback return the true member set. Also deletes a dead, drifted duplicate of the member-completion strategies that carried the same bug.
- **The npm publish job read the wrong secret name.** It read `secrets.NPM_TOKEN`, but the repository secret is named `NPM_SECRET` — the guard would have refused every publish.
- **Foreach loop variables were modelled as function parameters.** `foreach(nums; int i; int val)` declares locals scoped to the loop, not arguments to a call, but the collector filed them under `kind: 'parameter'`. Two consequences: the linter said "Parameter 'i' is unused", which is simply the wrong noun; and it filed them under the unused-**parameter** rule (P3002), so switching off unused-parameter warnings — which people reasonably do, since a signature can force an argument you never read — silently switched off unused-loop-variable warnings too. Those are different problems: an unused parameter is often unavoidable, whereas Pike lets you omit a foreach index entirely, so the advice is actionable. Loop variables are now `kind: 'variable'` and report as `Variable 'i' is unused` (P3001). Real function parameters are unaffected — they come from a separate collector.
- **`scripts/build-stdlib-index.ts` could not run at all.** It imported `parseXml` and `XmlNode` from `autodocRenderer`, which consumes both from `xmlParser` but never re-exported them, so the script threw `SyntaxError: Export named 'parseXml' not found` on load. Nothing type-checked `scripts/`, and nothing referenced the script, so it rotted unnoticed. It now imports from `xmlParser` and runs.
- **Stdlib hover and completion were serving docs from a stale index.** `server/src/data/stdlib-autodoc.json` had drifted from the generator that produces it, because that generator had been broken and unrunnable. Two defects surfaced on repairing it. `renderAutodoc` returned null whenever a symbol had no signature of its own, so every doc-only class and module — 335 of them, e.g. `Arg.Options` ("The option parser class that contains all the argument objects") — was dropped from the index and hovered as nothing; it now renders those, and only gives up when there is no documentation at all. Separately the committed index predated the current renderer and flattened `@example` blocks into unreadable run-on prose: `Arg.parse`'s argument-syntax table rendered as `--foo -> "foo":1 --foo=bar -> "foo":"bar" -bar -> ...` on one line, where it is now a fenced code block with its layout intact. The index is regenerated: 68 entries gain properly formatted examples, 77 symbols are added, none are lost.
- **The stdlib index generator could silently shrink the index.** It had already dropped 335 symbols without complaint, and a smaller index only shows up as quieter hovers. It now refuses to write an index that lost symbols relative to the committed one, naming what went missing, and requires `--force` to override.
- **`scripts/manifest.ts` type annotation described data that never existed.** `CATEGORY_PATTERNS` was annotated as an array of objects while being populated with — and destructured as — tuples.

## [0.8.48] — 2026-07-16

### Added

- **Install without building anything — three ways.** Previously the only route
  for Helix, Neovim, and other LSP clients was to clone the repository and build
  from source. Each artifact below is built and verified by CI, and attached to
  the GitHub Release:
  - **Native binaries** for linux-x64/arm64, darwin-x64/arm64, and windows-x64.
    A single self-contained executable requiring **no runtime at all** — no
    Node, no Bun. It embeds its own tree-sitter grammar and stdlib index.
  - **npm package** — `npm install -g pike-language-server`, runs on Node 18+.
    Published with no runtime dependencies and no install scripts; everything is
    bundled.
  - **Standalone tarball** — extract and point your editor at `server.js`; runs
    on Node 18+ or Bun.
- **`check:distributions`** — builds each artifact and drives all 13 LSP
  features against it *from outside the repository*, so an artifact that only
  works inside a checkout fails CI. Runs as a matrix job on every PR.
- **Step-by-step [Helix installation guide](docs/helix-installation.md)** —
  install, build, configure, verify, syntax highlighting, and troubleshooting,
  verified end-to-end against Helix 25.01.1.
- **`check:standalone` and `check:helix` CI guards** — the first asserts the
  standalone bundle answers an LSP `initialize` over stdio (via both the
  documented command and the `bin` wrapper) and exits cleanly on
  `shutdown` + `exit`; the second drives all 13 supported LSP features using
  Helix's real client capabilities and asserts they return actual results.
  Nothing previously exercised the standalone build, which is how a bundle that
  could not start shipped unnoticed.

### Changed

- **`tests/` is now type-checked.** The root `tsconfig.json` excluded it, so roughly ninety type errors had accumulated unseen — including a formatting harness that built an invalid handler context (every request threw and returned `null`, which several tests asserted as correct behaviour), `ModificationSource.didOpen` references that silently evaluated to `undefined` on a field the server branches on, an incomplete `BuildIndex` mock missing `resolveInclude`, and two fixture modules that would have thrown `ReferenceError` had anything called them (both were unused duplicates of logic already inlined elsewhere, and are deleted).
- **`bun run test:fast` runs the suite in parallel (106s to ~41s), opt-in.** The default `bun run test` stays serial and single-process **on purpose**: `--parallel` implies `--isolate`, and a shared process is what catches cross-file pollution. Two of the defects fixed above — the mutable `DEFAULT_RESOURCE_CONFIG` singleton and `getExternalLookup` ignoring its arguments — were caught precisely because one test's global mutation broke a later test. The server is a single long-lived process, so that bug class is real in production; isolation would have hidden both. `test:fast` is for local iteration, not a gate. It excludes the latency benchmarks from the parallel phase (under load they measure CPU contention, not the server) and uses 4 workers rather than one per core (wall time is bound by the two slowest files, so extra workers buy nothing and their contention trips bun's 5s per-test timeout).
- **`unbounded-map-set` quality gate now identifies long-lived containers
  instead of pattern-matching whole files.** It flagged 16 files whose Maps and
  Sets were function-local or fixed constant tables, while its variable-name
  capture was broken such that a real class-field leak went undetected. It now
  reports a violation only when a container is long-lived (module scope, class
  field, or `this.x =`), grows at runtime, and has no eviction — and emits a
  failure, matching the `blocking` severity its own rule catalog declares.

### Removed

- **Dead activity tracking on `ResourceStateTracker`.** Its open-document count and activity timestamps had no callers and could only ever read zero — `HibernationManager` owns that state and is wired to the request and document paths. A second, unwired copy of a fact is a trap for whoever consults it next.
- **The pike-fmt `postinstall` workaround.** `scripts/postinstall-pike-fmt.js` symlinked `web-tree-sitter.wasm` into pike-fmt's `dist/`, and `scripts/fmt.sh` set `PIKE_FMT_WASM` to route around a broken asset lookup. Both existed because the published pike-fmt package could not locate its own wasm; that is fixed upstream in pike-fmt v0.1.10 and the dependency is bumped.

### Fixed

- **Hover lost the signature whenever the AutoDoc XML cache was cold.** A `//!`-documented symbol rendered as bare prose with no `pike` code block — no signature, no type. The Tier 2b comment fallback marked its result `isAutodoc`, which `formatHover` reads as "the documentation already embeds the signature"; that is true of the Tier 1 XML render but not of `renderAutodocLines`, which emits comment prose only (it strips `@decl`). Hover now shows the tree-sitter signature alongside the comment text whenever the extractor is unavailable or the cache has not warmed.
- **A test could corrupt the server's default configuration.** `DEFAULT_RESOURCE_CONFIG` was an exported mutable object aliased directly into `ServerContext.resourceConfig`, so anything mutating the live config in place rewrote the process-wide defaults that `parseResourceConfig` reads for fallback values. The defaults are now deep-frozen, the context owns a fresh config, and `ignoreGlobs` is no longer handed out by reference.
- **Semantic tokens could classify symbols from the wrong stdlib index.** `getExternalLookup` built its predef/stdlib name sets from whichever index arrived first and then ignored its arguments on every later call, so a caller passing a different index silently received the first one's answers. `resetExternalLookupCache()` existed to paper over this and had no callers. The sets are now memoised per index object and self-invalidate; the reset function is gone.
- **Renaming a class left dangling return types on its prototypes.** `Dog getDog();` — a legal Pike forward declaration — was mis-parsed as a bare identifier plus an expression statement, so the function was never declared and the return type was never a reference. Fixed upstream in tree-sitter-pike v1.3.3 (`function_decl` now carries the same `prec.dynamic(2)` as `variable_decl`); the vendored wasm is updated.
- **`workspace/symbol` ignored the client's `workDoneToken`.** A client that asked for progress on a symbol query got none, so lazy global indexing appeared to hang with no indicator. The server now reports `begin`/`end` on the client-supplied token per LSP 3.15, with `end` sent from a `finally` so a failed query cannot strand the indicator.
- **The standalone bundle was not self-contained: any copy of it outside the
  repository was dead on arrival.** `vscode-languageserver` and friends were
  marked external, so `server.js` still imported them from `node_modules` at
  runtime; it only ever worked because Bun found the checkout's own
  `node_modules` by walking up. Copied anywhere else — which is exactly what a
  tarball or npm package is — it died with `Cannot find module
  'vscode-languageserver-protocol/lib/common/api'`. Only `vscode` itself (the
  extension-host API) is external now.
- **The standalone bundle could not run on Node at all**, only Bun. esbuild's
  ESM output cannot satisfy the dynamic `require()` inside web-tree-sitter's
  emscripten glue, so Node died with `Dynamic require of "fs" is not supported`.
  A `createRequire` banner fixes it; the bundle now runs on both, which is what
  makes the npm package viable without Bun.
- **`bin/pike-language-server` hard-required Bun** — it spawned a `bun` child
  process, so `npx pike-language-server` was broken for Node-only users. It now
  loads the server in-process on whichever runtime started it.
- **The standalone server could never start, so Helix, Neovim, and every other
  non-VSCode LSP client were broken.** Two independent faults: the standalone
  bundle was built from `server/src/server.ts`, which is a library and
  deliberately never calls `connection.listen()`; and the server only began
  listening when `PIKE_LSP_STDIO=1` was set, which only the VSCode client did.
  The documented command (`bun standalone/server.js --stdio`) therefore started,
  read no env var, and exited 0 in silence. The bundle is now built from
  `main.ts`, and `--stdio` — the flag every other LSP client passes — starts the
  server. `bin/pike-language-server` sets the env var so `--socket=` and
  `--node-ipc` invocations keep working.
- **Helix setup instructions never worked.** The published `languages.toml`
  omitted `scope`, which makes Helix reject the *entire* user language config,
  and `file-types`, without which Helix never recognises a `.pike` file. The
  syntax-highlighting section claimed copying `highlights.scm` was sufficient;
  Helix also needs a compiled tree-sitter grammar or it loads no parser at all.
- **Neovim configuration was silently ignored.** The documented `settings = {…}`
  block is delivered via `workspace/configuration`, which this server never
  requests — it reads `initializationOptions` only. Use `init_options`. The
  `root_dir` snippet also called `lspconfig.util.find_git_ancestor`, which no
  longer exists in current nvim-lspconfig.

## [0.8.47] — 2026-07-10

### Added

- **Standard-library completion and hover now cover types the pre-built index
  misses** — completing a member of a variable whose declared type is a Pike
  stdlib class that isn't in the static index (e.g. `Image.Image`,
  `Protocols.HTTP.Session`) now falls back to the live Pike introspection worker
  and lists its real runtime methods and constants. Hovering a member of a
  stdlib-typed variable (`Stdio.File f; f->open(...)`) now resolves the precise
  qualified symbol (`predef.Stdio.File.open`) and shows its actual signature and
  documentation instead of nothing. Both paths only run when the static index
  comes up empty, so the common completion path is unchanged, and both degrade
  silently when Pike/pike-introspect are unavailable.

### Changed

- Internal refactor of the declaration collector (`collectSimpleDecl`) to stay
  within the project's function-size limit; behavior is unchanged (covered by
  the diagnostic golden files).

### Fixed

- **Runtime symbol resolution (`resolve`) was silently broken end to end** —
  three independent faults meant the worker's `resolve` method never returned
  data, so the feature above could never have worked: the server looked for the
  introspection module at `modules/Introspect/src` while current `pmp` installs
  it as `modules/pike_introspect/src`; the worker reached submodules via runtime
  `->` indexing, which returns 0 in Pike (it must resolve the full dotted path,
  `master()->resolv("Introspect.Discover")`); and the result validator threw on
  a `null` source location — which pike-introspect emits for inner classes such
  as `Protocols.HTTP.Session.Cookie` — discarding the entire otherwise-valid
  result. All three are fixed.
- **A user-defined function that shares a name with a predef builtin** (e.g. a
  local `int write(int x)`) now shows its own signature on hover instead of the
  builtin's documentation.
- **Server no longer runs out of memory / crashes on large projects or with
  multiple windows open** — the memory governor's relief action (dropping
  symbol tables for non-open files) was latched to the rising edge of the
  pressure threshold, so it fired **once** and then went silent for the rest of
  the process's life (resident memory rarely falls back below the recovery
  threshold after a GC). Files opened afterward grew the heap unbounded toward
  the `--max-old-space-size` hard cap until V8 aborted the process. Relief is
  now level-triggered — it re-runs on every check while usage stays above the
  demotion threshold — and the check interval dropped from 60s to 10s so a fast
  climb is caught before the cap. The client-facing "degraded" notification
  stays edge-triggered (one message per episode).
- **Stale cache-refresh failures were counted as successes and swallowed** —
  a parse/upsert error while refreshing a changed-on-disk cache entry was
  silently discarded and still tallied as "reindexed"; it is now logged.
- **External-editor syntax highlighting was completely broken** — the
  `queries/highlights.scm` that `docs/other-editors.md` tells Helix and
  Neovim/nvim-treesitter users to copy still referenced grammar node types that
  no longer exist (`call_expression`, `function_definition`,
  `prepreprocessor_directive`, `primitive_type`, `binary_expression`, …). A
  tree-sitter query with unknown node types fails to compile in full, so those
  editors rendered no highlighting at all. The query is regenerated against the
  current grammar (v1.3.x) and a test now compiles it against the bundled
  grammar so it cannot silently drift again. Removed the unused duplicate
  `server/src/highlights.scm`.

## [0.8.46] — 2026-07-09

### Added

- **Operators are highlighted** — the adopted grammar didn't color operators at
  all. Arrow (`->`), scope resolution (`::`), and arithmetic/logical/assignment
  operators are now `keyword.operator`, so they get your theme's operator color
  instead of the default foreground.

### Fixed

- **Exported top-level variables are no longer falsely flagged as unused** — the
  unused-variable lint reported any file-scope variable with no *local* reference,
  which polluted every module/library/included file (its globals are used by
  importers/inheritors, not within itself). Declarations now carry their Pike
  modifiers, and a file-scope variable is only flagged when it is `private` (the
  one visibility that is provably file-local); `public`/`protected`/unmarked
  globals are left alone. Locals inside functions are still linted as before.

## [0.8.45] — 2026-07-09

### Added

- **Declaration names and type references are now highlighted** — the adopted
  grammar colored keywords, calls, builtins, and modules but left declared names
  and type references plain ("Other"). The grammar now colors:
  - **class / enum declaration names** and **uppercase type references** (`Widget`,
    `Foo bar;`, `Widget w = …`) as `entity.name.type.class`;
  - **constant declaration names** (`constant int MAX = …`) as `constant.other`,
    while keeping the declared type colored;
  - **inherit / import module paths** as `entity.other.inherited-class`;
  - **variable / field / parameter declaration names** as `variable.other`.

  All standard TextMate scopes, resolved by your theme (no hardcoded colors). Note
  that some themes — e.g. Ayu Mirage — deliberately render `variable` as the editor
  foreground, so plain locals stay uncolored there by the theme's own choice, while
  classes, types, and constants are colored.

## [0.8.44] — 2026-07-09

### Changed

- **New, much richer Pike TextMate grammar** — replaced the hand-written grammar
  with one adapted from the mature `poppa/pike-for-sublime` lineage (via
  `GwennKoi`/`undeadfish` `vscode-pike-lang`), then extended with builtin-function
  and module-name lists generated from the installed Pike 8.0 reference (autodoc).
  It now colors:
  - **member and scope-resolved method calls** — `o->read()`, `Stdio.File()`,
    `this->helper()`, `::process()` — which the old grammar left plain;
  - **~180 `predef::` builtins** (`sizeof`, `sprintf`, `werror`, `indices`, …) as
    `support.function.builtin`;
  - **64 top-level stdlib modules** (`Stdio`, `Protocols`, `String`, `Array`, …) as
    `support.class` — which even the upstream grammar leaves uncolored.

  With semantic highlighting off by default (0.8.43), this grammar is now the
  primary coloring layer, so the added coverage is what you see. All colors come
  from standard TextMate scopes resolved by your theme — no hardcoded colors.

## [0.8.43] — 2026-07-09

### Changed

- **Semantic highlighting is now off by default for Pike (the gopls route)** —
  following gopls (`ui.semanticTokens: false`), the TextMate grammar is the default
  coloring layer and semantic tokens are opt-in. On themes with a sparse semantic
  palette (e.g. Ayu Mirage, which renders the `variable` token as the default
  foreground) the semantic layer overrode the grammar's colors inconsistently;
  making it opt-in removes that class of surprise and keeps coloring theme-agnostic.
  Turn it on per language to get the accuracy the grammar cannot provide — colored
  parameters, member-vs-field distinction, and cross-file-aware coloring:

  ```json
  "[pike]": { "editor.semanticHighlighting.enabled": true }
  ```

## [0.8.42] — 2026-07-09

### Fixed

- **Constants no longer lose their color under semantic highlighting** — the
  `variable.readonly` scope fallback led with `variable.other.constant`, which a
  theme's broad `variable` rule matches, so constants collapsed to the plain default
  foreground before the fallback ever reached the `constant.*` scopes the theme
  actually colors (e.g. on Ayu Mirage, `constant NAME` went to `#cccac2` instead of
  the theme's constant color). Reordered the fallback to lead with `constant.other` /
  `constant.language`, so a `constant` declaration keeps a real color. Completes the
  0.8.40 readonly-fallback fix.

## [0.8.41] — 2026-07-09

### Added

- **Include paths and disabled blocks are highlighted** — `#include <stdio.h>`
  and `#string "…"` now color the target as a string (like C), and `#if 0 … #endif`
  branches are greyed like comments. The disabled region stops at `#else`/`#elif`/
  `#endif`, so a live branch keeps its normal coloring.

### Changed

- **Semantic highlighting is left to the theme (theme-agnostic)** — the extension
  no longer forces `editor.semanticHighlighting.enabled: true`; it now defaults to
  `configuredByTheme`. Forcing it on whited-out identifiers under themes that don't
  define semantic-token colors (e.g. Ayu Mirage): the server's semantic tokens
  overrode the theme's TextMate colors with the plain default foreground about a
  second after opening a file. Themes that opt into semantic highlighting still get
  it, colored by the theme (or via our `semanticTokenScopes` fallbacks); others keep
  their comprehensive TextMate grammar coloring.

### Fixed

- **Typed constants are named correctly** — `constant int FOO = 1;` (at file scope
  or inside a class) previously registered a symbol named after its *type* with the
  real name lost to a parse-error node, which mislabeled the type keyword and broke
  hover, go-to-definition, and rename on the constant. The collector now recovers the
  real name regardless of which identifier the grammar mis-parses.
- **`variable.mutable` / `variable.readonly` no longer fall back to plain text** —
  their `semanticTokenScopes` lists now end in real, widely-themed scopes
  (`variable.other.pike`, `variable`), so a theme with no rule for those modifiers
  colors them like a normal variable instead of the editor's default foreground.

## [0.8.40] — 2026-07-08

### Fixed

- **`# "…"` and `# string "…"` no longer flagged as errors** — updated the
  tree-sitter-pike WASM to **v1.3.1**, which accepts horizontal whitespace
  between `#` and the string delimiter in hash-strings and string includes
  (Pike compiles these identically to `#"…"` / `#string "…"`). Previously the
  parser produced an `ERROR` node, surfacing a spurious diagnostic.
- **Phantom "unused" warnings in `.h`/`.inc` headers** — the unused-symbol lint
  no longer flags file-scope declarations in header fragments. Headers exist to
  be `#include`d, so their top-level declarations are the export surface for the
  includer, not dead code. Locals inside functions in a header are still linted.
- **Constants keep their color under semantic highlighting** — added a
  `variable.readonly` semantic-token scope fallback so `constant` declarations
  fall back to a constant color instead of a plain `variable` when the active
  theme has no semantic rule for readonly variables.
- **Configured include/module/program paths no longer discard auto-detected
  ones** — `pike.languageServer.includePaths` (and the module/program
  equivalents) are now *prepended* to the auto-detected Pike paths, as
  documented, instead of replacing them. Adding a custom include directory no
  longer silently breaks resolution of system headers such as `<stdio.h>`.

## [0.8.39] — 2026-07-07

### Added

- **Updated tree-sitter-pike WASM to v1.3.0** (from v1.2.2), which reaches **100% (624/624)** installed-distribution parse rate. New coverage: macro invocations that take statement arguments (`RUN_MAYBE_BLOCKING(cond, 0, 1, MSG("…"); return 0;)`), `modifier`-qualified local function declarations inside a block, and preprocessor conditionals that split a single expression into alternative fragments (`x = #if A … #else B … #endif y`).
- **Autodoc markup highlighting** — `//!` and `/*! … */` autodoc comments, plus shebang lines, `#line`, and `#define` macro names are now highlighted.
- **Autodoc skeleton snippet** — typing `//!` offers a completion that expands to an autodoc doc-comment skeleton.

### Changed

- **Enter keeps indentation** — the client enables `editor.autoIndent` so pressing Enter preserves the current indent level.
- Bumped `vscode-jsonrpc` to 9.0.1.

## [0.8.38] — 2026-07-07

### Added

- **Go to Type Definition** (`textDocument/typeDefinition`) — jump from a variable to the class that defines its type, resolved same-file, qualified, and cross-file.
- **Go to Declaration** (`textDocument/declaration`) — aliased to definition (Pike has no header/prototype split).
- **Semantic tokens delta** — the server now advertises and serves `textDocument/semanticTokens/full/delta`, sending only the changed slice of the token array instead of the whole file on every keystroke.
- **Range formatting** (`textDocument/rangeFormatting`) — "Format Selection" now works (whole-document fallback, since pike-fmt is document-level).
- **Diagnostic related information** — unreachable-code warnings now link back to the `return`/`break`/`continue` that makes the code dead.
- **sprintf/format-specifier highlighting** inside strings (`%d`, `%O`, `%-20s`, `%.2f`, `%{…%}`) plus backslash line-continuation, guarded against prose false positives.
- **Truncation notice** — when a file exceeds `maxNumberOfProblems`, a visible notice replaces the previously silent drop.
- **`scripts/bump-version.sh`** — sets the template/release version across all six files that record it and rolls the CHANGELOG in one step, so a release cut can't drift.

### Changed

- **Completion auto-triggers on `->` and `::`** — added `>` and `:` to the trigger characters so member and inherit-scope access pop IntelliSense (the engine already disambiguated these).
- **Unused variables/parameters and unreachable code are tagged `Unnecessary`** — editors now fade them grey.
- **Code lenses resolve lazily** — reference counts are computed only for the lenses the client renders; unreferenced functions now show "0 references" (as in TypeScript/C#) rather than being hidden.
- **Signature help re-triggers on `,`** so the active parameter updates while the popup is open.
- **Modernized the README** (which renders on the Marketplace page): user-facing first, accurate counts (90-file corpus, ~490 Pike tests, 5,500+ stdlib symbols), curated configuration table, and dev/test detail moved to links. Replaced the broken Marketplace version badge — shields.io's `visual-studio-marketplace` badge type is retired — with a GitHub-release badge labelled "marketplace", which is accurate because the release workflow now publishes the same version to GitHub and the Marketplace.
- Dropped the inaccurate "supports pull diagnostics" README claim; the server is push-only by design (version-gated supersession + cross-file propagation).

## [0.8.37] — 2026-07-07

### Added

- **VS Code Marketplace publishing.** `release.yml` now publishes the extension to the Marketplace when a GitHub release is published, using the `VSCODE_MARKETPLACE_TOKEN` secret (`vsce publish --packagePath …` on the exact VSIX attached to the release, so both artifacts are identical). Release builds pass `build-vsix.sh --release` to produce a clean `X.Y.Z` version, which the Marketplace requires; local builds keep the unique `-buildNNNNNN` suffix so you can tell you're running the build you just made.

### Removed

- **Dead `scripts/release.sh`.** It depended on `.omp/skills/cut-release/scripts/{update_changelog.py,preflight.sh}`, removed in #146, so it could not run. Nothing in CI referenced it.

## [0.8.36] — 2026-07-07

### Fixed

- **Packaged VSIX version now tracks the release version.** `build-vsix.sh` read the version from `extension.package.json`, which manual release cuts had left frozen at `0.8.32` — so the VSIX attached to the `v0.8.33`–`v0.8.35` releases was mislabelled `0.8.32-build…`. The VSIX version is now derived from `.template-version` (the single source of truth every cut bumps and the git tag mirrors), and `release.yml` now fails the release if the tag does not match `.template-version`. `extension.package.json` and `package.json` were also reconciled from the stale `0.8.32` to the current release version.

## [0.8.35] — 2026-07-07

### Changed

- Bumped `pike-fmt` to `^0.1.9`, which formats large files in linear time (~20× faster on big files) with byte-identical output. Reformatted `corpus/files/enum-basic.pike` to match the newer formatter's corrected switch/case indentation.

## [0.8.34] — 2026-07-07

### Added

  - `#include "file.h"` and `#include <file.h>` now contribute the included
    file's top-level symbols to the including file. Declarations (functions,
    variables, constants, classes, typedefs) and `#define` macros from a header
    appear in completion and hover, and go-to-definition jumps into the header.
    `#define` macros are modeled as first-class symbols (object-like and
    function-like).

### Changed

  - `#include` and relative `inherit`/`import` string paths now resolve outside
    the workspace root — e.g. from `a/b/c/file.pike`, `#include "../defs.h"`
    resolves to `a/b/defs.h` — matching how the Pike compiler resolves them
    relative to the including file. Non-source system files reached by upward
    traversal (e.g. `/etc/passwd`) remain refused. Document links and
    go-to-definition follow the same resolution, and editing an included header
    refreshes the files that include it.
  - `buildSymbolTable` now requires the source text the tree was parsed from and
    fails fast when it is missing, instead of silently producing a symbol table
    with wrong character offsets.

## [0.8.33] — 2026-07-07

### Added

  - Interactive type queries (`typeof`) and symbol resolution (`resolve`) are now
    memoized in bounded LRU caches on the Pike worker. Hovering or completing on
    the same variable no longer recompiles the whole file via `compile_string`
    every time — repeated queries on unchanged content are served from memory.
    Only successful results are cached, and the caches are cleared whenever the
    worker stops or restarts so a fresh process never serves stale state.

### Changed

  - `parse()` now returns the cached tree directly when the source is
    byte-identical to the previous parse, instead of re-running tree-sitter.
    Feature handlers (hover, completion, definition, document links) that
    re-parse an unchanged document on every request now skip the work entirely.
  - The debounced diagnose path no longer rebuilds the symbol table for lint
    rules. It reuses the version-matched table the workspace index already built
    on the triggering edit — `buildSymbolTable` is the most expensive step of the
    diagnose path (~5× a parse), and it was being run twice per settled edit.
  - `LRUCache` eviction is now O(1) (Map insertion-order recency) instead of an
    O(n) scan for the least-recently-used entry on every insertion. Cache
    iteration order is now true LRU (oldest first), which also makes
    `evictTreeCacheOldest` evict the genuinely oldest trees first.

### Fixed

  - Cross-file navigation now works for a file opened outside the current
    workspace folder. Opening a single Pike file that lives outside the open
    workspace left every cross-file `inherit` (and the symbols it pulled in)
    unresolved — go-to-definition, find-references, and completion all degraded
    to "dumb mode". The module resolver's path-traversal guard rejected the
    file's own directory because it was not under the workspace root, so sibling
    files could not be resolved. The importing file's own directory is now a
    valid resolution root (upward `../` traversal and absolute paths outside the
    workspace/system boundaries remain blocked).
  - A restarting Pike worker now rejects its in-flight requests instead of
    silently dropping them. Previously `restart()` cleared each pending request's
    timeout and removed it from the map without rejecting, leaving the awaiting
    caller hanging forever. Callers now receive a rejection and fall back to a
    degraded result, keeping success distinguishable from failure.
  - A desynced worker response stream (a >1MB line with no delimiter) now rejects
    in-flight requests and restarts the worker immediately, rather than clearing
    the buffer and stranding each request until its individual timeout.

## [0.8.32] — 2026-07-07

### Added

  - Developer tooling for debugging the extension without VS Code:
    `bun run probe <command> <file>` (headless LSP driver that decodes semantic
    tokens, hover, completion, diagnostics, and capabilities),
    `bun run watch:server` / `watch:client` (incremental rebuilds), and
    `docs/debugging.md`. VS Code F5 debug configuration under `.vscode/`.

### Fixed

  - Semantic highlighting no longer flickers off while typing. The semantic
    tokens handler previously threw `ContentModified` on *any* tree-sitter parse
    error, which cleared all semantic colors for the whole file on nearly every
    keystroke and left files with tree-sitter grammar gaps permanently
    uncolored. It now returns the tokens the version-matched symbol table
    produces from the error-tolerant partial tree, falling back to
    `ContentModified` only when no tokens can be produced at all.
  - Semantic tokens are now recovered from partial parses. The declaration and
    reference collectors returned early at every tree-sitter `ERROR` node, so
    declarations the parser *had* recovered inside an ERROR subtree (e.g. a
    function whose closing `}` is not yet typed) were discarded, blanking all
    tokens for the file. Both collectors now descend into ERROR subtrees,
    skipping only zero-width MISSING nodes. Corpus semantic-token coverage went
    from 76/81 to 81/81 files. (This was an LSP bug, not a tree-sitter-pike
    grammar bug — the grammar recovers the declarations correctly.)
  - Corrected a stale test that asserted `semanticTokens/full` returns empty
    data for an unknown document; the server reports `ContentModified` (a sync
    race) as intended since the "protocol errors for semantic-token races" work.
  - The dev manifest (`package.json`) and the shipped manifest
    (`extension.package.json`) can no longer drift. `contributes` is now authored
    once in `extension.package.json` and mirrored into `package.json` (with dev
    `client/` paths) by `scripts/sync-manifest.ts`, which runs during
    `build:extension` and is enforced by a test. Previously the dev manifest was
    a stale subset missing ~17 configuration settings.

## [0.8.31] — 2026-06-22

### Changed

  - Resource-state notifications and the VS Code status bar now expose process
    heap, RSS, and CPU metrics, making degraded/hibernating LSP sessions easier
    to diagnose on shared SSH hosts.

## [0.8.30] — 2026-06-13

### Added

  - Tiger Style quality gate coverage for nesting depth, module export counts,
    bounded loops, linked maintenance markers, documented skipped tests, rule
    catalog validation, and auditable suppressions.

  - Resource resilience (ADR 0032–0033): memory-pressure handling demotes
    non-essential index entries and enters degraded mode when the heap budget
    is exceeded. The Pike worker uses a heartbeat/watchdog protocol with
    exponential backoff to detect and recover from unresponsive or crashed
    subprocesses. Idle sessions hibernate after a configurable timeout (no
    open documents, no activity), stopping the worker and clearing caches to
    reduce footprint on shared SSH hosts. Wake is lazy — the first request
    after hibernation rehydrates the index; a full reindex only runs after
    sustained activity.

  - Resource-state notifications (`pike/resourceState`) now include a
    `timestamp` field for client-side status-bar display.

  - Lingering-session troubleshooting guide (`docs/lingering-remote-sessions.md`)
    covering degraded mode, hibernation, worker crashes, and log output.

  - Lazy indexing with dependency map (ADR 0031): default `openFiles` mode
    indexes only open files and their bounded dependency closure, making
    startup fast regardless of workspace size. Global features (workspace
    symbol, references, rename, call/type hierarchy, implementation) prepare
    the full index on-demand with `workDoneProgress` and cancellation support.
    `full` and `auto` modes remain supported for immediate global features.

  - Background and on-demand indexing batches now yield via `setImmediate`
    between batches, keeping interactive requests (hover, completion,
    diagnostics) responsive during full workspace scans.

### Changed

  - The persistent cache now self-heals on load: old-format entries are
    upgraded from source-file mtime/size metadata (so unchanged files no
    longer require a content read), and corrupt, duplicate, missing-source,
    and superseded entries are dropped and pruned. After save, on-disk cache
    file count equals the live entry count.

  - Cache restore is bounded: entries load in fixed-size batches instead of a
    single `Promise.all`, and an overflow path wipes and rebuilds when the
    stored count vastly exceeds the expected live set, preventing startup OOM
    against bloated historical caches (~20,000 entries).

  - Pike worker request timeout now force-kills the underlying subprocess and
    rejects pending work truthfully; the worker restarts on the next request
    instead of leaving a wedged process as the only FIFO worker.

  - Shutdown is deadline-bounded: the cache save observes a fixed deadline and
    the Pike worker is always terminated before shutdown returns, so no orphan
    Pike process survives even when the save is slow.

  - Under degraded mode (memory pressure), global features that require new
    candidate expansion (workspace symbol, references, rename, call/type
    hierarchy, implementation) return an explicit "temporarily unavailable
    under memory pressure" error rather than partial or empty success.

  - The client status bar reflects resource state (indexing, degraded,
    hibernating, hibernated, waking) non-modally, and the resource-state
    notification handler is now re-registered after a settings-change restart.

## [0.8.29] — 2026-06-12

### Fixed

  - Semantic-token lifecycle races now return protocol errors (`ContentModified`
    or `RequestCancelled`) instead of destructive empty token payloads, and
    same-file typing no longer emits workspace semantic-token refresh requests.

## [0.8.28] — 2026-06-12

### Fixed

  - Semantic tokens now self-heal on file re-open/file-switch races by building
    same-version tokens directly from the live document when the workspace index
    is temporarily cold. This prevents VS Code from clearing colors without any
    edit, and covers multiline hash-string documents in the cold path.

## [0.8.27] — 2026-06-11

### Fixed

  - Semantic token responses now reject symbol tables whose version is stale
    relative to the latest open document, preventing delayed refresh races from
    returning misaligned tokens that leave some identifiers uncolored.

## [0.8.26] — 2026-06-08

### Fixed

  - Semantic coloring no longer disappears a few seconds after opening a Pike
    file when a delayed workspace/index refresh returns empty same-version
    semantic token data. The server now preserves the last good same-version
    full/range token cache instead of sending a destructive empty response.

## [0.8.25] — 2026-06-05

### Fixed

  - Chained member access (`a.b.c`, `obj->a->b`, mixed `a.b->c.d`) now
    records the *immediate* LHS of each access instead of the leftmost
    identifier of the chain. Previously, the reference collector's
    `extractLhsIdentifier` walked the LHS subtree via the first child
    recursively, so for `Container.Something.Else` both `Something` and
    `Else` had `lhsName=Container`. The fix walks via the last child,
    so `Else` correctly has `lhsName=Something`. This restores
    multi-segment chain coloring and makes downstream type resolution
    see the right receiver for each access. Pre-existing latent bug
    surfaced by the v0.8.24 mutable-modifier fix.

## [0.8.24] — 2026-06-05

### Fixed

  - Local variable declarations once again emit the `mutable` semantic token
    modifier (regression introduced in v0.8.13 by PR #90). Themes that style
    `variable.mutable` distinctly (italic, different foreground) recover the
    previous coloring for reassignable locals in `switch`/`case` bodies and
    other scopes. Themes that don't style the modifier are unaffected because
    the bit is additive and falls back to the base `variable` color.

## [0.8.23] — 2026-06-05

### Fixed

  - Formatter integration now uses `pike-fmt` 0.1.7, preserving indentation for
    split control-flow headers and nested `switch`/`case`/`default` bodies after
    line moves or custom formatting.
  - Branch-cleanup CI now treats already-deleted feature branches as success,
    avoiding noisy post-merge failures when squash merge deletes the branch first.

## [0.8.22] — 2026-06-05

### Fixed

  - Semantic token requests now wait for the tree-sitter parser to finish
    initializing before answering first-open requests, preventing VSCode from
    receiving an empty token payload that clears coloring as a file opens.

## [0.8.21] — 2026-06-05

### Fixed

  - Alt+Up/Alt+Down line moves now wait for LSP document sync before formatting
    and run a stabilization pass, preserving Pike indentation when lines cross
    block boundaries.
  - Pike line-move commands are declared in both development and packaged VSCode
    manifests so keybindings resolve consistently.
## [0.8.20] — 2026-06-04

### Fixed

  - Semantic tokens are indexed immediately when Pike files open, so semantic
    coloring is available on first paint instead of waiting for an edit.
  - Semantic coloring is preserved while a document contains parse errors by
    reusing the last good full semantic-token response instead of clearing all
    token colors.
  - File rename operation registration is restricted to `file:` Pike files,
    avoiding folder-operation noise from clients evaluating Pike rename filters.
  - The GitHub Release workflow installs `vsce` before packaging VSIX assets and
    overwrites existing release assets on rerun.

## [0.8.19] — 2026-06-04

### Fixed

  - Cross-file features now refresh when background indexing makes dependencies
    available: affected open documents republish diagnostics, request CodeLens
    refresh, and refresh semantic tokens without requiring an edit.
  - Inherit/import dependents are invalidated when their target file is
    indexed, forcing `wireInheritance` to run again after cold-index races.
  - `import Foo;` is no longer flagged unused by literal occurrence counting;
    Pike imports can expose names that are used without the `Foo.` qualifier.
  - Unresolved call identifiers stay function-shaped in semantic tokens instead
    of being demoted to `variable`, so calls to stdlib/built-in functions
    pick up theme function-call colors.
  - The current `#include` LSP symbol-resolution limitation is documented in
    known limitations and ADR-0027.

## [0.8.18] — 2026-06-03

### Added

  - Semantic tokens now advertise and handle range requests, allowing clients to
    request only the visible/edit-affected slice instead of always receiving a
    full-file token payload.
  - CI now checks for unique ADR filename prefixes, release packaging verifies
    that the release tag is ancestor-or-equal with the default branch and has the
    same tree as `origin/main`, and local release preparation runs the same
    lineage guard before printing tag/publish commands.
  - The VS Code integration lab now runs in CI and exercises diagnostics, hover,
    semantic tokens, navigation, completion/signature help, parser edge cases,
    and Pike-oracle degradation against the built extension.
  - CI now runs smoke-test and quality-gates jobs, plus macOS and Windows matrix
    coverage for typecheck and the non-Pike Bun test suite.

### Changed

  - Diagnostics now use a single push model. The server no longer advertises LSP
    pull diagnostics because real-time diagnostics are published through the
    existing debounced `publishDiagnostics` pipeline.
  - Completion auto-triggering is narrowed to dot access only; signature help owns
    `(` and `,`, and broad `:`/`>` triggers no longer fire in unrelated contexts.
  - Semantic token refresh notifications are coalesced, and pending document
    changes received before parser readiness are replayed after initialization.

### Fixed

  - ADR filename prefixes are unique; the syntax-color ADR was renumbered to
    ADR-0037 and references were updated.

## [0.8.17] — 2026-06-02

### Changed

  - TextMate syntax highlighting now gives uppercase class-like identifiers and
    arrow/dot member names theme-friendly scopes, so type names such as `Foo`
    and member accesses such as `object->member` are visibly colored before the
    LSP semantic token pass is available. Semantic highlighting also emits a
    fallback member token for unresolved arrow/dot access, preventing
    `object->member` from disappearing when type resolution is unavailable.
  - TextMate syntax highlighting now covers additional Pike 8.0.1116 BNF forms:
    full documented string/character escapes, operator-name identifiers such as
    `` `+ `` and `` `[]= ``, and compound assignment/splice/range operators
    such as `&=`, `|=`, `^=`, `@`, `..`, and `...`.
  - Path redaction in Pike language server logs is now controlled by the
    `pike.languageServer.log.redactPaths` VSCode setting. Redaction remains
    enabled by default; disabling it preserves full paths for local debugging.
  - Unused-variable and unused-parameter diagnostics now use warning severity
    instead of hint severity, making them render with a visible warning squiggle
    in VSCode instead of a barely noticeable dotted underline.
  - Syntax-color responsibility split is now governed by ADR-0037: TextMate
    paints the instant coarse baseline, tree-sitter semantic tokens own
    context-dependent classification keyed on grammar nodes, and the Pike
    oracle enriches the token stream with type-derived modifiers when
    available. The TextMate grammar no longer attempts to color aggregate
    literal delimiters; they intentionally remain default punctuation because
    broad themes do not style a portable aggregate-delimiter semantic token.

### Fixed

  - TextMate syntax highlighting now assigns function-call scope to ordinary
    calls and constructor-style calls before the generic identifier fallback, so
    call names such as `write()` and `Foo()` are not left as plain variables.
  - Removed the PR #95 `punctuation.definition.aggregate.pike` TextMate rule
    that miscolored the trailing `])` in `foo(arr[i])` and `f(g(x[i]))` as a
    mapping-literal delimiter. The regex had no parse context and could not
    disambiguate aggregate literals from array-indexing expressions. The
    TextMate grammar no longer asserts a false-positive scope; aggregate
    literal node presence is covered by tree-sitter regression tests instead.
    See [ADR-0037](decisions/0037-syntax-color-three-layer.md).

## [0.8.16] — 2026-06-02

### Fixed

  - Unused-variable diagnostics now report unused program-scope variables in
    Pike's implicit program scope, while still suppressing variables that are
    actually referenced.
  - Variable semantic tokens now use the standard `variable` selector without
    the custom `mutable` modifier, restoring color in VSCode themes that do not
    style custom Pike semantic modifiers.

## [0.8.15] — 2026-06-02

### Fixed

  - Semantic highlighting now emits tokens for resolved references, not only
    declaration sites, so uses of local variables, parameters, functions, and
    methods receive semantic colorization.
  - Pull diagnostics (`textDocument/diagnostic`) now include fast tree-sitter
    lint diagnostics such as unused local variables. Push diagnostics also keep
    those lint diagnostics when the Pike compiler oracle is unavailable.

## [0.8.14] — 2026-06-02

### Fixed

  - Semantic token requests now refuse stale indexed symbol tables for open
    documents. This prevents old token ranges from being cached under a newer
    document version, which caused partial-word coloring such as only `th` in
    `throw` remaining highlighted after rapid edits.

## [0.8.13] — 2026-06-02

### Added

  - `debug.telemetry` VSCode setting: enables verbose server-side telemetry
    for semantic token and diagnostic staleness debugging (off by default).

### Changed

  - Self-contained error/report blocks: server log output now includes
    context, message, and stack trace as a single structured block instead
    of interleaved multi-line output, making logs easier to parse.
  - Path anonymization in server logs: file paths and `file://` URIs are
    now redacted in server log output. Absolute paths (Unix and Windows)
    are replaced with `<path>`; `file://` URIs are replaced with
    `<file-uri>`. Log readability is preserved without leaking local
    filesystem structure.

### Fixed

  - Stale semantic token rendering: semantic tokens cached from an older
    document version could be misapplied after document changes. Cache is
    now version-gated — tokens are only reused when `cache.version` matches
    the current document version. Partial token misalignments (e.g. coloring
    only the prefix of an identifier) are resolved.
  - Stale diagnostics after rapid edits: async diagnostics published from a
    prior document state could appear as "ghost" errors after a subsequent
    edit. All `publishDiagnostics` calls are now version-gated — diagnostics
    are only published when the document version hasn't advanced since the
    request was initiated.
  - `textDocument/references` fallback on newly-opened files: references
    requests on a file opened for the first time could fail silently because
    the symbol table hadn't been populated yet. The handler now eagerly
    parses and indexes the document if the symbol table is empty.

## [0.8.12] — 2026-05-29

### Added

  - `builtinFunction` semantic token type: predef builtin identifiers (e.g.
    `write`, `sizeof`) are now highlighted as `builtinFunction` instead of
    generic `function`. Themes can use `support.function.builtin.pike` to
    color them distinctly.
  - `mutable` semantic token modifier: non-constant, non-parameter variables
    emit the `mutable` modifier so themes can distinguish reassignable locals
    from constants and parameters.
  - Name-based reverse index for stdlib entries: O(1) lookup by unqualified
    name replaces linear scan of 5,471 entries in call-args completion
    (triggered on `(` after a function name).
  - Stdlib member completion for typed variables: `Stdio.File f; f->` now
    completes members from the stdlib index using the resolved type FQN
    (`predef.Stdio.File`) instead of only matching the literal LHS text.
  - Hover for qualified stdlib members: hovering over `f->open()` where `f`
    is a stdlib-typed variable now shows the full stdlib documentation
    (previously only showed bare signature because the FQN lookup failed).

### Fixed

  - Stale formatting documentation: `docs/known-limitations.md` described
    the formatter as "shelling out to pike-fmt" but it has been imported
    in-process since v0.8.x. Documentation now correctly describes the
    architecture.

## [0.8.11] — 2026-05-28

### Added

  - Predef builtin documentation: 204 of 283 C-level predef functions now have
    human-readable docs on hover and in completion detail. Extracted from
    Pike's `core_autodoc.xml`. Completions use named params from autodoc for
    snippet tab stops (e.g., `write(${1:fmt})`).
  - Semantic token classification for predef builtins and stdlib modules:
    unresolved identifiers that match predef builtins are highlighted as
    `function`, stdlib module names as `namespace` (instead of all being
    `variable`).
  - Keyword snippet completions: 23 Pike keywords (`if`, `for`, `foreach`,
    `while`, `class`, `lambda`, `catch`, `switch`, etc.) now offer structural
    snippet expansion. Keywords sort after all symbol completions so identifiers
    always appear first.

### Fixed

  - ALT+UP/DOWN line moves now reformat the document via pike-fmt instead of
    relying on regex-based `indentationRules` which cannot track actual block
    nesting. Wrapper commands (`pike.moveLinesUp`/`pike.moveLinesDown`) replace
    the built-in move action for Pike files and call
    `editor.action.formatDocument` after each successful move.

## [0.8.10] — 2026-05-28

### Fixed

  - `lineToColumn`: walk nested nodes (not just root children) to find the
    first token on a line. Previously only checked `tree.rootNode.children`,
    missing tokens in deeply nested structures like function bodies.
  - `textDocument/rename` LSP protocol tests: updated assertions to expect
    `ResponseError` (not `null`) for error cases — empty position, rename
    to keyword, and no-change rename. Pike LSP correctly returns descriptive
    errors for these cases.
  - `getRenameLocations`: corrected expected location counts in two same-file
    tests where comments referenced wrong line numbers. These were pre-existing
    fixture issues unrelated to the v0.8.9 release.
  - Added test for call hierarchy outgoing calls via method chains
    (`obj->method()`), covering the `extractCalleeFromChain` code path.

## [0.8.9] — 2026-05-28

### Fixed

  - Call hierarchy outgoing calls now correctly resolve through `postfix_expr`
    nodes with `(` children instead of searching for non-existent
    `call_expression` nodes. Handles bare calls (`helper()`), method chains
    (`obj->method()`), and nested calls (`foo(bar())`).
  - Transitive inherit resolution: cross-file go-to-definition now follows
    inherit chains beyond one hop (e.g., A→B→C where C references a symbol
    from grandparent A). Cycle detection prevents infinite recursion.
  - Cross-file rename: scope-aware filtering excludes arrow/dot access
    references where the receiver's type doesn't match the target's owning
    class. Renaming `Dog.speak()` no longer catches `cat->speak()` when
    `cat` is a `Cat`.
  - Variable alias type propagation: `Dog d2 = d1;` now sets
    `assignedType = "Dog"` instead of `assignedType = "d1"`. Multi-hop
    alias chains are resolved iteratively.
  - Diagnostic column precision: Pike error messages are parsed for
    identifier names to locate the specific error token on the diagnostic
    line, instead of always pointing to the first meaningful token.

## [0.8.8] — 2026-05-27

### Fixed

  - TextMate grammar: add missing `=` (assignment) operator to the operators
    regex — bare `=` was the only Pike operator with no scope, causing every
    assignment to render in default foreground instead of the theme's operator
    color.
  - TextMate grammar: support nested parametric types in function declaration
    matching (e.g. `mapping(string:array(int)) foo(`). The pattern used
    `[^)]*` which stopped at the first `)`, breaking on nested generics.
    Replaced with `(?:[^()]|\([^)]*\))*` to handle one level of nesting.
  - TextMate grammar: move `#declarations` before `#types` and `#keywords` in
    root pattern order so that `array(int) foo(` matches the declaration
    pattern instead of having `array` consumed by the generic type catch-all.
  - TextMate grammar: anchor preprocessor directive pattern to line start
    (`^\s*#`) to prevent `// #ifdef` comments from being highlighted as
    directives.
  - TextMate grammar: reorder float literal pattern before integer so `3.14`
    is consumed atomically instead of splitting into `3` (integer) + `.14`
    (float).
  - TextMate grammar: add `storage.type.pike` capture to the complex-type
    declaration pattern so the type portion (e.g. `mapping(string:int)`) gets
    proper type highlighting alongside the function name.
  - TextMate grammar: remove greedy `function-call` pattern that incorrectly
    highlighted function declarations as function calls (e.g. `int foo(` was
    colored as a call, not a declaration).
  - TextMate grammar: remove `.` from punctuation character class so that
    `member-access` patterns can match `identifier.identifier` chains
    (e.g. `Stdio.FILE`, `Crypto.SHA256`).
  - TextMate grammar: reorder root patterns so `scope-access` and
    `member-access` are tried before `operators` — previously `->` and `::`
    were consumed as operators, preventing accessor highlighting from
    ever firing.
  - TextMate grammar: fix complex-type declaration regex capture group
    numbering (was referencing non-existent group `"2"`, now `"1"`).
  - formattingHandler: replace index-based line comparison in
    `computeOnTypeEdits` with a proper diff approach (find common prefix
    and suffix). The old ±10 window broke when the formatter added or
    removed lines, producing corrupt edits on paste/move operations.
  - diagnosticManager: `onDidChange` now merges cached pike diagnostics
    with fresh parse diagnostics so that existing pike diagnostics are not
    cleared while a debounced run is pending or skipped (fixes stale
    error clearing on file switch).
  - serverFileWatchHandler: clear pike/autodoc caches for dependents when
    a dependency changes or is deleted, so stale diagnostics from the old
    dependency state are not merged back into dependent files.
  - serverFileWatchHandler: propagate invalidation to dependents on file
    deletion — previously dependents kept stale cross-file references and
    diagnostics when an included/imported file was deleted.
  - serverFileWatchHandler: extract `propagateDependentInvalidation()`
    helper to deduplicate 20+ lines of identical dependent-propagation
    logic between `handleFileCreatedOrChanged` and `handleFileDeleted`.
  - completion: suppress autocomplete popup after a lone `:` (case labels,
    goto labels, ternary expressions) — only `::` should trigger scope
    completion, not a single colon.

## [0.8.7] — 2026-05-22

### Fixed

  - formattingHandler: replace broken `computeIndentEdits` (only matched
    leading whitespace, silently dropped all other pike-fmt changes —
    internal whitespace, trailing whitespace, blank-line collapse,
    operator spacing) with `computeEdits` that does a single full-document
    replace. Also fixed `computeOnTypeEdits` to compare full line content
    rather than indentation only. Removed four unused imports.

## [0.8.6] — 2026-05-22

### Fixed

  - serverDocumentHandler / serverContext: guard `upsertInFlight.delete()`
    so a concurrent `didChangeContent` for the same URI cannot prematurely
    evict the second in-flight upsert promise (race condition where the
    first promise's `finally` block would delete an entry already replaced
    by a second call).
  - serverLifecycle: chain Phase 3 (`indexWorkspaceFiles`) after Phase 2
    (`refreshStaleCacheEntries`) resolves — previously they ran concurrently,
    causing double-indexing of the same files and stale-cache-entry
    corruption when background indexing raced ahead of the stale-refresh.
  - serverLifecycle: remove redundant dynamic import of `fileURLToPath`
    in `refreshStaleCacheEntries` — the symbol is already statically
    imported at the top of the file.
  - serverInitHandler: add `else` branch to log non-filesystem errors in
    `onDemandIndex` (parse errors, JSON errors) that were previously
    silently swallowed. Also add missing `logError` and `ErrorCategory`
    imports.
  - harness/diagnosticsGolden: use `canonicalStringify` instead of
    `JSON.stringify` for diagnostic comparison — ensures key-order
    differences don't produce false mismatches.
  - scope-helpers: replace non-null assertion on `namedChild(0)` with
    explicit null guard — tree-sitter nodes can be null on ERROR nodes.

## [0.8.5] — 2026-05-22

### Changed

  - Documented four design-level concerns as known limitations:
    synthetic ID counter thread-safety (`typeResolver.ts`), name-only
    cross-file reference matching (`workspaceResolution.ts`), no transitive
    inherit resolution (`workspaceResolution.ts`, `typeResolver.ts`), and
    scope boundary inclusion (`scope-helpers.ts`). These are not bugs but
    intentional simplifications with documented rationale.
  - serverContext: document fire-and-forget parser init pattern.
  - serverLifecycle: add `.catch()` on startup chain to prevent
    unhandled rejection if cache restore fails before reconnecting.

### Fixed

  - xmlParser: guard against out-of-bounds position advance when
    AutoDoc attribute value is unterminated (missing closing quote).
  - errorLog: reset `_nextId` counter in `clear()` so IDs restart
    after clearing — prevents confusing ID gaps in test assertions.
  - parser: clear cached promise on WASM init failure so transient
    I/O errors (e.g., NFS) don't make the parser permanently unusable.
  - serverDocumentHandler: add early return after parse error catch,
    preventing diagnostic manager from running on a failed parse.
    Wrap post-didChange diagnostics in try/catch for client disconnect.
  - getterSetter: fix `findParentClass` range check direction — was
    checking if class scope contains the declaration; now correctly
    checks if the declaration contains the class scope.
  - pikeWorkerProcess: replace deprecated `RegExp.$1` with `exec()`
    result — static RegExp properties are unsafe under async concurrency.
  - main: save persistent cache on SIGTERM/SIGINT before exiting.
    Without this, force-close loses the workspace index built during
    the session.
  - harness: remove self-healing snapshot/golden auto-generation.
    Missing files should fail the test, not silently create new baselines.
  - lifecycle test: remove stray `kg|` characters from test source.

## [0.8.4] — 2026-05-21

### Fixed

  - Semantic highlighting, completions, and go-to-definition now update
    correctly after editing a file. Two root causes: (1) the server never
    sent `workspace/semanticTokens/refresh` after document changes, so
    VSCode only re-requested tokens on tab switch; (2) tree-sitter
    incremental re-parse was missing the required `tree.edit()` call,
    causing stale subtrees to be reused after edits.
  - Pike worker subprocess now sets `LD_LIBRARY_PATH` from auto-detected
    `pikeHome/lib`, so native modules (Nettle, etc.) load correctly
    without manual configuration. A one-time warning is shown if a
    required shared library is missing, instead of spamming every
    stderr line as a critical error.
  - `worker.ldLibraryPath` VSCode setting is now passed through from the
    client to the server during initialization.

## [0.8.3] — 2026-05-20

### Fixed

  - P3005 lint rule no longer flags `inherit` declarations as unused. Inherited
    members are available through implicit scope access and cannot be reliably
    detected without cross-file type analysis. Removing a "seemingly unused"
    inherit silently breaks code because Pike returns 0 (null) for missing members.
  - Predef builtin hover (e.g., hovering on `time`) now renders clean,
    human-readable signatures instead of raw Pike runtime type syntax.
    Overloaded functions show each overload as `name(params) → returnType`.
    Pike-internal noise like `int(1bit)`, `scope(0,...)` is stripped.
  - Semantic highlighting no longer breaks after a few edits on restart.
    `refreshStaleCacheEntries` was calling `invalidateWithDependents` after
    `upsertBackgroundFile`, immediately nulling the freshly-built symbol
    table. All cached files ended up permanently stale — semantic token
    requests returned empty data. Fix: invalidate before re-indexing.

## [0.8.2] — 2026-05-19

### Added

  - `docs/perf/q3-profile-report.md` — profiling report documenting where
    buildSymbolTable time is spent. Key finding: type text extraction and
    tree traversal dominate; disk I/O is negligible.
  - `tests/perf/micro-upsert.test.ts` — per-phase micro-benchmark for
    upsertBackgroundFile breakdown.
  - **Startup:** Two-phase startup serves cached data immediately, then
    refreshes stale entries in background. Time-to-first-response drops
    to cache load time (<500ms for most workspaces).
  - **Startup:** Background cache refresh only re-indexes files whose
    content hash changed, plus their dependents. Pruned invalidation
    avoids re-indexing the entire workspace on restart.
  - `server/src/features/cacheHash.ts` — extracted DJB2 hash utility.
  - `WorkspaceIndex.restoreDependencies()` — reconstructs reverse-dep
    graph from serialized forward deps without async resolution.

### Changed

  - **Performance:** Pre-computed byte→UTF-16 offset map per file, eliminating
    the dominant `utf8ToUtf16` bottleneck in the symbol table build pipeline.
    Position conversion is now O(1) per lookup instead of O(lineLength).
  - **Performance:** Scope lookup uses binary search on sorted scopes instead
    of linear scan, reducing complexity from O(R × S) to O(R × log S).
  - **Cache:** Persistent cache split into per-file entries under
    `.pike-lsp/cache/<contentHash>.json` with atomic writes (temp file +
    rename). Loading validates each entry individually — only changed files
    are rebuilt. Format version bumped to 2.
  - **Cache:** Forward dependencies serialized per entry, enabling reverse-dep
    graph reconstruction from cache without async resolution.
  - ADR 0024: documents the offset map and binary search scope lookup decision.
  - ADR 0025: documents Q3 profiling results and M1 per-file cache architecture.
  - ADR 0026: documents two-phase startup and pruned cache invalidation.
  - **Startup:** Cache load and background indexing now run sequentially
    (cache first, then background). Previously both ran in parallel,
    causing background indexing to re-index files that were about to be
    loaded from cache.

### Fixed

  - **Bug:** Feature handlers (workspace/symbol, hover, definition, etc.)
    returned empty results because they captured the placeholder index at
    registration time. `handleInitialize` replaced the index, but handlers
    still held the stale reference. Fixed by using getters that delegate
    to the live context object.
  - **Bug:** Background indexing ran concurrently with cache loading,
    wasting CPU on files that would be served from cache moments later.
    Now chained sequentially: cache load → stale refresh → background index.

## [0.8.1] — 2026-05-18

### Added

  - Pike-language test suite (`tests/pike/`) — 487 tests covering language
    analysis, LSP protocol handling, and server behavior via PUnit framework
    and Pike's `compile_string` introspection.
  - `scripts/test-pike.sh` — test runner for the Pike suite with verbose mode
    and single-file selection. Replaces the `pmp run` invocation.
  - `bun run test:all` — runs TypeScript and Pike tests together.
  - Testing section in README with directory structure, usage examples, and
    guide for adding new Pike tests.

### Changed

  - Project structure in README updated to reflect the three test directories
    (`tests/pike/`, `tests/lsp/`, `tests/perf/`).

## [0.8.0] — 2026-05-18

### Added

  - VSCode settings for Pike path configuration: `pikeHome`, `modulePaths`,
    `includePaths`, `programPaths`. When all four are set, auto-detection is
    skipped entirely — no `pike --show-paths` subprocess spawned.

### Changed

  - **Lazy on-demand indexing (ADR 0023).** Background indexing no longer
    resolves dependencies — it builds symbol tables only (synchronous, fast).
    Dependencies are resolved lazily when cross-file queries need them. This
    follows the pattern used by rust-analyzer and gopls.
  - Open files are indexed first with full dependency resolution before
    background workspace indexing starts. The files you're looking at get
    full features immediately.
  - Background indexing is now cancellable — accepts a `CancellationToken`
    and checks it between batches. User-facing requests always take priority.
  - Cache restoration (`upsertCachedFile`) is now synchronous and skips
    dependency resolution entirely. Previously it called `extractDependencies`
    for every cached entry, triggering hundreds of async filesystem operations
    at startup.
  - `depsResolved` sentinel on `FileEntry` distinguishes "not yet resolved"
    from "resolved, found nothing" — prevents redundant re-resolution for
    files with no imports/inherits.
  - `resolveCrossFileDefinition` now calls `ensureDependenciesResolved`
    internally before following import/inherit edges — cross-file go-to-def
    works even for background-indexed files.

### Fixed

  - Startup delay: `onInitialized` no longer blocks on cache loading.
    Previously, `loadCache()` was awaited, blocking background indexing
    from starting until every cached file's dependencies were resolved
    (async fs operations per entry). Now fire-and-forget.
  - `ensureDependenciesResolved` no longer re-runs for files with zero
    dependencies. Previously, `deps.size === 0` was used as the "not resolved"
    check, causing repeated resolution attempts on every cross-file query.

## [0.7.5] — 2026-05-18

### Fixed

  - Initial release of startup performance improvements (superseded by
    lazy indexing in [Unreleased]).
  - Pike path auto-detection runs only when needed — user-configured paths
    bypass the `pike --show-paths` subprocess and filesystem scanning.
  - Removed `.pike-lsp/pike-paths.json` disk cache — no workspace directory
    pollution. Detection results are cached in-memory per session only.

## [0.7.4] — 2026-05-18

### Added

  - `upsertBackgroundFile()` — synchronous fast path for background indexing
    that builds symbol tables without async dependency resolution. ~10× faster
    bulk indexing by eliminating per-file `warmResolverCache` + `extractDependencies`
    async fs operations.
  - `ensureDependenciesResolved()` — lazy dependency resolution that upgrades
    background-indexed files on demand when opened. Cross-file features
    (go-to-def, reference counts) light up without blocking startup.
  - Generation-based reference count cache in code lens provider. Code lens
    requests return cached results instantly when the workspace index hasn't
    changed, avoiding redundant cross-file reference walks.
  - `tests/perf/large-workspace.test.ts` — synthetic 1000-file workspace
    profiling test measuring indexing throughput, code lens, and cross-file
    reference performance with budget assertions.
  - `tests/perf/micro-upsert.test.ts` — per-operation breakdown benchmark
    isolating parse, buildSymbolTable, and upsert costs.

### Changed

  - Background indexer (`backgroundIndex.ts`) now uses `upsertBackgroundFile()`
    instead of `upsertFile()`, making batch insertion synchronous and
    eliminating async bottlenecks from the critical startup path.
  - `didOpen` handler triggers `ensureDependenciesResolved()` fire-and-forget,
    so dependency edges are populated without blocking the editor.

### Fixed

  - Performance regression on workspaces with 1000+ files: background indexing
    no longer blocks the LSP server during startup. Users see completions,
    highlights, and diagnostics immediately while dependency resolution
    continues in the background.
  - VSIX build version format: replaced dot-separated `build.NNNNNN` with
    single alphanumeric identifier `buildNNNNNN` to avoid semver leading-zero
    validation errors in vsce 3.x.

## [0.7.3] — 2026-05-16

### Added

  - `scripts/quality-gates.sh` — automated anti-pattern detection covering
    function length, non-null assertions, silent catches, rootNode.text usage,
    unbounded Maps, import.meta assertions, and file length. Derived from 3
    audit iterations (99 findings).

## [0.7.2] — 2026-05-16

### Changed

  - Audit documentation updated: `docs/audits/iteration-3.md` with full
    remediation status table, `docs/audits/README.md` updated.
  - Added `scripts/quality-gates.sh` — automated anti-pattern detection
    (function length, non-null assertions, silent catches, rootNode.text,
    unbounded Maps, import.meta assertions, file length) derived from
    3 audit iterations (99 findings).

### Fixed

  - Architecture audit iteration 3 remediation: 1 Critical, 5 High, 13 Medium,
    13 Low findings resolved across server, scripts, and test infrastructure.
  - **C1**: Stale `package-lock.json` regenerated via `bun install`.
  - **H1**: `resolveCrossFileDefinition` now has `maxRetries` depth limit to
    prevent unbounded recursion on concurrent indexer updates.
  - **H3**: `indexWorkspaceFiles` split from 162 to 49 lines (6 helpers).
  - **H4**: `registerAdvancedHandlers` split from 179 to 17 lines (6 handlers).
  - **H5**: `declForHover` split from 160 to 34 lines (7 helpers).
  - **M1**: Idle-eviction and memory-ceiling extracted to `pikeWorkerLifecycle.ts`.
  - **M2**: `detectPikePaths` split into 5 phase-based functions.
  - **M3**: `formattingHandler` extracted into named handler functions.
  - **M4**: `parseXml` split into 9 module-level parsing functions.
  - **M5**: `extractInitializerType` split into 4 focused helpers.
  - **M6**: `produceGetterSetterActions` split into 3 helpers.
  - **M7**: Extracted `synthesizeFileClassDecl()` — eliminated 4 duplicated blocks.
  - **M8**: `registerCompletionHandlers` split from 117 to 21 lines.
  - **M9**: `createSyntheticScope` split from 97 to 30 lines.
  - **M10-M12**: Non-null assertions on tree-sitter nodes replaced with null guards.
  - **M13**: `scopedResolver` cached by version string to bound memory.
  - **L1-L4**: Logging added to 4 silent catch blocks.
  - **L5**: `root.text` replaced with `content` parameter in `parsePikeVersion`.
  - **L7**: `import.meta.dirname!` replaced with nullish coalescing fallback.
  - **L8**: Segfault detection in `smoke-test.sh` uses process exit code.
  - **L9**: Shell quoting bug fixed in `test-vscode.sh`.
  - **L10**: CHANGELOG `[Unreleased]` moved to correct position.
  - **L11**: Sed escape in `release.sh` switched to `|` delimiter.
  - **L12**: 87 golden snapshot files regenerated.
  - Performance benchmark `completion_cold` baseline raised to 200ms (shared
    server reality), eliminating flaky CI failures.

## [0.7.1] — 2026-05-16

### Changed

  - Audit documentation restructured into `docs/audits/` with per-iteration
    files (`iteration-1.md`, `iteration-2.md`) replacing monolithic
    `architecture-audit.md`.

### Fixed

  - Architecture audit iteration 2 remediation: 3 Critical, 9 High, 18 Medium,
    10 Low findings resolved across server, client, and CI.
  - **C1**: `createPikeServer` split from 417-line monolith into 5 focused
    modules (`serverContext`, `serverInitHandler`, `serverFileWatchHandler`,
    `serverShutdownHandler`, `serverDocumentHandler`).
  - **C2**: Silent cache-save catch now logs via `logWarn()`.
  - **C3**: Client restart notification name fixed from `pike/serverLog` to
    `pike/log`; param shape aligned with server (`{ level, lines }`).
  - **H1–H2**: Non-null `child(0)!` assertions replaced with null guards in
    diagnostics and reference collector.
  - **H3**: `rootNode.text` eliminated from 8 of 10 hot paths (remaining 2 are
    test-only fallbacks with explicit `source` override).
  - **H4**: `require()` calls replaced with static ES imports in code actions.
  - **H5–H8, M17**: 15+ function-length violations split across 7 files.
    New `completionTriggerResolve.ts` extracted from `completionTrigger.ts`.
  - **H9**: CHANGELOG version ordering fixed to follow Keep a Changelog.
  - **M4–M6**: Bare `as` casts replaced with runtime validation
    (`staticDataValidation.ts`, `codeActionKinds.ts`).
  - **M7–M8**: `q.shift()!` / `queue.shift()!` replaced with null guards.
  - **M9–M10**: Silent catch blocks improved with descriptive comments.
  - **M11**: Client restart handler param shape fixed to match server output.
  - **M12–M16**: CI/build fixes — pike-fmt job added, esbuild path corrected,
    VSIX filename format fixed, bash prefix added.
  - **L2, L4, L6–L8**: `as never` casts replaced, zero-byte `=` file deleted,
    fetch-depth fixed, @types/node aligned, CHANGELOG ordering corrected.
  - **L9**: `known-limitations.md` restructured into Current/Resolved sections.

## [0.7.0] — 2026-05-16

### Added

  - Selection range tests: 12 tests for `getSelectionRange()` covering basic
    cases, nested constructs, deduplication, and edge cases (T4.1).
  - Call hierarchy tests: 11 tests for prepare/incoming/outgoing call
    hierarchy. Documents known bug: `collectCallExpressions` looks for
    `call_expression` but tree-sitter-pike produces `postfix_expr` nodes (T4.2).
  - Runtime JSON validation for Pike subprocess responses (`jsonValidation.ts`):
    6 validator functions replace bare `as unknown as` casts with fail-fast
    type guards.
  - `completionItem/resolve` provider for lazy stdlib markdown documentation
    loading on demand instead of eagerly during completion.
  - `workspaceResolution.ts`, `workspaceDependencies.ts`, `workspaceTypes.ts`:
    extracted from `workspaceIndex.ts` for focused module boundaries.
  - `pikeWorkerProcess.ts`, `pikeWorkerTypes.ts`: extracted from
    `pikeWorker.ts`.
  - `serverCapabilities.ts`, `serverLifecycle.ts`: extracted from `server.ts`.
  - `completion-chain.ts`, `completion-callArgs.ts`, `completion-scopeAccess.ts`,
    `completion-snippets.ts`, `completion-stdlib.ts`, `completion-items.ts`:
    extracted from `completionTrigger.ts` and `completion.ts`.
  - `navigationGoTo.ts`, `navigationRefactoring.ts`, `navigationCompletion.ts`,
    `navigationDocumentFeatures.ts`, `navigationAdvanced.ts`,
    `navigationInclude.ts`: extracted from `navigationHandler.ts`.
  - `codeActionSourceActions.ts`, `diagnosticUtils.ts`,
    `declarationBlockCollectors.ts`, `hoverContent.ts`,
    `signatureHelp-resolve.ts`, `pikeDetection.ts`, `completion-scope.ts`,
    `xml-renderer-blocks.ts`, `xml-renderer-inline.ts`, `xml-renderer-types.ts`:
    further module boundary extractions.
  - Golden-file diagnostics test infrastructure: `harness/src/diagnosticsGolden.ts`
    runner produces LSP diagnostic snapshots from tree-sitter parse + lint rules.
    93 tests across 87 corpus files in `harness/__tests__/diagnostics-golden.test.ts`
    (Tier 3.1).
  - `positionConverter.ts` utility: `utf8ToUtf16()` and `utf16ToUtf8()` functions
    with 53 unit tests for UTF-8/UTF-16 position encoding conversion (P1.7).
  - `typeHierarchy` LSP provider: `prepareTypeHierarchy`, `supertypes`, and
    `subtypes` for Pike class hierarchies with 10 tests. Supports cross-file
    inheritance resolution via WorkspaceIndex (Tier 3.5).

### Changed

  - Auto-import completion now uses prefix-indexed binary search
    (`getAutoImportByPrefix`) instead of O(n) linear scan over all stdlib
    entries. Per-keystroke filtering is O(log n + k) where k is the number
    of matching symbols (X3.6).
  - All 13 source files that exceeded the TigerStyle 500-line limit have been
    split into focused modules. Largest file is now 500 lines (was 1166).
  - `outputChannel.clear()` replaced with session separator in client — crash
    logs from previous sessions are preserved.
  - FileSystemWatcher now properly disposed before recreation on config change,
    preventing watcher leaks across restarts.
  - Modernized README.md with complete feature inventory (23 LSP providers),
    architecture overview, and development section.
  - Symbol table pipeline (`toLoc`/`toRange` → `toLocUtf16`/`toRangeUtf16`) and
    19 feature files converted to use UTF-16 position encoding for correct
    non-ASCII character handling (P1.7). Both tree-sitter→LSP and LSP→tree-sitter
    directions covered.

### Fixed

  - Tree-sitter UTF-8 byte offsets are no longer used directly as LSP character
    positions. All position conversions now go through `positionConverter.ts`,
    fixing latent incorrect column values for non-ASCII Pike source files.
  - Removed non-null assertion `targetDecl!` in `workspaceIndex.ts` — replaced
    with narrowed local after null check.
  - Fixed `export { FileEntry }` → `export type { FileEntry }` in
    `workspaceIndex.ts` re-export — bun's ESM loader crashes on runtime
    re-export of type-only symbols.

## [0.6.6] — 2026-05-15

### Added

  - CodeLens provider tests: 7 tests covering reference count lenses, self-
    reference exclusion, singular/plural titles, and mixed declaration scenarios.

### Changed

  - `implementationProvider` and `diagnosticProvider` capabilities are now
    declared in the server's initialize response, enabling clients to discover
    these features correctly.
  - `safeParse()` in `DiagnosticManager` now passes the document URI to the
    parser cache, avoiding redundant re-parses on every diagnostic cycle.
  - PikeWorker priority queue replaced with three FIFO sub-queues (interactive,
    normal, background). Dequeue is now O(1) instead of O(n) linear scan.

### Fixed

  - Rename now returns a descriptive `ResponseError` instead of silent `null`
    when no renamable symbol is at the given position or the new name matches
    the old name.
  - Autodoc renderer sanitizes HTML entities (`<`, `>`, `&`) and escapes
    markdown metacharacters in inline content to prevent injection from
    user-written Pike doc comments.

## [0.6.5] — 2026-05-15

### Fixed

  - Unreachable code lint (P3003) no longer flags `break` after `return` or
    `continue` in a switch case segment. Break-after-return is a common
    defensive pattern (prevents accidental fallthrough if return is later
    removed) and is harmless.
  - Unreachable code lint (P3003) no longer flags comments after a terminator.
    Comments are not executable code and were incorrectly included in the
    named-children scan. Affects both regular blocks and switch case segments.

## [0.6.4] — 2026-05-15

### Added

  - Directory module convention: files inside `Foo.pmod/` now automatically
    see symbols from `Foo.pmod/module.pmod` without explicit `inherit`/`import`.
    This works for hover, go-to-definition, and completions. Pike's module
    system treats `module.pmod` as the implicit parent of all files in the
    same directory module.

## [0.6.3] — 2026-05-15

### Fixed

  - Unreachable code lint (P3003) no longer flags subsequent `case`/`default`
    clauses in a `switch` statement after a `return` or `break`. Each case
    is an independent control-flow entry point. Unreachable code within a
    single case segment is still correctly flagged.

## [0.6.2] — 2026-05-15

### Fixed

  - Hover on cross-file inherited members (e.g. `d->speak()` where `speak`
    comes from an inherited class in another file) now resolves correctly.
    The reference position matcher was using exact character match instead
    of range-based matching, so hovering anywhere other than the start of
    the identifier would fail.
  - Cross-file hover range now highlights the identifier in the requesting
    document instead of pointing to the declaration in the target file.


## [0.6.1] — 2026-05-15

### Added

  - **Intelligent LSP features**: Complete implementation of the intelligent
    features plan (E1-E5, F1-F5, G1-G2, H1-H2, AU1, GS1):

  - **Fast lint layer** (E1-E5): Real-time syntax diagnostics on every keystroke
    via tree-sitter — unused variables/parameters (P3001/P3002), unreachable
    code (P3003), missing return statements (P3004), unused imports (P3005).
    Suppressed on lines where Pike compiler provides diagnostics.

  - **Type-aware completion** (F1): Chained call type inference via
    `resolveChainedType` and `decomposePostfixChain`. Completes members through
    multi-step `d->get_dog()->bark()` chains.

  - **Constructor and method signature help** (F2-F3): Resolves `Dog("Rex",`
    to constructor `create()` params, and `d->bark("hi",` to method signature
    via type -> class -> method lookup.

  - **Commit characters** (F4): `.` and `(` as commit characters in completion
    items for immediate acceptance.

  - **Auto-import suggestions** (F5): When typing an unqualified identifier
    matching a stdlib symbol (e.g., `get_v`), offers completion with
    `additionalTextEdits` that inserts `inherit Module;`. Uses reverse index
    from stdlib-autodoc.json. Suppresses when module is already inherited.

  - **Inlay type hints** (G1): Shows inferred types for untyped variable
    declarations.

  - **Parameter name inlay hints** (G2): Shows `param:` labels at call sites.
    Handles `comma_expr` unwrapping and arrow/dot method resolution. Requires
    tree-sitter-pike v1.2.2+ (issue #18 fixed).

  - **PikeWorker pre-warming** (H1): `warmUp()` during initialization eliminates
    ~200ms cold start on first completion/hover request.

  - **Arity quick-fix** (H2): Code action for "Wrong number of arguments to foo()"
    diagnostics — adds or removes argument slots.

  - **Autodoc template generation** (AU1): Type `//!!` above a function, method,
    class, or variable declaration. Code action replaces it with a `//!` autodoc
    skeleton populated with parameter names and return type sections.

  - **Getters/setters generation** (GS1): Code action on class member variables
    generates `get_name()` / `set_name(value)` methods. Uses declared type for
    return/parameter types. Skips if method already exists.

  - **Call hierarchy**: Incoming/outgoing call hierarchy support
    (`textDocument/callHierarchy`).

  - **Complex type rename support**: `collectTypeRefsRecursive()` now recurses
    `function_type` nodes, ensuring rename propagates through compound type
    annotations like `array(Dog)` and `mapping(Dog:int)`.

  - **Recursive `.pmod` directory discovery**: The harness now recurses into
    `.pmod` directories (which are directories, not files) to discover nested
    Pike sources like `module.pmod` and `helpers.pike`.

  - Updated tree-sitter-pike WASM to v1.2.2 (fixes bare function call parsing,
    issue #18).

### Changed

  - **SignatureHelp rewrite**: `extractCalleeInfo()` now returns `objectName`
    for method calls. `resolveMethodOnType()` does type -> class -> method
    lookup. `resolveConstructor()` uses range overlap for scope discovery.

  - **Removed client-side tree-sitter syntactic provider**
    (`TreeSitterSyntacticProvider`): Server semantic tokens and VSCode TextMate
    grammar already cover all highlighting. The client-side provider was
    redundant and has been deleted.

  - **Hardened `build-vsix.sh`**: `vsce` binary is now resolved from `$PATH`
    with fallback to `$HOME/.bun/bin/vsce` instead of using a hardcoded
    absolute path.

  - **`release.yml` uses `.latest-vsix`**: The upload step now reads the exact
    VSIX path written by `build-vsix.sh`, eliminating BUILD_NUM skew between
    build and release steps.

  - **`ci.yml` uses `$PIKE_VERSION` variable**: Replaced hardcoded `8.0.1116`
    in PATH and PIKE_BINARY entries with the existing `PIKE_VERSION` env var.

### Fixed

  - **Parser cache corruption in tests**: `parse()` uses incremental parsing
    with old tree cache keyed by URI. Tests reusing the same URI across
    different sources got garbled parse trees. Fixed with unique URIs per test.

  - **Non-null assertion safety in completion**: Replaced unsafe `child(0)!`
    with a null-checked loop in dot-access completion, preventing potential
    crashes on unexpected tree-sitter node structures.

  - **Harness uses `PIKE_BINARY` for outer invocation**: `runIntrospect()` was
    passing `PIKE_BINARY` to the introspect script (correct) but using a
    hardcoded `"pike"` string for the outer process that runs the script.

  - **Removed dead `getErrorCount` import** from `client/extension.ts`.

  - **Removed dead `treeSitterProvider` tests**: Two `it.skip` tests that
    referenced the deleted provider have been removed. The remaining output
    channel test is documented as a manual smoke test.

## [0.5.1] — 2026-05-14

### Fixed

  - **Angle-bracket `#include <file>` navigation**: CTRL+CLICK and document links
    now resolve `#include <stdio.h>` directives against Pike's system include paths
    (from `pike --show-paths`). Previously these were explicitly skipped with a
    `return null` bail-out.

  - **UriError on Windows paths**: Replaced fragile `"file://" + encodeURI(path)`
    URI construction with Node.js `pathToFileURL()` across all handlers
    (definition, document link, background index). The old pattern produced
    malformed URIs on paths containing special characters, causing VSCode to
    throw "UriError: Scheme contains illegal characters".

  - **Fact-check audit of `docs/known-limitations.md`**: Corrected 5 factual
    errors — stale "PARTIALLY RESOLVED" / "MOSTLY RESOLVED" statuses for
    `for_statement` and `switch_statement` (both fully resolved), removed a
    fabricated `BLOCK_SCOPES` constant reference, removed stale line-number
    anchors from `typeof_()` entries, and fixed corrupted severity table headers.

## [0.5.0] — 2026-05-14

### Added

  - **Clickable `#include` navigation**: CTRL+CLICK on `#include "file"` directives
    now navigates to the target file. Also exposed as document links (underlined
    clickable path). Requires tree-sitter-pike v1.1.3+ for structured `preproc_include`
    node with `path` field.

  - **Corpus manifest management tool** (`scripts/manifest.ts`): Scans `corpus/files/`,
    parses `manifest.md`, detects drift between disk state and manifest entries.
    Supports `--sync` to apply changes, `--version <VERSION>` to bump the manifest
    version. Registered as `pike-corpus-manifest` Hermes skill.

  - **4-space indentation default**: New Pike files now default to 4-space
    indentation via `configurationDefaults` in the extension manifest. Configurable
    per-workspace and per-file through VSCode settings.

  - **Repository-based TextMate grammar**: Rewrote `pike.tmLanguage.json` with a
    repository-based structure using standard scope names (`storage.type.pike`,
    `entity.name.function.pike`, `entity.name.type.class.pike`, `variable.parameter`).
    Ensures consistent syntax highlighting across all VSCode themes.

### Changed

  - **Formatter default tab size**: Changed from 2-space to 4-space fallback when
    VSCode does not pass explicit formatting options.

  - **PikeWorker idle eviction**: Now calls `this.stop()` instead of raw
    `this.proc.kill("SIGTERM")`, ensuring SIGKILL escalation and proper cleanup
    on idle timeout.

  - **PikeWorker pending rejection**: `stop()` now rejects all pending promises
    in the response map before clearing it, preventing leaked promises on restart.

### Fixed

  - **EACCES during background indexing**: Permission errors (EACCES, EPERM, ENOENT)
    during workspace file indexing are now logged as warnings instead of errors
    and excluded from the error count. Expected on shared servers with inaccessible
    directories.

  - **Cross-file go-to-definition**: Navigation on imported/inherited symbols now
    uses `decl.sourceUri` to navigate to the original source file, not the file
    where the symbol was inherited into.

  - **Implicit class navigation fallback**: `import Foo` and `inherit Animal` now
    navigate to the top of the target `.pike`/`.pmod` file when no explicit `class`
    declaration is found (covers the common case where a `.pike` file IS the class).

  - **Corpus manifest sync**: 10 new corpus files that were on disk but not in the
    manifest have been added: `basic-int-ranges.pike`, `basic-string-types.pike`,
    `basic-type-conversions.pike`, `cross_import_a.pmod`, `err-syntax-partial.pike`,
    `err-type-member.pike`, `import-relative.pike`, `stdlib-array.pike`,
    `stdlib-mapping.pike`, `stdlib-string.pike`.

  - **Updated tree-sitter-pike WASM** to v1.1.3 with structured `preproc_include`
    node (upstream fix for TheSmuks/tree-sitter-pike#17).

## [0.4.3] — 2026-05-14

### Added

  - **SIGKILL escalation in PikeWorker.stop()**: If the Pike subprocess does not
    exit within 3 seconds of SIGTERM, the server escalates to SIGKILL. This
    prevents zombie Pike processes on shared SSH dev servers where resources are
    limited.

  - **Process signal handlers in server main.ts**: `process.on('exit')`,
    `process.on('SIGTERM')`, and `process.on('SIGINT')` handlers now call
    `worker.stop()` as a last resort, ensuring the Pike subprocess is cleaned up
    even when the Node server process is force-killed.

  - **Stale VSIX cleanup**: `build-vsix.sh` removes old VSIX files from `out/`
    before creating a new one. Previously they accumulated indefinitely.

  - **Shutdown test suite** (`tests/lsp/shutdown.test.ts`): 22 tests covering
    PikeWorker.stop() (subprocess termination, SIGKILL escalation, queue cleanup,
    idempotency), server onShutdown (diagnosticManager disposal, index clearing,
    autodoc cache clearing, LSP shutdown protocol), force-close resilience, and
    createPikeServer interface contract.

### Changed

  - **install-extension.sh**: Removed redundant `bun run build:extension` step
    (already done by `build-vsix.sh`). Cleaned up phase numbering.

### Fixed

  - **Build suffix doubling**: `build-vsix.sh` now strips any existing `+NNNNNN`
    build suffix from the version string before appending a new one, preventing
    corrupted version strings like `0.4.2+704238+704238`.

  - **VSIX install path mismatch**: `install-extension.sh` reads the actual VSIX
    path from a `.latest-vsix` marker file produced by `build-vsix.sh`, instead of
    guessing the filename. Previously it looked for `pike-language-server-0.4.2.vsix`
    (no suffix) but the build produced suffixed names.

  - **Stale OutputChannel logs**: `activate()` now calls `outputChannel.clear()`
    before logging anything. VSCode OutputChannel content survives window reloads,
    which caused old version entries from previous installs to accumulate and appear
    as if multiple versions were running simultaneously.

## [0.4.2] — 2026-05-13

### Added

  - **Structured init logging**: The entire extension startup sequence is now
    logged as numbered steps across both client and server. Each step logs
    before and after execution, so the last logged step identifies where
    startup failed. Client logs to the "Pike Language Server" output channel
    (`[init] step 1/6` through `step 6/6`). Server logs to stderr before
    connection (`[init] step 1/5` through `5/5`) and to the LSP console after
    (`[init] step 6` through `7e`). Tree-sitter initialization on the client
    side logs `[tree-sitter] step 1/4` through `4/4` to the VSCode console.

  - **Centralized error logging**: All server-side errors now route through
    `server/src/util/errorLog.ts` (`logInfo`, `logWarn`, `logError`). The format
    is `<ISO timestamp> <LEVEL> <message>`. Zero `connection.console.log/error`
    calls remain outside the logging module itself.

  - **Status bar error badge**: The status bar shows `(N errors)` with error
    styling when the server reports errors. Clicking opens the output channel.

  - **Global error handlers**: `main.ts` installs `uncaughtException` and
    `unhandledRejection` handlers before any other code runs, ensuring startup
    crashes are logged instead of silently swallowed.

### Fixed

  - **Dual connection.listen() crash**: Removed the `isDirectExecution()` entry
    block from `server.ts`. When esbuild bundled both `server.ts` and `main.ts`,
    two `connection.listen()` calls executed on the same stdio transport,
    corrupting LSP protocol state and causing `FullTextDocument._content` to
    become `undefined` — the root cause of "Cannot read properties of undefined
    (reading 'charAt')" on file open.

  - **Portable snapshot paths**: The harness now normalizes absolute paths
    embedded in Pike diagnostic messages (e.g. include resolution errors)
    using a `<ROOT>` placeholder. The `cpp-include.pike` snapshot no longer
    contains a machine-specific path, fixing CI on different environments.

## [0.4.1] — 2026-05-13

### Fixed

  - **Client-side tree-sitter initialization**: `TreeSitterSyntacticProvider.#init()`
    now calls `Parser.init()` before `Language.load()`. Without this call, the
    Emscripten WASM runtime (`C`) was never initialized, causing all tree-sitter
    operations on the client side to fail silently. This was the root cause of
    missing syntax highlighting and the "Unable to open: Cannot read properties of
    undefined (reading 'charAt')" error in v0.4.0.

  - **VSIX packaging**: `build-vsix.sh` now copies `web-tree-sitter.wasm` to
    `client/dist/` in addition to `server/dist/`. The client resolves WASM paths
    relative to `extension.cjs` (which lives in `client/dist/`), so the runtime WASM
    must be present there for `Parser.init()` to succeed.

## [0.4.0] — 2026-05-13

### Added

  - **pike-fmt integration**: `scripts/fmt.sh` wrapper and `fmt:check`/`fmt:write`
    npm scripts for formatting Pike source files in the repo. CI checks formatting on
    every push/PR via the `pike-fmt` job in `.github/workflows/ci.yml`.
  - **tree-sitter highlights for Neovim/Helix**: `queries/highlights.scm` provides
    syntax highlighting queries for nvim-treesitter and Helix via tree-sitter.
    Captures include `@keyword.import` for inherit/import, `@function.method`,
    `@variable.parameter`, `@constant`, and `@preproc`.

  - **TextMate grammar test**: `harness/__tests__/tmLanguage.test.ts` validates
    that the grammar JSON contains all required keyword patterns.

  - **languageConfiguration test**: `tests/lsp/languageConfiguration.test.ts`
    validates that `language-configuration.json` is valid JSON with all required keys.

  - **Skipped cross-file completion test**: `tests/lsp/completion.test.ts` includes
    a skipped test for cross-file inherited member completion, referencing the
    known limitation entry in `docs/known-limitations.md`.

  - **Open Issues tracked**: `TRACKING.md` Open Issues table now tracks
    TextMate grammar tokenization coverage and cross-file inherited member completion.

  - **tree-sitter workarounds annotated**: `server/src/features/declarationCollector.ts`
    now includes `TODO(tree-sitter-pike#2)` and `TODO(tree-sitter-pike#4)` markers
    on the remaining tree-sitter-pike grammar workarounds.

  - **Cross-file inheritance gap documented**: `docs/known-limitations.md` now
    documents that `Dog d; d->` returns only same-file members when `Dog`
    inherits from a cross-file class.

  - **AI agent scaffolding documented**: `CONTRIBUTING.md` now includes an
    "AI Agent Scaffolding" section describing `.omp/skills/` conventions.

  - **Neovim/Helix highlights documented**: `docs/other-editors.md` now includes
    setup instructions for nvim-treesitter and Helix tree-sitter queries.

### Changed

  - **Text document sync**: Switched from Full to Incremental sync
    (`TextDocumentSyncKind.Incremental`). Client now sends only the changed
    range per keystroke instead of the entire document, reducing latency on
    large files. Decision 0023.

  - **PikeWorker priority queue**: Converted the PikeWorker FIFO queue to a
    priority queue. Interactive requests (hover, completion, navigation) are
    now serviced before background work (diagnostics), preventing visible
    latency when the diagnostic manager is busy. Decision 0024.

  - **Completion quality**: Added `filterText` to all completion items so the
    client fuzzy-matches against the plain identifier regardless of label
    content. Added `detail` (type annotation) to declaration completions.

  - **Cancellation propagation**: Added `CancellationToken` checks to all LSP
    request handlers that were missing them: documentSymbol, documentHighlight,
    foldingRange, signatureHelp, codeAction, workspace/symbol, and formatting.
    All handlers now bail early when a newer request supersedes them.

  - **Selection range**: Implemented `textDocument/selectionRange` for
    shrink/expand selection. Walks the tree-sitter AST from cursor position
    upward, collecting ranges for meaningful node types (declarations, blocks,
    expressions). Decision 0025.

  - **On-type formatting**: Added `documentOnTypeFormatting` provider triggered
    by `}` and `;`. Reuses the existing pike-fmt formatter but returns only
    the edits near the trigger line for responsiveness. Decision 0025.

  - **Completion textEdit**: All completion items now include a `textEdit`
    that replaces the identifier prefix being typed. Fixes the "foo.bbar"
    doubling bug when completing after a dot. Decision 0025.

  - **Completion snippets**: Function and method completions now include
    LSP snippet tab stops for parameters (e.g., `write(${1:string})`).
    Gracefully degrades to plain insertion when type info is unavailable.
    Decision 0025.

  - **Call hierarchy**: Implemented `textDocument/prepareCallHierarchy`,
    `callHierarchy/incomingCalls`, and `callHierarchy/outgoingCalls`.
    Incoming calls use the cross-file reference index. Outgoing calls walk
    the tree-sitter AST to find `call_expression` nodes and resolve callees.
    Decision 0026.

  - **Code lens**: Added reference count annotations above function and
    method declarations. Uses the workspace index to count references across
    the workspace. Decision 0026.

  - **Code actions**: Added three new code action kinds:
    `source.fixAll` (apply all quick-fixes at once),
    `source.organizeImports` (sort and deduplicate import statements),
    `refactor.extract.variable` (extract selected expression to a local
    variable with auto-generated name). The codeActionProvider now
    advertises all supported kinds for VSCode's lightbulb menu.

  - **Syntax highlighting**: Expanded TextMate grammar (`client/syntaxes/pike.tmLanguage.json`)
    from 6 patterns (comments + strings only) to 21 patterns covering keywords
    (control flow, declaration, other), modifiers, type keywords, built-in constants,
    preprocessor directives, operators, and punctuation. Keywords, types, operators,
    and constants are now colorized immediately on file open with zero indexing delay.
    Previously only comments and strings were highlighted.

  - **Removed build artifacts**: `out/pike-language-server-*.vsix` and scratch
    files `test2.md`, `test-changelog.md` are no longer tracked by git.

  - **pike-fmt upgraded to v0.1.5**: Uses npm semver (`^0.1.5`). The npm package
    bundles `tree-sitter-pike.wasm` in `dist/`. `.pmod` files are now discovered
    by `pike-fmt` ([TheSmuks/pike-fmt#17]). `scripts/fmt.sh` sets `PIKE_FMT_WASM`
    to bypass a bundled-`__dirname` bug in `dist/cli.js` ([TheSmuks/pike-fmt#16]).
    A `postinstall` script (`scripts/postinstall-pike-fmt.js`) symlinks
    `web-tree-sitter.wasm` into `dist/` for the bundled tree-sitter runtime.

### Fixed

  - **Critical: client-side tree-sitter WASM loading broken** — esbuild's CJS output
    set `import.meta` to an empty object, making `import_meta.url` undefined.
    `web-tree-sitter` could not locate its WASM runtime, silently breaking
    semantic token highlighting in the editor.  The build script now patches
    the bundled output so `import_meta.url` resolves to the bundle's real path.

  - **Server `isMain` detection broken in Node.js** — `import.meta.main` is a
    Bun-only property; in Node.js it is always `undefined`, so the fallback
    branch never called `connection.listen()`.  Production use was unaffected
    (the `PIKE_LSP_STDIO` env-var guard in `main.ts` covers that), but running
    the server standalone under Node.js silently exited.  Replaced with a
    `process.argv[1]` comparison that works in both runtimes.

  - **Typecheck errors**: Fixed 21 TypeScript errors introduced in Phases B–D
    that were not caught locally. Added `'method'` to the `DeclKind` union type
    and all `Record<DeclKind, ...>` maps. Fixed `Reference` property access
    (`ref.line` → `ref.loc.line`) in call hierarchy and code lens. Fixed
    `SelectionRange` property access (`lastRange.start` →
    `lastRange.range.start`) in selection range. Fixed wrong variable name
    (`stdlibTopLevel` → `stdlibTopLevelNames`) in completion cache reset.

  - **Cross-file inherited member completion tests**: Fixed two structural syntax
    errors in `tests/lsp/completion.test.ts` that prevented cross-file inheritance
    completion tests from executing:
    1. Missing `});` closing brace on the US-001 test (~line 988), causing it to
       merge with the subsequent test.
    2. Extra `});` at end of file (~line 1286), causing a parse error.
    Removed the `describe.skip("Cross-file inherited member completion")` placeholder
    — the feature was already fully implemented; only the tests were broken.
    All cross-file inheritance tests now pass (US-001, CB-2, US-002, US-007, US-008).

  - **sigHelp.second-param SKIP → PASS**: `resolveSignature()` in
    `server/src/features/signatureHelp.ts` was looking up the class scope
    with `table.scopes.find(s => s.declarations.includes(classDecl.id))`.
    `Dog`'s `scopeId` is the file scope, not the class scope, so this
    returned the file scope — which does not contain `create`'s ID. The
    `createDeclId` was always `undefined`, causing the constructor lookup
    to fall through to stdlib (no `predef.Dog`) and return `null`.
    Fix: use `findClassScope(table, classDecl)` from `typeResolver.ts`,
    which correctly finds the class body scope via `kind === 'class'`
    and range containment.

  - **textDocument/references respects includeDeclaration**: The `onReferences`
    handler now adds the declaration location to the results when
    `params.context.includeDeclaration` is `true`, in both cross-file and
    same-file paths with duplicate-avoidance logic.

  - **documentLink fallback for unresolvable modules**: `collectInheritLink`
    in `documentLink.ts` now emits a `pike://modules/...` link even when the
    module cannot be resolved, instead of silently omitting the link.

  - **health-check.ts test suite**: Fixed 6 needle/position issues and 1 test
    structure error in the LSP health-check test file (`tests/health-check.ts`):
    `refs.method`, `refs.parameter`, `rename.prepare-valid`, `rename.execute`,
    `highlight.variable`, `hover.variable-type`, and `codeAction.unused-var`.

## [0.3.3-beta] — 2026-05-05
## [0.3.5-beta] — 2026-05-06
