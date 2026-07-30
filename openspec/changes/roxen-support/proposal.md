## Why

Roxen WebServer source is Pike, but the server treats it as if it were plain
Pike and gets it wrong in two visible ways: `#include <module.h>` and the other
twelve Roxen include files never resolve, and the symbols those includes define
— the `TYPE_*`, `VAR_*`, `MOD_*` and `MODULE_*` families, the `RXML` and Roxen
APIs — are unknown. Roxen files are consequently red on arrival.

Roxen is not an exotic target for a Pike language server; it is the largest
body of Pike code most Pike developers work in.

## What Changes

- Detect a local Roxen installation and derive its module, include, and program
  search paths, in the same shape `pikeDetection.ts` already produces for Pike.
- Resolve the `roxen-module://` inherit scheme, which appears in the corpus and
  no resolver handles today.
- Ship a generated Roxen index so that a workspace **without** a local Roxen
  install still parses cleanly and still gets hover and completion for Roxen
  symbols. A local install, when present, takes precedence and additionally
  provides go-to-definition into real sources.
- Activate Roxen mode per file, using markers measured against the Roxen 6.1
  corpus rather than assumed, with a `pike.roxen.mode` override. Plain Pike
  projects match no marker and are unaffected.
- Add a Docker lab that builds Pike 8.0 and Roxen 6.1 from `rxnpatch/6.1`,
  producing both a realistic install layout to test detection against and a
  compiler to use as an oracle.
- Triage and fix the 14 files in the 442-file corpus that genuinely fail to
  parse, classifying each as a grammar gap or a macro-expansion gap.

## Capabilities

### New Capabilities

- `roxen-detection`: locating a Roxen installation and deriving its search
  paths, including precedence and the absent-install case.
- `roxen-activation`: deciding which files are Roxen files and therefore see
  Roxen symbols.
- `roxen-index`: the generated fallback index — what it contains, how it is
  built, and how it defers to a local install.
- `roxen-lab`: the reproducible Roxen 6.1 environment and its role as a
  parse oracle.

### Modified Capabilities

None yet. `roxen-detection` may need to modify a future module-resolution spec,
but no spec currently covers resolution.

## Impact

- New: Roxen detection, activation, and index modules under
  `server/src/features/`; `scripts/build-roxen-index.ts` modelled on the
  existing `scripts/build-stdlib-index.ts`; a generated index under
  `server/src/data/`; `tools/roxen-lab/`.
- Modified: `ModuleResolver` gains the `roxen-module://` scheme; include
  resolution consults Roxen include paths when Roxen mode is active;
  completion and hover consult the Roxen index.
- Possibly upstream: grammar fixes land in the sibling `tree-sitter-pike`
  repository and arrive here as a rebuilt `server/tree-sitter-pike.wasm`.
- Bundle size grows by the generated index; it must be measured against the
  extension's memory baselines.
- Depends on `fix-position-drift` for correct decoding of the ISO-8859-1
  sources that make up over half the corpus.
