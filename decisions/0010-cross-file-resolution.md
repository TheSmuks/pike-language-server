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

1. **Invalidate A's symbol table** — always. Clear the table immediately.
2. **Transitively invalidate all dependents** — BFS walk of the reverse-dependency graph.
3. **Stale-marking for dependents** — dependents are marked `stale` but keep their symbol tables. `getSymbolTable()` returns null for stale entries. Rebuild happens lazily on next access.
4. **Do NOT invalidate files A depends on** — A's changes don't affect its dependencies.
5. **Module map update** — only if A was created/deleted/renamed.

### Transitive invalidation (BFS)

The invalidation walks the full transitive closure of the reverse-dependency graph. If B inherits A and C inherits B, changing A invalidates both B and C.

**Strategy: stale-marking with lazy rebuild.**

Why not eager rebuild:
- Rebuilding entire subtrees on every keystroke is wasteful when most dependents won't be queried.
- Lazy rebuild on next `getSymbolTable()` call avoids rebuilding files the user isn't looking at.
- The stale flag is cleared when `upsertFile()` is called (either by lazy rebuild or by the user editing the file).

Why not transitive closure caching:
- The reverse-dependency graph is updated on every `upsertFile()` and `removeFile()`. Caching the transitive closure would need invalidation logic that's equally complex.
- BFS over the reverse-dependency graph is O(V+E) which is fast for typical workspaces (< 10,000 files).

### Edge case: direct dependency on A from C

If C references `A::something` directly (without going through B), this creates a direct dependency from C to A, which IS tracked. Both the transitive invalidation and the direct dependency will find C.

### Invalidation direction

Invalidation only flows *forward* through the dependency graph (from changed file to dependents). It never flows *backward* (from changed file to its dependencies). Changing A does not invalidate files that A depends on.

### Performance target

| Operation | Target | Measured (Phase 4 baseline) | Status |
|-----------|--------|---------------------------|--------|
| Cross-file go-to-definition | < 10ms | p50: 0.001ms, p99: 0.009ms | ✓ Well under target |
| Single file edit propagation (A→B→C chain) | < 50ms | p50: 0.378ms, p99: 0.865ms | ✓ Well under target |
| Cold workspace index (15 files) | < 5s for 1000 files | p50: 17.9ms, p99: 22.2ms (1.2ms per file) | ✓ On track for 1000-file target (~1.2s) |
| Module resolution per reference | < 1ms | Included in go-to-definition (cached) | ✓ Cached lookups are sub-microsecond |
| Cross-file test suite (17 tests) | N/A | 77-91ms total, ~5ms per test | Measurement only |

Measurement environment: AMD Ryzen 7 3700X, Bun 1.3.11, Pike 8.0.1116, corpus files on NVMe.

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

### Deviation 1: No `.so` binary module resolution

| Aspect | Detail |
|--------|--------|
| **What Pike does** | Pike's dynamic loader resolves `.so` files via `dlopen`. Many core types are C builtins: `Stdio.File`, `Image.Image`, `_ADT`, `Nettle`, `GL`, etc. (61 `.so` files in the 8.0.1116 installation). |
| **What the LSP does** | Skips `.so` entirely. `findModuleInPath` tries `.pmod` directory → `.pmod` file → `.pike` file. No `.so` step. |
| **User-visible effect** | Go-to-definition on `Stdio.File` returns null. Hover shows nothing. The LSP cannot navigate into any C-implemented module. |
| **Trigger for revisiting** | Phase 5 pike-ai-kb integration can provide a pre-built system module map. A `resolve.pike` script using `master()->resolv()` and `program_defined()` can enumerate all system module members at startup. |
| **Corpus verification** | On our corpus: `Stdio` resolves correctly (→ `Stdio.pmod/module.pmod`). `Stdio.File` returns NOT FOUND. All other stdlib references (`Array`, `Mapping`, `String`, `Calendar`, `Stdio.Terminfo`, `Stdio.Readline`, `Stdio.FakeFile`) resolve correctly. |

### Deviation 2: No `joinnode` multi-path merge

| Aspect | Detail |
|--------|--------|
| **What Pike does** | `master()->joinnode` merges symbols from multiple search paths when the same module name exists in multiple locations. E.g., `Stdio` in both system path and a workspace `lib/` path → merged node with symbols from both. |
| **What the LSP does** | First-match-wins. Workspace paths are searched before system paths, so a workspace `Stdio.pmod` shadows the system one entirely. |
| **User-visible effect** | If a workspace defines `Stdio.pmod` (unlikely but possible), the LSP shows only workspace symbols, not the merged set. In practice, workspaces rarely shadow system modules. |
| **Trigger for revisiting** | Fix when a real workspace reports resolution disagreement. The corpus doesn't exercise this case. |
| **Corpus verification** | `cross_import_a` is a workspace-only module — both Pike and LSP resolve it identically (single-path, no merge). All workspace modules resolve correctly because they don't exist in system paths. |

