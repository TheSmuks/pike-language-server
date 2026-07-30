## 1. Prerequisite

- [x] 1.1 Confirm `fix-position-drift` has landed; the ISO-8859-1 majority of
      the Roxen corpus is unreadable without its decoder

## 2. Docker lab

- [x] 2.1 Create `tools/roxen-lab/` with a Dockerfile building Pike 8.0 and
      Roxen 6.1 from a pinned `rxnpatch/6.1` revision
- [x] 2.2 Install Roxen into a conventional location matching where detection
      searches
- [ ] 2.3 Verify the Roxen server actually starts in the container
      — BLOCKED: reaches module compilation and fails on a cyclic inherit in
      `Variable.pmod` that Pike's two-pass compiler cannot resolve. Reproduces
      identically on Pike v8.0.1116 and on Roxen's own `rxnpatch/8.0`. Recorded
      as an open defect in `tools/roxen-lab/README.md`.
- [x] 2.4 Expose an oracle entry point: compile a given Pike file with Roxen's
      compiler and report success or the compiler's error
- [x] 2.5 Document how to build and run the lab, including expected build time
- [x] 2.6 Record the pinned Roxen revision and the Pike version used

## 3. Corpus parse baseline

- [x] 3.1 Add a corpus parse runner that decodes each file by detected encoding
      and reports files with ERROR or MISSING nodes
- [x] 3.2 Record the current baseline (expected: 14 of 442 files failing)
- [x] 3.3 Ensure any corpus scanning tooling decodes explicitly — plain `grep`
      silently skips ISO-8859-1 files as binary and will undercount

## 4. Detection

- [x] 4.1 Implement Roxen installation discovery with the precedence order:
      explicit setting, `pike.json`, workspace ancestor, `/usr/local/roxen*`
- [x] 4.2 Select the highest version when discovery matches several
- [x] 4.3 Derive module, include, and program paths in the shape
      `pikeDetection.ts` already produces
- [x] 4.4 Report a misconfigured explicit path rather than failing silently
- [x] 4.5 Test detection against the lab's real installed layout, not a fixture
- [x] 4.6 Test that absence is reported without error and the server starts

## 5. Resolution

- [x] 5.1 Add the `roxen-module://` scheme to `ModuleResolver`
- [x] 5.2 Resolve `#include <module.h>` and the other twelve Roxen headers
      against detected include paths
- [x] 5.3 Resolve `inherit "module"` to the module prototype
- [x] 5.4 Leave computed includes such as `#include <%s>` unresolved silently,
      with no diagnostic
- [x] 5.5 Test each of the above with and without a detected installation

## 6. Activation

- [x] 6.1 Implement file-marker detection for the three measured marker
      families
- [x] 6.2 Implement directory inheritance for marker-less files
- [x] 6.3 Add the `pike.roxen.mode` setting with `auto`, `on`, `off`
- [x] 6.4 Verify against the corpus that activation covers all 170 files in
      `server/modules/`
- [x] 6.5 Test that a plain Pike file in a mixed workspace is offered no Roxen
      symbol

## 7. Generated index

- [x] 7.1 Write `scripts/build-roxen-index.ts` modelled on
      `scripts/build-stdlib-index.ts`, pinned to a Roxen revision
- [x] 7.2 Extract the include files' macros and constants, including the
      `TYPE_*`, `VAR_*`, and `MOD_*` families
- [x] 7.3 Extract the `MODULE_*` taxonomy
- [x] 7.4 Extract the Roxen and RXML API surface for hover and completion
- [x] 7.5 Verify generation is byte-reproducible across two runs
- [x] 7.6 Wire the index into completion and hover, gated on Roxen mode
- [x] 7.7 Make a detected installation take precedence over the index
- [x] 7.8 Return no location, rather than a fabricated one, for
      go-to-definition on an index-only symbol
- [ ] 7.9 Measure bundle size and peak plus settled memory against the recorded
      baselines
      — PARTIAL: bundle measured at +258 KB (3.14 MB to 3.41 MB, +8.4%).
      Extension peak/settled RSS against the recorded baselines not measured.

## 8. Parse failure triage

- [x] 8.1 Compile each of the 14 failing files with the lab oracle and record
      the verdict
- [x] 8.2 Classify each as a grammar gap, a macro-expansion gap, or genuinely
      invalid source
- [ ] 8.3 Fix grammar gaps upstream in the sibling tree-sitter-pike repository
      — NOT STARTED. Triage is complete and classified in
      `tools/roxen-lab/corpus-triage.md`: 5 grammar gaps (3 of them one rule
      — named class expressions), 8 macro-expansion gaps, 1 genuinely invalid
      source file that both Pike and the grammar correctly reject.
- [ ] 8.4 Rebuild the WASM, copy it into `server/`, and regenerate goldens
- [ ] 8.5 Re-run the corpus parse and confirm the failure count has dropped
- [x] 8.6 Record any remaining failures as open defects with their oracle
      verdict, not as documented limitations

## 9. Verification

- [x] 9.1 Open a real Roxen module with a detected installation: includes
      resolve, symbols hover, go-to-definition opens real sources
- [x] 9.2 Repeat with detection disabled: no errors, hover and completion still
      work from the index, go-to-definition returns nothing
- [x] 9.3 Confirm a plain Pike project is unchanged in both configurations
- [x] 9.4 Run the full test suite serially against the pre-existing baseline
- [x] 9.5 Run quality gates (file ≤500 lines, function ≤50 lines)
