## ADDED Requirements

### Requirement: A local Roxen installation is located by explicit precedence

The server SHALL locate a Roxen installation by consulting sources in a fixed
precedence order, taking the first that yields an existing Roxen tree:

1. An explicit configured path.
2. A declaration in the workspace's `pike.json`.
3. An ancestor directory of the workspace root that is itself a Roxen tree.
4. Filesystem discovery of `/usr/local/roxen*`.

Where discovery matches multiple installations, the highest version SHALL win.

#### Scenario: Explicit configuration wins

- **WHEN** a Roxen path is configured explicitly and a different installation
  also exists at `/usr/local/roxen6`
- **THEN** the configured path SHALL be used

#### Scenario: Multiple discovered installations

- **WHEN** no path is configured and both `/usr/local/roxen5` and
  `/usr/local/roxen6` exist
- **THEN** the version 6 installation SHALL be selected

#### Scenario: Configured path does not exist

- **WHEN** a Roxen path is configured but no Roxen tree exists there
- **THEN** the server SHALL fall through to the next source in precedence
  order, and SHALL surface a diagnostic message identifying the bad
  configuration rather than failing silently

#### Scenario: No installation present

- **WHEN** no source yields a Roxen tree
- **THEN** detection SHALL report absence without error, and the server SHALL
  continue to start normally

### Requirement: Detection derives Roxen search paths

A located installation SHALL yield module, include, and program search paths in
the same shape Pike detection already produces, so that module resolution
requires no Roxen-specific resolution concepts.

#### Scenario: Include path resolves Roxen headers

- **WHEN** a Roxen installation is detected and a file contains
  `#include <module.h>`
- **THEN** the include SHALL resolve to `module.h` within that installation's
  include directory, and go-to-definition SHALL open it

#### Scenario: Module path resolves the module prototype

- **WHEN** a Roxen file contains `inherit "module";`
- **THEN** the inherit SHALL resolve to the module prototype within the
  detected installation

### Requirement: The roxen-module scheme resolves

Roxen sources inherit across modules using a `roxen-module://` URI. The
resolver SHALL treat this as a Roxen module reference rather than a filesystem
path.

#### Scenario: Inheriting a named Roxen module

- **WHEN** a file contains `inherit "roxen-module://filesystem"`
- **THEN** the target SHALL resolve to the `filesystem` module within the
  detected installation

#### Scenario: Scheme used without an installation

- **WHEN** a file contains a `roxen-module://` inherit and no Roxen
  installation is detected
- **THEN** the inherit SHALL be left unresolved without being reported as an
  error
