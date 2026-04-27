# 0010: Cross-File Resolution

**Status**: Proposed (Phase 4 entry)
**Date**: 2026-04-27
**Supersedes**: 0009 (extends same-file symbol table to cross-file)

## Context

Phase 3 built per-file symbol tables with same-file definition and references. Phase 4 extends to cross-file: inherit chains, import resolution, module path lookup, and workspace-wide find-references.

## Workspace Model

### Definition

A **workspace** is a single root directory, communicated via `initialize(params.rootUri)`. All files under the workspace root are potentially indexable.

### Path configuration

The resolver needs three categories of paths:

| Category | Source | Example |
|----------|--------|---------|
| System module path | Pike installation (`/usr/local/pike/8.0.1116/lib/modules`) | `Stdio`, `Array`, etc. |
| Workspace module paths | Workspace subdirectories containing `.pmod`/`.pike` files | `lib/`, `src/` |
| Workspace program paths | Directories where `inherit "path.pike"` resolves relative to | Same as module paths initially |

System paths come from the Pike installation. Workspace paths are configured via `initializationOptions` in the LSP initialize request, with sensible defaults:

- If `lib/` exists under workspace root → add to module path
- If `src/` exists → add to program path
- Always add workspace root itself

### Multiple roots

VSCode supports multi-root workspaces. Phase 4 handles a single root. Multi-root is Phase 6+; the workspace model's data structures support it, but the server only processes the first root.

## Index Data Structure

### WorkspaceIndex

```typescript
interface WorkspaceIndex {
  /** Per-file symbol tables. Keyed by URI. */
  files: Map<string, FileEntry>;

  /** Reverse dependency graph: file URI → Set of URIs that depend on it. */
  dependents: Map<string, Set<string>>;

  /** Module path → URI mapping. For resolving module references. */
  moduleMap: Map<string, string>; // "Stdio" → "file:///usr/local/pike/.../Stdio.pmod"

  /** Pike installation paths. */
  pikePaths: PikePaths;
}

interface FileEntry {
  uri: string;
  symbolTable: SymbolTable;
  /** #pike version directive, if present. */
  pikeVersion: { major: number; minor: number } | null;
  /** Files this file imports/inherits (forward dependencies). */
  dependencies: Set<string>;
  /** Modification source of last change. */
  lastModSource: ModificationSource;
  /** Content hash for cache validity. */
  contentHash: string;
}

interface PikePaths {
  pikeHome: string;       // "/usr/local/pike/8.0.1116"
  modulePaths: string[];  // [pikeHome + "/lib/modules", ...workspace paths]
  includePaths: string[];
  programPaths: string[];
}
```

### Granularity: per-file

The index is per-file, not per-module. Rationale:

1. Files are the unit of change (didChange operates on files).
2. A `.pmod` directory contains multiple files that change independently.
3. Invalidation is simpler: file changes → invalidate that file's entry + dependents.

However, for **module resolution**, the index needs to understand that `Foo.pmod/` is a module containing files. The moduleMap bridges this: it maps module names to directory URIs, and the resolver walks the directory structure.

## Module Resolution Algorithm

The LSP implements a simplified version of Pike's `master.pike` resolution. The full algorithm (5700 lines of Pike) handles edge cases the LSP doesn't need (precompiled modules, `.so` loading, relocation, etc.).

### Resolution steps

Given a reference to `Foo.Bar.Baz` in file `currentFile`:

1. **Split on dots**: `["Foo", "Bar", "Baz"]`
2. **Resolve the first segment** (`Foo`):
   a. Check if `Foo` is a `string_literal` inherit path → resolve as file path
   b. Check workspace files for `Foo.pike` or `Foo.pmod` relative to `currentFile`
   c. Check workspace module paths
   d. Check system module paths
   e. Check `#pike` version-specific paths
3. **Resolve subsequent segments** by indexing into the found module:
   - If module is a `.pmod` directory, look for `Bar.pike`, `Bar.pmod`, or `Bar.pmod/module.pmod`
   - If module is a `.pike` file, look for class `Bar` in its symbol table
