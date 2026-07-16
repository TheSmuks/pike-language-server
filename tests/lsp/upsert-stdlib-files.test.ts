/**
 * Test: does upsertFile succeed for stdlib files?
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { pikeAvailable, stdlibModulePath } from "../helpers/pikeAvailable";

// Resolved from the running Pike, not hardcoded: a dev box has Pike at
// /usr/local/pike/<ver> while CI builds it into $HOME/.pike, so an absolute
// path here only ever runs in one of those places.
const FILES = [
  stdlibModulePath("Cache.pmod/Storage.pmod/Gdbm.pike"),
  stdlibModulePath("Cache.pmod/Storage.pmod/Yabu.pike"),
].filter((p): p is string => p !== null);

// Pike is configurable — these Cache.pmod backends are not in every build.
describe.skipIf(!pikeAvailable || FILES.length === 0)("upsertFile for stdlib files", () => {
  let index: WorkspaceIndex;

  beforeAll(async () => {
    await initParser();
    // Create index with the actual pike paths
    index = await WorkspaceIndex.create(
      "/tmp/test-workspace",
      "pike",
    );
  });

  for (const fp of FILES) {
    const name = fp.split("/").pop()!;

    test(`${name}: upsertFile succeeds`, async () => {
      const source = readFileSync(fp, "utf8");
      const uri = pathToFileURL(fp).href;
      const tree = parse(source, uri);

      const entry = await index.upsertFile(uri, 1, tree, source, ModificationSource.DidChange);
      expect(entry).toBeDefined();
      expect(entry.symbolTable).not.toBeNull();
      expect(entry.symbolTable!.declarations.length).toBeGreaterThan(0);
      console.log(`  ${name}: ${entry.symbolTable!.declarations.length} declarations, ${entry.dependencies.size} deps`);
      console.log(`  pikeVersion: ${JSON.stringify(entry.pikeVersion)}`);
    });
  }
});
