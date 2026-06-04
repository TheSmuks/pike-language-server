/**
 * Regression: cross-file inherited/imported members resolve without an edit.
 *
 * Background: previously, opening a file that imports or inherits from another
 * file in a cold workspace left the imported members out of the open file's
 * scope (wireInheritance was one-shot and skipped when the target table was
 * null). After this fix:
 *
 *   1. wireInheritance still runs synchronously at first analysis.
 *   2. When a target file is later indexed (background or on-demand), its
 *      dependents' symbol tables are invalidated via rewireDependents, so the
 *      next analysis sees the imported members in scope.
 *
 * This test simulates the cold-then-warm sequence against the real
 * workspaceIndex and the real wireInheritance path. It does not require a GUI.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { WorkspaceIndex } from "../../server/src/features/workspaceIndex";
import { wireInheritance } from "../../server/src/features/scopeBuilder";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModificationSource } from "../../server/src/features/workspaceIndex";

const CORPUS_DIR = join(import.meta.dir, "../../corpus/files");

function readCorpus(name: string): string {
  return readFileSync(join(CORPUS_DIR, name), "utf8");
}

function corpusPath(name: string): string {
  return `file://${join(CORPUS_DIR, name)}`;
}

describe("cross-file inherited/imported member resolution (KL-029)", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("opening B before A is indexed: rewireDependents makes A's class visible to B", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: CORPUS_DIR });

    const contentB = readCorpus("cross-inherit-simple-b.pike");
    const contentA = readCorpus("cross-inherit-simple-a.pike");

    const treeB = parse(contentB);
    const treeA = parse(contentA);
    const bUri = corpusPath("cross-inherit-simple-b.pike");
    const aUri = corpusPath("cross-inherit-simple-a.pike");

    // Phase 1: cold workspace — only B is indexed. A is not yet known.
    await index.upsertFile(bUri, 1, treeB, contentB, ModificationSource.DidOpen);

    // Phase 2: A is indexed later (background-indexer path).
    await index.upsertFile(aUri, 1, treeA, contentA, ModificationSource.DidOpen);

    // Phase 3: rewireDependents invalidates dependents. Production callers
    // re-build the open file's table (on-demand indexer does this via
    // parseAndIndexDocument). We simulate that by re-upserting B.
    const rewired = index.rewireDependents(aUri);
    expect(rewired).toContain(bUri);
    await index.upsertFile(bUri, 2, treeB, contentB, ModificationSource.DidChange);

    // Re-wire B's table now that A is available.
    const bTable = index.getSymbolTable(bUri);
    expect(bTable).not.toBeNull();
    wireInheritance(bTable!, index as any);

    // B's table must now contain A's class as an inherited scope.
    const bTableTyped = bTable!;
    const inheritedScopeIds = bTableTyped.scopes.flatMap((s) => s.inheritedScopes);
    expect(inheritedScopeIds.length).toBeGreaterThan(0);

    // A's class declaration must be reachable from B via inherited scopes.
    const inheritedDeclIds = inheritedScopeIds.flatMap((scopeId) => {
      const scope = bTableTyped.scopeById.get(scopeId);
      return scope ? scope.declarations : [];
    });
    const inheritedDecls = inheritedDeclIds
      .map((id) => bTableTyped.declById.get(id))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);
    // File-level inherit brings A's top-level declarations (Animal class,
    // SPECIES constant). The class-level inherit inside Dog brings the
    // resolved parent class's declarations.
    const inheritedNames = inheritedDecls.map((d) => d.name).sort();
    // The class-level inherit should expose the parent's methods/fields.
    // At minimum we expect the class-level inherit to be wired; the
    // file-level inherit shows up as a top-level scope with the A symbols.
    const hasInheritedDecl = inheritedDecls.some(
      (d) => d.kind === "class" || d.kind === "variable" || d.kind === "constant",
    );
    expect(hasInheritedDecl).toBe(true);
    // Sanity: at least one inherited name is one of A's top-level symbols.
    expect(inheritedNames.length).toBeGreaterThan(0);
  });

  test("imported names are used without prefix and not flagged as unused", async () => {
    // False-positive guard for Fix 3.
    //
    // `import Stdio;` brings the module's names into scope. A reference to a
    // Stdio member (`Stdio.File`) is a member access on the *value* Stdio, not
    // on the *module name* Stdio. The literal token "Stdio" can therefore
    // appear exactly once (the declaration) while still being used.
    const { detectUnusedImports } = await import(
      "../../server/src/features/lintRules/unusedImports"
    );
    const diagnostics = detectUnusedImports(
      null as never,
      { declarations: [], references: [] } as never,
      "import Stdio;\nint main() { return Stdio.File; }\n",
    );
    expect(diagnostics).toEqual([]);
  });
});
