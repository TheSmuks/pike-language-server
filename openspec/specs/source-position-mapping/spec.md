# source-position-mapping Specification

## Purpose
TBD - created by archiving change fix-position-drift. Update Purpose after archive.
## Requirements
### Requirement: Tree-sitter positions map to LSP positions without unit conversion

The parser binding reports node offsets and `Point.column` values in UTF-16
code units, which is the unit the LSP protocol requires. The server SHALL
therefore pass tree-sitter positions through to LSP unchanged, and SHALL NOT
apply any UTF-8 byte ↔ UTF-16 code unit conversion in either direction.

#### Scenario: Range on a line containing non-ASCII characters

- **WHEN** a document contains the line `int x; // © © marker` and a feature
  emits a range covering the trailing comment
- **THEN** the emitted range SHALL be `character` 7 through 20, matching the
  UTF-16 code unit indices of that comment within the line

#### Scenario: Position lookup on a line containing non-ASCII characters

- **WHEN** the client sends a position whose `character` falls on a token
  preceded on the same line by one or more non-ASCII characters
- **THEN** the node resolved for that position SHALL be the token actually
  under that position, not a token offset by the count of preceding non-ASCII
  characters

#### Scenario: Astral-plane characters

- **WHEN** a line contains a character outside the Basic Multilingual Plane,
  which occupies two UTF-16 code units
- **THEN** ranges after it on that line SHALL account for both code units

#### Scenario: Pure ASCII lines are unaffected

- **WHEN** a line contains only ASCII characters
- **THEN** emitted ranges SHALL be identical to those produced before this
  change, so no existing ASCII-only behavior regresses

### Requirement: Parser binding unit semantics are asserted

The correctness of position mapping depends on an external library's indexing
units, which changed silently in a past upgrade. The server's test suite SHALL
assert the binding's unit semantics directly, so an upgrade that changes them
fails the build rather than silently corrupting positions.

#### Scenario: Binding reports UTF-16 units

- **WHEN** the test suite parses a source string containing a non-ASCII
  character and inspects a node's `endPosition.column`
- **THEN** the assertion SHALL require that value to equal the UTF-16 code unit
  length of the preceding text, and SHALL fail if it equals the UTF-8 byte
  length instead

### Requirement: Feature ranges are verified end to end

Position drift was invisible because no test exercised a real feature response
against non-ASCII source. Range-producing and position-consuming features SHALL
be covered by tests using non-ASCII fixtures.

#### Scenario: Navigation and hover on non-ASCII source

- **WHEN** hover, go-to-definition, and document link are requested against a
  fixture whose header contains non-ASCII characters
- **THEN** each response SHALL reference the symbol actually at the requested
  position, and each returned range SHALL exactly cover the intended token

