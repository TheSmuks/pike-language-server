## Context

Roxen source is ordinary Pike compiled in a non-ordinary environment: the Roxen
module loader supplies include paths, a module prototype to inherit, and a large
constant vocabulary. Without those, the server reports errors on correct code.

The numbers below are measured against a shallow clone of `rxnpatch/6.1`, not
estimated:

| Fact | Value |
|---|---|
| Pike files under `server/` | 442 |
| Files that are ISO-8859-1, not UTF-8 | 241 |
| `#include <module.h>` occurrences | 160 |
| `#include <roxen.h>` occurrences | 114 |
| Roxen include files | 13 |
| Macros defined by `module.h` | 49 |
| `MODULE_*` taxonomy values | ~20 |
| Files in `server/modules/` carrying an activation marker | 143 of 170 |
| Files with genuine tree-sitter parse errors | 14 |

Two of these reshaped the design. First, the 14-file parse failure count means
"Roxen code shows syntax errors" is overwhelmingly *not* a grammar problem —
it is unresolved includes plus position drift. Second, the ISO-8859-1 majority
makes `fix-position-drift` a hard prerequisite: without correct decoding, any
measurement taken against this corpus is distorted.

A methodological note worth carrying forward: `grep` silently skips ISO-8859-1
files as binary, reporting no matches rather than an error. An early pass
undercounted `#include <module.h>` as 21 files instead of 126 for exactly this
reason. Any tooling that scans this corpus must decode explicitly.

## Goals / Non-Goals

**Goals:**

- Roxen files parse cleanly and resolve their includes, with or without a local
  installation.
- Roxen symbols are available for hover and completion in Roxen files only.
- A reproducible Roxen 6 environment exists, usable as an oracle.

**Non-Goals:**

- RXML-in-markup support. RXML tags authored inside `.rxml` or HTML templates
  are a separate language surface; this change covers Pike source that
  *defines* tags, not documents that *use* them.
- Roxen 5 or earlier. Version 6 is the stated target; nothing here forbids
  older versions, but nothing verifies them either.
- Running Roxen as part of CI. The lab is a development and triage tool; making
  it a CI dependency would trade a large build cost for little signal.
- Macro expansion as a general facility. Where Roxen macros must be understood,
  they come from the index as known symbols.

## Decisions

**Detect, but never depend on detection.**

The bundled index is the floor and the local installation is the ceiling. This
inverts the obvious design, where detection is the feature and absence is a
degraded state. The reason is that the failure being fixed — a red file — must
be fixed for everyone, including a developer reading Roxen code on a machine
that has never run Roxen. Detection then adds what only real sources can give:
go-to-definition, and the user's actual version rather than the pinned one.

*Alternative considered:* detection only, suppressing Roxen diagnostics when
absent. Rejected — it silences the symptom while leaving hover and completion
empty, which is the majority experience for anyone reading rather than running
Roxen.

**Derive activation markers from the corpus, then handle the residue
structurally.**

The three marker families cover 143 of 170 module files. The remaining 27 are
not a marker gap to be closed by adding a fourth marker — they are
`graphics/rimage/plugins/*.pike`, helper files that are Roxen files by virtue of
where they sit, not what they contain. Adding markers to catch them would mean
matching on something incidental and would misfire on plain Pike. Directory
inheritance addresses them for the right reason.

*Alternative considered:* workspace-level activation. Rejected — it makes mixed
repositories choose between a red Roxen module and a polluted Pike namespace.

**Reuse the Pike path shape rather than introducing Roxen path concepts.**

Detection emits module, include, and program paths exactly as `pikeDetection.ts`
does. `ModuleResolver` then needs one genuine addition — the `roxen-module://`
scheme — instead of a parallel Roxen resolution path. This keeps the resolver
single-purpose and means Roxen benefits from resolver fixes automatically.

**Build the lab from source rather than packaging a binary.**

A pinned source build is reproducible, inspectable, and gives the oracle. It is
slow, which is precisely why it is a development tool and not a CI job.

**Pin the index generator to a revision, not a branch.**

`rxnpatch/6.1` moves. An index that changes when an unrelated upstream commit
lands would make bundle diffs unreviewable and reproducibility claims false.

## Risks / Trade-offs

**The bundled index encodes one Roxen version; users run others** → A detected
local installation always wins, so skew affects only the no-installation case.
There, a slightly wrong constant is still better than an unknown symbol.

**Index inflates bundle size and resident memory** → Both are tracked baselines
for this extension. The index must be measured against them, and the spec makes
a regression blocking. The stdlib index is the precedent for what an acceptable
cost looks like.

**Directory-inherited activation over-reaches in a mixed repository** → A plain
Pike utility sitting inside a Roxen module tree would gain Roxen symbols in
completion. This is the deliberate trade for covering the 27 plugin files; the
`off` setting is the escape hatch, and the symptom is extra completions rather
than errors.

**Grammar fixes require an upstream round trip** → The 14 failures are fixed in
the sibling tree-sitter-pike repository and return as a rebuilt WASM with
regenerated goldens. This is slower than patching locally but is the only route
that does not fork the grammar.

**Roxen 6.1 may not build cleanly against Pike 8.0.1116** → The host already
runs that Pike version, so this reproduces a known-working combination rather
than a speculative one. If the build fails, the lab pins a Pike revision too.

## Migration Plan

Additive throughout. No existing behavior changes for non-Roxen workspaces,
since activation requires a marker that plain Pike does not carry.

Sequencing is constrained: `fix-position-drift` must land first. Its encoding
fix is what makes the ISO-8859-1 majority of this corpus readable, and its
position fix is what makes any manual verification against Roxen trustworthy.

Within this change, the lab comes before the triage that depends on its oracle,
and detection comes before the index that defers to it.

## Open Questions

- Whether the Roxen and RXML API surface is best extracted from the source tree
  by the generator or from a running Roxen by introspection. The source route is
  assumed because it needs no running server; the lab makes the introspection
  route available for comparison if the extracted surface proves thin.
- Whether any of the 14 parse failures turn out to be genuine invalid Pike that
  Roxen's own compiler also rejects. The oracle will say; the triage task is
  written to accept either verdict.
