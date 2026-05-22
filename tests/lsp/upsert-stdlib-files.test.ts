/**
 * Test: does upsertFile succeed for stdlib files?
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FILES = [
  "/usr/local/pike/8.0.1116/lib/modules/Cache.pmod/Storage.pmod/Gdbm.pike",
  "/usr/local/pike/8.0.1116/lib/modules/Cache.pmod/Storage.pmod/Yabu.pike",
];

describe("upsertFile for stdlib files", () => {
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