4. **Priority order**: `.pmod` > `.pike` (same as Pike's `prio_from_filename`, minus `.so`)

### Inherit resolution

`inherit "path.pike"` → `cast_to_program` path:
- If path starts with `/` → absolute path
- If path starts with `./` or `../` → relative to `dirname(currentFile)`
- Otherwise → search `pike_program_path` (which includes workspace root)

`inherit Foo` → identifier resolution:
- Same as `inherit "Foo"` but searches module paths instead of program paths
- `Foo.Bar` → resolve module `Foo`, find class `Bar`

`inherit .Foo` → relative resolution:
- The `.` prefix means "in the same directory as currentFile"

### Import resolution

`import Stdio` → brings all of Stdio's exported symbols into scope:
1. Resolve `Stdio` as a module (using `resolv`)
2. All public symbols from the module become available in the importing file
3. Name collisions: later imports shadow earlier; local declarations shadow imports

`import Stdio.File` → brings just `File` into scope (not all of Stdio)

### `#pike` version directive

When a file contains `#pike 7.8`:
1. Parse the version from the `preprocessor_directive` node's text (no children).
2. Add `pikeHome/lib/7.8/modules/` to the module search path for that file.
3. The compat resolver falls back to the default module path for symbols not found in the versioned path.

This matches Pike's `CompatResolver` behavior: version-specific paths are checked first, then the default path.

### What we do NOT implement

| Pike feature | Reason | Mitigation |
|-------------|--------|-----------|
| `.so` binary modules | LSP can't parse C; no tree-sitter for .so | System modules resolved via pike-ai-kb or file-based heuristics |
| `joinnode` (multi-path merge) | Only relevant when same module exists in multiple paths; rare in practice | First-match wins (same as Pike's `findprog` fallback) |
| `module_checker` lazy loading | LSP eagerly indexes all workspace files | Accept. Workspace is bounded. |
| `PIKE_MODULE_RELOC` | Build-system feature, not relevant for LSP | Ignore |
| Precompiled `.o` files | Not parseable by tree-sitter | Skip |
| `_static_modules` | C-level modules | Resolved via pike-ai-kb |
| `handle_import` (full implementation) | Pike's implementation is commented out (`#if 0`) | Implement our own based on `resolv` |

## File Watching

### Which files are watched

| Pattern | Watched? | Reason |
|---------|----------|--------|
| `**/*.pike` | Yes | Primary source files |
| `**/*.pmod` | Yes | Module files (both file and directory) |
| `**/*.mmod` | Yes | Pike module variant |
| System Pike files | No | Change only with Pike updates; not a normal workflow |

File watching uses `workspace/didChangeWatchedFiles`. The client registers watchers via `client/registerCapability`.

### What triggers re-indexing

| Event | Action |
|-------|--------|
| `didChange` (open file) | Re-parse + rebuild symbol table for that file |
| `didChangeWatchedFiles` (external change) | Re-read file + re-parse + rebuild |
| `didOpen` (new file) | Parse + index |
| `didClose` | Remove from index if not on disk |
| File created (watcher) | Parse + index + update module map |
| File deleted (watcher) | Remove from index + invalidate dependents |

## ModificationSource Tracking

Following gopls's pattern, every file change is tagged with its source:

```typescript
enum ModificationSource {
  FromDidOpen = 'didOpen',
  FromDidChange = 'didChange',
  FromDidChangeWatchedFiles = 'didChangeWatchedFiles',
  FromDidSave = 'didSave',
  FromDidClose = 'didClose',
  FromDidChangeConfiguration = 'didChangeConfiguration',
}
```

### Invalidation aggressiveness by source

| Source | Symbol table | Dependencies | Module map |
|--------|-------------|-------------|-----------|
| `didOpen` | Rebuild | Validate (may be stale) | Validate |
| `didChange` | Rebuild | Keep (same file) | Keep |
| `didChangeWatchedFiles` | Rebuild | Rebuild if import/inherit changed | Rebuild if new/deleted file |
| `didSave` | Rebuild | Rebuild (external edits possible) | Rebuild |
| `didClose` | Remove from index | Remove from dependents | Remove if not on disk |
| `didChangeConfiguration` | Rebuild all | Rebuild all | Rebuild all |

The key insight: `didChange` is incremental (within the same file). `didChangeWatchedFiles` and `didSave` may change the cross-file dependency graph.

## Cross-File Invalidation Strategy

When file A changes:

1. **Invalidate A's symbol table** — always.
2. **Invalidate A's dependents** — files that `inherit` or `import` from A.
3. **Do NOT invalidate files A depends on** — A's changes don't affect its dependencies.
4. **Module map update** — only if A was created/deleted/renamed.

### Transitive invalidation

NOT implemented in Phase 4. If B inherits A and C inherits B, changing A invalidates B but not C. This is conservative: C may see stale B state until B is re-indexed and C re-resolves.

Rationale: transitive invalidation requires the full dependency graph at the module level, which is expensive to maintain. Correctness is preserved because:
- B is re-indexed, so B's inherit from A is correct.
- C's reference to B's member resolves through B's symbol table, which is now correct.
- C itself doesn't need to change — it references B's members, not A's directly.

Edge case: if C references `A::something` directly (without going through B), this is a direct dependency from C to A, which IS tracked.

### Performance target

| Operation | Target | Measurement |
|-----------|--------|-------------|
| Cross-file go-to-definition | < 10ms | Single symbol table lookup + module resolution |
| Single file edit propagation | < 50ms | Rebuild one file's symbol table + invalidate dependents |
| Full workspace index (cold start) | < 5s for 1000 files | Parallel parse + sequential resolution |
| Module resolution per reference | < 1ms | Cached module map lookup |

Phase 4 does not need to be fast. It needs to be correct. Performance is measured and recorded; optimization is Phase 6+.

## Tree-sitter Integration

### inherit_decl parsing

tree-sitter-pike provides two forms:

**String literal inherit**: `inherit "/path/to/file.pike";`
```
inherit_decl
  inherit "inherit"
  path: string_literal ""/path/to/file.pike""
  ; ";"
```

**Identifier/dot-path inherit**: `inherit Foo.Bar : alias;`
```
inherit_decl
  inherit "inherit"
  path: comma_expr "Foo.Bar"  (has `path` field name!)
  : ":"
  alias: identifier "alias"
  ; ";"
```

Both forms expose the `path` field via `childForFieldName('path')`. The path text is:
- String literal: extract the string content (strip quotes)
- Identifier: the raw text of the comma_expr (e.g., `"Foo.Bar"`, `".Foo"`, `"Foo.Bar.Baz"`)

### import_decl parsing

Same structure: `import Stdio.File;`
```
import_decl
  import "import"
  path: comma_expr "Stdio.File"
  ; ";"
```

The path text is the module path to resolve.

### #pike directive

`preprocessor_directive` node with text `#pike 7.8`. No children. Parse version from text: `#pike\s+(\d+)(?:\.(\d+))?`.

## Deviations from Pike's Actual Algorithm

| Deviation | Impact | Mitigation |
|-----------|--------|-----------|
| No `.so` binary module resolution | Stdlib symbols that are C modules won't resolve by path | pike-ai-kb can provide fallback; system module map can be pre-built |
| No `joinnode` multi-path merge | If same-named module exists in workspace and system paths, workspace wins | Accept. Matches user expectation (workspace overrides system). |
| No precompiled `.o` loading | Not applicable in LSP context | N/A |
| First-match-wins for module paths | Pike iterates all paths and merges | Accept for Phase 4. Edge case for large workspaces. |
| No `module_checker` lazy loading | LSP eagerly indexes | Accept. Workspace is bounded. |

## Harness Extension

### Cross-file resolution introspection

The harness will extend `introspect.pike` to report:

1. **For each `inherit` declaration**: What file/program does Pike resolve it to? (via `handle_inherit` or `cast_to_program`)
2. **For each `import` declaration**: What module does Pike resolve it to? (via `resolv`)
3. **For each external reference**: What file does Pike resolve it to? (via `Program.defined` on the resolved value)

This provides ground truth for cross-file resolution tests.

### Implementation approach

Add a second Pike script `harness/resolve.pike` that:
1. Takes a file path and module path configuration.
2. Compiles the file with a custom `CompilationHandler` that intercepts `handle_inherit` and `resolv` calls.
3. For each cross-file reference found, reports the resolved target file path.

This is separate from `introspect.pike` because the cross-file introspection requires a different compilation strategy (the handler needs to intercept the resolution process, not just the diagnostics).

## Consequences

- The workspace index is in-memory only. No on-disk persistence in Phase 4.
- The index is rebuilt from scratch on server restart. Acceptable for Phase 4.
- Module resolution is file-system-based. The LSP reads directories and files to discover modules, matching Pike's `dirnode` behavior.
- System stdlib modules are resolved by path lookup in Pike's installation directory, not by querying Pike at runtime. This is faster but may miss dynamic module behavior.
- Cross-file resolution is scoped to workspace files + Pike system modules. External dependencies not in the workspace are not resolved.
- The ModificationSource enum drives invalidation decisions, preventing both over-invalidation (wasting CPU) and under-invalidation (serving stale results).
