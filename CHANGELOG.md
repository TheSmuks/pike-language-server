# Changelog

All notable changes to the Pike Language Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

  

## [Unreleased]

### Fixed

  - **sigHelp.second-param SKIP → PASS**: `resolveSignature()` in
    `server/src/features/signatureHelp.ts` was looking up the class scope
    with `table.scopes.find(s => s.declarations.includes(classDecl.id))`.
    `Dog`'s `scopeId` is the file scope, not the class scope, so this
    returned the file scope — which does not contain `create`'s ID. The
    `createDeclId` was always `undefined`, causing the constructor lookup
    to fall through to stdlib (no `predef.Dog`) and return `null`.
    Fix: use `findClassScope(table, classDecl)` from `typeResolver.ts`,
    which correctly finds the class body scope via `kind === 'class'`
    and range containment.

  - **textDocument/references respects includeDeclaration**: The `onReferences`
    handler now adds the declaration location to the results when
    `params.context.includeDeclaration` is `true`, in both cross-file and
    same-file paths with duplicate-avoidance logic.

  - **documentLink fallback for unresolvable modules**: `collectInheritLink`
    in `documentLink.ts` now emits a `pike://modules/...` link even when the
    module cannot be resolved, instead of silently omitting the link.

  - **health-check.ts test suite**: Fixed 6 needle/position issues and 1 test
    structure error in the LSP health-check test file (`tests/health-check.ts`):
    `refs.method`, `refs.parameter`, `rename.prepare-valid`, `rename.execute`,
    `highlight.variable`, `hover.variable-type`, and `codeAction.unused-var`.

## [0.3.5-beta] — 2026-05-06
