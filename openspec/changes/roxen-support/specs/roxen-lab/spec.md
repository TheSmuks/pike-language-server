## ADDED Requirements

### Requirement: A Docker lab builds and runs Roxen 6

The repository SHALL provide a Docker-based lab that builds Pike 8.0 and Roxen
6.1 from the pinned `rxnpatch/6.1` revision and installs Roxen into a
conventional location. The lab SHALL be able to start the Roxen server.

#### Scenario: Lab builds from a pinned revision

- **WHEN** the lab image is built
- **THEN** it SHALL check out the pinned Roxen revision, not a moving branch
  tip, so builds are reproducible

#### Scenario: Installed layout matches expectations

- **WHEN** the lab image is built
- **THEN** the installed tree SHALL be located where detection searches, so
  that detection can be exercised against a real layout rather than a fixture

#### Scenario: Server starts

- **WHEN** the lab container is run
- **THEN** the Roxen server SHALL start, confirming the build is functional
  rather than merely compiled

### Requirement: The lab serves as a parse oracle

Disputes about whether a construct is valid Pike SHALL be settled by compiling
it with Roxen's own compiler in the lab, extending the project's existing rule
that the real implementation, not the test, decides correctness.

#### Scenario: Suspected grammar gap

- **WHEN** the tree-sitter grammar reports an error on a corpus file
- **THEN** that file SHALL be compiled in the lab, and the outcome SHALL
  determine whether the defect is in the grammar or in the source

#### Scenario: Oracle disagreement is recorded

- **WHEN** the oracle accepts a construct the grammar rejects
- **THEN** the construct SHALL be recorded as a grammar defect to fix, not as a
  documented limitation

### Requirement: The lab carries the corpus for parse regression

The lab SHALL make the Roxen source tree available as a parse corpus, and the
project SHALL be able to run the grammar across it and report failures.

#### Scenario: Corpus parse run

- **WHEN** the corpus parse is run against the current grammar
- **THEN** it SHALL report the count and identity of files producing parse
  errors, so the count can be tracked as it is driven down

#### Scenario: Corpus files decode correctly

- **WHEN** the corpus parse reads a source file encoded in ISO-8859-1
- **THEN** it SHALL decode it correctly, since over half the corpus is so
  encoded and mis-decoding would distort the failure count

### Requirement: Corpus parse failures are fixed, not documented

The fourteen corpus files that currently fail to parse SHALL each be triaged as
a grammar gap or a macro-expansion gap and fixed. Grammar fixes belong upstream
in the tree-sitter-pike grammar and arrive here as a rebuilt WASM.

#### Scenario: Triage is complete

- **WHEN** triage finishes
- **THEN** every currently failing file SHALL be classified, with the oracle's
  verdict recorded for each

#### Scenario: Grammar fix propagation

- **WHEN** a grammar gap is fixed upstream
- **THEN** the rebuilt WASM SHALL be brought into this repository and the
  goldens regenerated