### Deviation 3: First-match-wins for module paths

| Aspect | Detail |
|--------|--------|
| **What Pike does** | Pike searches module paths in order but uses `joinnode` to merge when the same module appears in multiple paths. This is effectively first-match for modules that only exist in one path. |
| **What the LSP does** | First-match-wins for ALL modules. For modules that exist in only one path (the common case), this is identical to Pike's behavior. |
| **User-visible effect** | Identical to Pike for single-path modules. Diverges only for multi-path modules (same name in workspace + system), which maps to deviation 2. |
| **Trigger for revisiting** | Same as deviation 2. |

### Deviation 4: No precompiled `.o` loading

| Aspect | Detail |
|--------|--------|
| **What Pike does** | Pike can load precompiled `.o` files (dumped bytecode). |
| **What the LSP does** | Ignores `.o` files. Only parses `.pike`, `.pmod` (file), and `.pmod/` (directory). |
| **User-visible effect** | None in practice. `.o` files are a build optimization; the source `.pike`/`.pmod` is always present alongside. |
| **Trigger for revisiting** | Fix if a workspace uses `.o`-only deployment without sources. |

### Deviation 5: No `module_checker` lazy loading

| Aspect | Detail |
|--------|--------|
| **What Pike does** | `module_checker` lazily resolves module symbols on first access. |
| **What the LSP does** | Eagerly indexes all workspace files on open/change. |
| **User-visible effect** | Higher upfront cost, but workspace is bounded and the cost is acceptable. |
| **Trigger for revisiting** | Optimize if workspace indexing exceeds latency targets (see performance section). |

## Harness Extension

### Status: NOT IMPLEMENTED

The cross-file resolution introspection harness (`harness/resolve.pike`) described below was planned but not built during Phase 4. Phase 4 testing uses structural expectations (see Ground Truth section).

### Planned cross-file resolution introspection

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

### Phase 5 prerequisite

Before Phase 5 adds type information and diagnostics that depend on cross-file resolution correctness, `resolve.pike` must be built and cross-file tests must use it as ground truth. The current structural tests are necessary but not sufficient for semantic correctness.

## Ground Truth Assessment

### What the Phase 4 cross-file tests verify

| Test category | Ground truth source | Oracle gap? |
|-------------|-------------------|------------|
| Inherit string literal resolution (→ target file) | Structural: file name in source code. `inherit "file.pike"` → file exists at that path. | No — path resolution is deterministic from the source. |
| Inherit with rename (→ target file) | Structural: same as above. | No. |
| Inherit chain (C→B→A) | Structural: each file inherits the next by string literal. | No. |
| Import declaration collected | Structural: import_decl exists in parse tree. | No — this is a symbol table test, not a resolution test. |
| Dependency graph (dependents) | Structural: if B inherits A, B depends on A. Deterministic from the source. | No. |
| .pmod directory module indexing | Structural: file parses without error. | **Yes** — the test doesn't verify that the LSP resolves the same members from the .pmod directory that Pike does. |
| #pike version detection | Structural: `#pike 7.8` in source → `{major: 7, minor: 8}`. | No. |
| Invalidation (one-hop and transitive) | Implementation contract: WorkspaceIndex design. | N/A — testing our own machinery, not Pike's behavior. |

### Where the oracle gap matters

The structural tests verify that the LSP's cross-file wiring works mechanically. They do NOT verify:

1. **Which class is the inherit target.** When B inherits `"file.pike"` and that file has multiple classes, does the LSP pick the same one Pike does?
2. **Which members are inherited.** Does the LSP see the same members through inherit as Pike?
3. **Import symbol availability.** Does `import cross_import_a` bring the same symbols into scope that Pike makes available?
4. **.pmod directory member enumeration.** Does the LSP list the same members from `cross_pmod_dir.pmod/` that Pike resolves?

These are Phase 5 concerns. Phase 4's scope is the wiring (index, resolution, invalidation), not the semantic correctness of what flows through the wires.
## Consequences

- The workspace index is in-memory only. No on-disk persistence in Phase 4.
- The index is rebuilt from scratch on server restart. Acceptable for Phase 4.
- Module resolution is file-system-based. The LSP reads directories and files to discover modules, matching Pike's `dirnode` behavior.
- System stdlib modules are resolved by path lookup in Pike's installation directory, not by querying Pike at runtime. This is faster but may miss dynamic module behavior.
- Cross-file resolution is scoped to workspace files + Pike system modules. External dependencies not in the workspace are not resolved.
- The ModificationSource enum drives invalidation decisions, preventing both over-invalidation (wasting CPU) and under-invalidation (serving stale results).
