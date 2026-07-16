/**
 * Reproduction test: hover on stdlib files outside the workspace.
 * Uses Cache.pmod/Storage.pmod/{Gdbm,Yabu}.pike from the running Pike.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { getDefinitionAt } from "../../server/src/features/symbolTable";
import type { BuildIndex } from "../../server/src/features/symbolTable";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { pikeAvailable, stdlibModulePath } from "../helpers/pikeAvailable";

// Resolved from the running Pike, not hardcoded — see upsert-stdlib-files.test.ts.
const FILES = [
  stdlibModulePath("Cache.pmod/Storage.pmod/Gdbm.pike"),
  stdlibModulePath("Cache.pmod/Storage.pmod/Yabu.pike"),
].filter((p): p is string => p !== null);

/** A BuildIndex that resolves nothing — these files are read in isolation. */
const nullIndex: BuildIndex = {
  getSymbolTable: () => null,
  resolveImport: () => null,
  resolveInherit: () => null,
  resolveInclude: () => null,
};

describe.skipIf(!pikeAvailable || FILES.length === 0)("Hover on stdlib files outside workspace", () => {
  beforeAll(async () => {
    await initParser();
  });

  for (const fp of FILES) {
    const name = fp.split("/").pop()!;

    describe(name, () => {
      const source = readFileSync(fp, "utf8");
      const uri = pathToFileURL(fp).href;

      test("parses without errors", () => {
        const tree = parse(source, uri);
        expect(tree.rootNode.hasError).toBe(false);
      });

      test("builds symbol table with declarations", () => {
        const tree = parse(source, uri);
        const table = buildSymbolTable(tree, uri, 1, { index: nullIndex }, source);
        expect(table.declarations.length).toBeGreaterThan(0);
        expect(table.scopes.length).toBeGreaterThan(0);
      });

      test("finds declaration for 'db' variable", () => {
        const tree = parse(source, uri);
        const table = buildSymbolTable(tree, uri, 1, { index: nullIndex }, source);
        
        // Find the line with "Gdbm.gdbm db" or similar variable decl
        const lines = source.split("\n");
        const dbLine = lines.findIndex(l => /\bdb\b/.test(l) && !l.includes("Gdbm.gdbm db"));
        if (dbLine === -1) {
          // Try the declaration line directly
          const dbDeclLine = lines.findIndex(l => /\bgdbm\s+db\b/.test(l) || /^\s+Gdbm\.gdbm\s+db/.test(l));
          console.log(`  db declaration at line ${dbDeclLine}: ${lines[dbDeclLine]?.trim()}`);
        }
        
        // Get a variable we know exists
        const dbDecl = table.declarations.find(d => d.name === "db" && d.kind === "variable");
        expect(dbDecl).toBeDefined();
        console.log(`  db declaration: L${dbDecl!.range.start.line}, nameRange: L${dbDecl!.nameRange.start.line}:C${dbDecl!.nameRange.start.character}-${dbDecl!.nameRange.end.character}`);
        
        // Try to look up at the name position
        const result = getDefinitionAt(table, dbDecl!.nameRange.start.line, dbDecl!.nameRange.start.character);
        console.log(`  getDefinitionAt(L${dbDecl!.nameRange.start.line}, C${dbDecl!.nameRange.start.character}): ${result ? `${result.kind} "${result.name}"` : "null"}`);
      });

      test("finds declaration for 'Data' class", () => {
        const tree = parse(source, uri);
        const table = buildSymbolTable(tree, uri, 1, { index: nullIndex }, source);
        
        const dataDecl = table.declarations.find(d => d.name === "Data" && d.kind === "class");
        expect(dataDecl).toBeDefined();
        console.log(`  Data class: L${dataDecl!.range.start.line}`);
        
        const result = getDefinitionAt(table, dataDecl!.nameRange.start.line, dataDecl!.nameRange.start.character);
        expect(result).not.toBeNull();
        expect(result!.name).toBe("Data");
        console.log(`  getDefinitionAt for "Data": ${result?.kind} "${result?.name}"`);
      });
    });
  }
});
