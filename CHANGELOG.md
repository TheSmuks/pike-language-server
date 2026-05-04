## [Unreleased]

### Added

**Formatting layer architecture**: Added three-component formatting system:
`client/language-configuration.json` (client-side indentation rules),
`server/src/features/formattingHandler.ts` (LSP thin wrapper to pike-fmt),
`server.ts` (registered `documentFormattingProvider`). Phase 1 scope:
indentation normalization only. pike-fmt is a separate repository (WIP).

**Corpus expansion: 5 new P1 corpus files** covering constant declarations,
`.pmod` directory module imports, typed function parameters, `#define`/`#ifdef`
preprocessor directives, and `#include` directive resolution.

**Rename through function return types**: Renaming a class now also updates
function return type annotations. Renaming `Dog` → `Cat` also renames `Dog f()`
→ `Cat f()`. Added `collectFunctionReturnTypeRefs()` to collect return type
references, with location deduplication in `getReferencesTo()`.

### Changed

**CI**: Upgraded `actions/cache` from v4 to v5.

## [0.2.0-beta] - 2026-05-04

### Fixed

**Dead formatter.ts removed**: Orphaned 244-line `server/src/features/formatter.ts`
was removed. The file was marked as removed in Phase 18 but persisted on disk.
All formatting functionality is deferred per Decision 0020.