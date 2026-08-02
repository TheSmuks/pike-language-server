/**
 * The dependency-overlay cap must not truncate silently.
 *
 * Each overlay handed to `worker.diagnose()` is a cache eviction the worker
 * performs before recompiling. A dependency the cap drops is therefore a
 * module the worker keeps serving from its stale cache, so the diagnostics
 * published for the edited file can describe a version of that module the user
 * no longer has. That is a wrong answer, not a missing one, and the warning
 * emitted here is its only visible trace.
 *
 * The cap is injectable so this costs three files instead of a 64-file
 * fixture; production always uses DEPENDENCY_OVERLAY_CAP.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import type { Connection, TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";

import {
  collectDependencyOverlays,
  resetDependencyOverlayWarnings,
  DEPENDENCY_OVERLAY_CAP,
} from "../../server/src/features/diagnosticPropagation";
import type { WorkspaceIndex } from "../../server/src/features/workspaceIndex";
import { setLogPathRedactionEnabled } from "../../server/src/util/errorLog";

/** A chain a.pike -> b.pike -> c.pike -> d.pike under /test. */
const CHAIN: Record<string, string[]> = {
  "file:///test/a.pike": ["file:///test/b.pike"],
  "file:///test/b.pike": ["file:///test/c.pike"],
  "file:///test/c.pike": ["file:///test/d.pike"],
  "file:///test/d.pike": [],
};

function stubIndex(graph: Record<string, string[]> = CHAIN): WorkspaceIndex {
  return {
    workspaceRoot: "/test",
    getFile: (uri: string) =>
      graph[uri] ? { dependencies: new Set(graph[uri]) } : undefined,
  } as unknown as WorkspaceIndex;
}

/** One root importing `n` leaves. */
function fanOut(n: number): Record<string, string[]> {
  const leaves = Array.from({ length: n }, (_, i) => `file:///test/leaf${i}.pike`);
  const graph: Record<string, string[]> = { "file:///test/root.pike": leaves };
  for (const leaf of leaves) graph[leaf] = [];
  return graph;
}

const NO_DOCUMENTS = {
  get: () => undefined,
} as unknown as TextDocuments<TextDocument>;

function captureConnection(): { connection: Connection; warnings: string[] } {
  const warnings: string[] = [];
  const connection = {
    sendNotification: (method: string, params: { level: string; lines: string[] }) => {
      if (method === "pike/log" && params.level === "WARN") {
        warnings.push(params.lines.join("\n"));
      }
    },
    console: { error: () => {} },
  } as unknown as Connection;
  return { connection, warnings };
}

describe("dependency overlay cap", () => {
  beforeEach(() => {
    resetDependencyOverlayWarnings();
    // Log paths are redacted by default; turn it off so the assertions can see
    // which file the warning names. Restored in afterAll.
    setLogPathRedactionEnabled(false);
  });

  afterAll(() => {
    setLogPathRedactionEnabled(true);
  });

  test("an untruncated closure is silent and complete", () => {
    const { connection, warnings } = captureConnection();
    const deps = collectDependencyOverlays(
      "file:///test/a.pike", stubIndex(), NO_DOCUMENTS, { connection },
    );

    expect(deps.map((d) => d.file)).toEqual([
      "/test/d.pike", "/test/c.pike", "/test/b.pike",
    ]);
    expect(warnings).toEqual([]);
  });

  test("truncation is reported with the count dropped and the file", () => {
    const { connection, warnings } = captureConnection();
    const deps = collectDependencyOverlays(
      "file:///test/a.pike", stubIndex(), NO_DOCUMENTS, { connection, cap: 2 },
    );

    expect(deps).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("file:///test/a.pike");
    expect(warnings[0]).toContain("(2)");
    expect(warnings[0]).toContain("1 dependency");
  });

  test("a repeated truncation does not re-warn per keystroke", () => {
    const { connection, warnings } = captureConnection();
    for (let i = 0; i < 5; i++) {
      collectDependencyOverlays(
        "file:///test/a.pike", stubIndex(), NO_DOCUMENTS, { connection, cap: 2 },
      );
    }
    expect(warnings).toHaveLength(1);
  });

  test("a truncation of a different size warns again", () => {
    const { connection, warnings } = captureConnection();
    collectDependencyOverlays(
      "file:///test/root.pike", stubIndex(fanOut(100)), NO_DOCUMENTS, { connection, cap: 4 },
    );
    collectDependencyOverlays(
      "file:///test/root.pike", stubIndex(fanOut(100)), NO_DOCUMENTS, { connection, cap: 2 },
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("96 dependencies");
    expect(warnings[1]).toContain("98 dependencies");
  });

  test("the production cap is 64 and a wide fan-out honours it", () => {
    expect(DEPENDENCY_OVERLAY_CAP).toBe(64);

    const { connection, warnings } = captureConnection();
    const deps = collectDependencyOverlays(
      "file:///test/root.pike", stubIndex(fanOut(100)), NO_DOCUMENTS, { connection },
    );

    expect(deps).toHaveLength(DEPENDENCY_OVERLAY_CAP);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("36 dependencies");
  });

  /**
   * Regression: the cap counted pushed overlays, but entries are pushed
   * post-order — the count is still zero all the way down a chain, so a deep
   * chain used to walk past the cap unbounded. A 500-deep chain is exactly the
   * degenerate graph the cap exists to stop.
   */
  test("a chain deeper than the cap is bounded too", () => {
    const graph: Record<string, string[]> = {};
    for (let i = 0; i < 500; i++) {
      graph[`file:///test/n${i}.pike`] = [`file:///test/n${i + 1}.pike`];
    }
    graph["file:///test/n500.pike"] = [];

    const { connection, warnings } = captureConnection();
    const deps = collectDependencyOverlays(
      "file:///test/n0.pike", stubIndex(graph), NO_DOCUMENTS, { connection },
    );

    expect(deps).toHaveLength(DEPENDENCY_OVERLAY_CAP);
    expect(warnings).toHaveLength(1);
  });
});
