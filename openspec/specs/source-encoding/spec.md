# source-encoding Specification

## Purpose
TBD - created by archiving change fix-position-drift. Update Purpose after archive.
## Requirements
### Requirement: Pike source is decoded by detected encoding, not assumed UTF-8

Pike source predating universal UTF-8 adoption is commonly encoded in
ISO-8859-1; over half of the Roxen 6.1 corpus is. Reading such a file as UTF-8
substitutes U+FFFD for each non-ASCII byte, corrupting both the text and every
offset derived from it. The server SHALL determine a file's encoding before
decoding it.

Detection order:

1. An explicit `#charset` directive in the file.
2. UTF-8, when the bytes are valid UTF-8.
3. ISO-8859-1 as the fallback, which cannot fail because every byte sequence is
   valid in it.

#### Scenario: File declares an explicit charset

- **WHEN** a source file begins with `#charset iso-8859-2`
- **THEN** the file SHALL be decoded as ISO-8859-2, even if its bytes would
  also be valid UTF-8

#### Scenario: Valid UTF-8 without a directive

- **WHEN** a source file has no `#charset` directive and its bytes are valid
  UTF-8
- **THEN** the file SHALL be decoded as UTF-8

#### Scenario: ISO-8859-1 source without a directive

- **WHEN** a source file has no `#charset` directive and contains the byte
  `0xA9` in a context where it is not valid UTF-8
- **THEN** the file SHALL be decoded as ISO-8859-1, yielding `©`, and SHALL NOT
  contain any U+FFFD replacement character

#### Scenario: Decoded text drives positions

- **WHEN** a symbol is defined after a non-ASCII character in an ISO-8859-1
  file that is not open in the editor
- **THEN** a go-to-definition targeting that symbol SHALL return a range
  covering the symbol itself

### Requirement: Encoding detection applies to every source read

Partial adoption would leave inconsistent text between subsystems, so all disk
reads of Pike source SHALL use the detecting decoder. This covers at minimum
workspace indexing, document loading for unopened files, file-watch reloads,
and hover content extraction.

#### Scenario: Indexed and opened text agree

- **WHEN** an ISO-8859-1 file is first read by the workspace indexer and later
  opened by the client
- **THEN** the text used by both paths SHALL be identical, so cached symbol
  positions remain valid after opening

#### Scenario: Non-source files are unaffected

- **WHEN** the server reads a JSON cache, manifest, or other server-owned data
  file
- **THEN** it SHALL continue to read that file as UTF-8, since encoding
  detection applies only to Pike source

