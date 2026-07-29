## ADDED Requirements

### Requirement: A generated Roxen index ships with the server

The server SHALL ship an index generated from Roxen 6.1 source at build time,
so that Roxen files are usable without a local installation. The index SHALL
cover:

- the macros and constants defined by the thirteen Roxen include files,
  including the `TYPE_*`, `VAR_*`, and `MOD_*` families that `module.h` defines
- the `MODULE_*` module-type taxonomy
- the Roxen and RXML API surface needed for hover and completion

Generation SHALL be reproducible from a pinned Roxen revision, and SHALL be
performed by a script alongside the existing stdlib index generator.

#### Scenario: Constant is known without an installation

- **WHEN** no Roxen installation is detected and a Roxen file references
  `TYPE_STRING`
- **THEN** the symbol SHALL resolve from the bundled index, and hover SHALL
  describe it

#### Scenario: Module type is known without an installation

- **WHEN** no Roxen installation is detected and a file declares
  `constant module_type = MODULE_LOCATION;`
- **THEN** `MODULE_LOCATION` SHALL resolve from the bundled index

#### Scenario: Index is regenerated reproducibly

- **WHEN** the generator is run twice against the same pinned Roxen revision
- **THEN** it SHALL produce byte-identical output

### Requirement: A local installation takes precedence over the index

Where both are available, symbols SHALL resolve against the local installation,
so that users see their own Roxen version rather than the bundled one.

#### Scenario: Version skew

- **WHEN** a local Roxen defines a constant with a different value than the
  bundled index records
- **THEN** the local value SHALL be reported

#### Scenario: Definition navigation requires an installation

- **WHEN** go-to-definition is invoked on a Roxen symbol and an installation is
  detected
- **THEN** it SHALL open the real source file

#### Scenario: Navigation degrades without an installation

- **WHEN** go-to-definition is invoked on a Roxen symbol resolved only from the
  bundled index
- **THEN** the server SHALL return no location rather than a fabricated one,
  while hover SHALL still describe the symbol

### Requirement: Roxen includes do not produce errors when unresolvable

A Roxen include that cannot be resolved SHALL NOT be reported as a diagnostic
when the header is covered by the bundled index, since an unresolved include
must not turn a valid file red.

#### Scenario: Roxen header without an installation

- **WHEN** a file contains `#include <module.h>`, no installation is detected,
  and the header is covered by the bundled index
- **THEN** no diagnostic SHALL be reported for that include

#### Scenario: Computed include path

- **WHEN** a file contains an include whose path is computed rather than
  literal, such as `#include <%s>`
- **THEN** the include SHALL be left unresolved silently and SHALL NOT be
  reported as an error

### Requirement: Bundle growth is bounded and measured

The index adds to the shipped bundle and to resident memory, both of which are
tracked for this extension. Its cost SHALL be measured and recorded.

#### Scenario: Memory baseline is checked

- **WHEN** the index is added
- **THEN** peak and settled resident memory SHALL be measured against the
  recorded baselines, and a regression SHALL block the change
