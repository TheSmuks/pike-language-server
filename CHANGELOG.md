# Changelog

All notable changes to the Pike Language Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha] - 2026-04-26

### Added

- Project initialized from ai-project-template.

## [Unreleased]

### Added

- Test harness: Pike introspection script (CompilationHandler + AutoDoc + JSON)
- Test harness: TypeScript runner with --snapshot and --verify modes
- Test harness: Generic snapshot manager with recursive canonical key ordering
- Ground-truth snapshots for all 37 corpus files
- 70 tests: 41 harness + 11 canary + 16 canonicalizer
- Decision 0005: Harness architecture with strict/non-strict handling
- Project setup: package.json, tsconfig.json, bun + TypeScript 5.x
- Corpus: autodoc-documented.pike (AutoDoc XML extraction test)
- Corpus: basic-nonstrict.pike (non-strict compilation test)

### Fixed

- AutoDoc extraction failed with absolute paths (extract_autodoc prepends ./)
- Canonicalizer was field-specific; now handles arbitrary JSON shapes generically
- Runner defaulted to strict:true for all files; now respects per-file pragma

## [0.1.0-alpha] - 2026-04-26