## ADDED Requirements

### Requirement: Roxen mode activates on measured file markers

A file SHALL be treated as a Roxen file when it contains any marker below.
These markers were measured against the Roxen 6.1 corpus and together cover 143
of the 170 Pike files in `server/modules/`:

- an `#include` of a Roxen header: `module.h`, `roxen.h`, `config.h`,
  `module_constants.h`, `request_trace.h`, `config_interface.h`
- `inherit "module"`
- `constant module_type = MODULE_*`

#### Scenario: Module header include

- **WHEN** a file contains `#include <module.h>`
- **THEN** Roxen mode SHALL be active for that file

#### Scenario: Module type declaration

- **WHEN** a file declares `constant module_type = MODULE_LOCATION;`
- **THEN** Roxen mode SHALL be active for that file

#### Scenario: Plain Pike file

- **WHEN** a file contains none of the markers and is not under a Roxen tree or
  a directory containing Roxen files
- **THEN** Roxen mode SHALL NOT be active, and no Roxen symbol SHALL appear in
  its completion results

### Requirement: Marker-less files inherit Roxen mode from their directory

The 27 corpus files carrying no marker are helper and plugin files sitting
beside modules that do carry them. Such a file SHALL be treated as a Roxen file
when a sibling or ancestor directory within the project contains a marked file,
or when it lives under a detected Roxen installation.

#### Scenario: Plugin beside marked modules

- **WHEN** a file has no markers but a sibling file in the same directory tree
  carries one
- **THEN** Roxen mode SHALL be active for it

#### Scenario: File inside a Roxen installation

- **WHEN** a file with no markers is opened from inside a detected Roxen
  installation
- **THEN** Roxen mode SHALL be active for it

### Requirement: Activation is overridable

A setting `pike.roxen.mode` accepting `auto`, `on`, and `off` SHALL override
detection. The default SHALL be `auto`.

#### Scenario: Forced on

- **WHEN** `pike.roxen.mode` is `on`
- **THEN** every Pike file in the workspace SHALL be treated as a Roxen file
  regardless of markers

#### Scenario: Forced off

- **WHEN** `pike.roxen.mode` is `off`
- **THEN** no file SHALL be treated as a Roxen file, even inside a detected
  Roxen installation

### Requirement: Activation does not leak between files

Roxen mode is a per-file property. Activating it for one file SHALL NOT alter
results for a non-Roxen file in the same workspace.

#### Scenario: Mixed workspace

- **WHEN** a workspace contains both a Roxen module and a plain Pike program,
  and completion is requested in the plain Pike program
- **THEN** no Roxen symbol SHALL be offered
