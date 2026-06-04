/**
 * Regression tests for cold workspace-index refresh wiring.
 *
 * The bug was not that CodeLens/reference counting was wrong once the index was
 * warm; it was that VS Code was never asked to re-request index-dependent
 * features after background indexing made dependencies available.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

function readProjectFile(path: string): string {
  return readFileSync(join(ROOT, path), "utf-8");
}

describe("index-warm refresh wiring", () => {
  test("background index exposes an onFileIndexed callback", () => {
    const source = readProjectFile("server/src/features/backgroundIndex.ts");

    expect(source).toContain("onFileIndexed?: (uri: string) => void");
    expect(source).toContain("onFileIndexed?.(file.uri)");
  });

  test("background indexing refreshes affected open documents", () => {
    const source = readProjectFile("server/src/serverLifecycle.ts");

    expect(source).toContain("workspace/codeLens/refresh");
    expect(source).toContain("ctx.diagnosticManager.onDidChange(uri)");
    expect(source).toContain("connection.languages.semanticTokens.refresh()");
    expect(source).toContain("setTimeout(() =>");
    expect(source).toContain("}, 200)");
  });

  test("newly indexed files invalidate dependents for inheritance rewire", () => {
    const lifecycle = readProjectFile("server/src/serverLifecycle.ts");
    const index = readProjectFile("server/src/features/workspaceIndexClass.ts");

    expect(lifecycle).toContain("index.rewireDependents(uri)");
    expect(index).toContain("rewireDependents(uri: string): string[]");
    expect(index).toContain("this.invalidateWithDependents(depUri)");
  });
});
