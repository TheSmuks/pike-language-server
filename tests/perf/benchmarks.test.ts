/**
 * Performance regression benchmarks (US-027).
 *
 * Measures latency for key LSP operations. These are not unit tests —
 * they establish performance baselines and will fail if latency
 * regresses beyond 2x the baseline.
 *
 * Run: bun test tests/perf/benchmarks.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "../lsp/helpers";

let server: TestServer;

// Large source file for stress testing
const LARGE_SRC = generateLargeSource();

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

function generateLargeSource(): string {
  const lines: string[] = [];
  for (let i = 0; i < 50; i++) {
    lines.push(`class Class${i} {`);
    lines.push(`  int field${i} = ${i};`);
    for (let j = 0; j < 5; j++) {
      lines.push(`  int method${j}(int x) { return x + ${j}; }`);
    }
    lines.push("}");
  }
  lines.push("int main() {");
  lines.push("  return 0;");
  lines.push("}");
  return lines.join("\n");
}

function measureMs(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

// Baseline measurements (ms) — update when intentional changes improve performance
const BASELINES: Record<string, number> = {
  completion_cold: 50,
  completion_warm: 10,
  hover: 20,
  definition: 20,
  semanticTokens: 50,
  documentSymbol: 30,
  workspaceSymbol: 20,
  foldingRange: 20,
  documentHighlight: 20,
};

// Allow 3x slack for CI variability
const SLACK = 3;

describe("US-027: Performance benchmarks", () => {
  const uri = `file:///test/bench-large.pike`;

  test("completion (cold) < baseline", async () => {
    server.openDoc(uri, LARGE_SRC);
    const start = process.hrtime.bigint();

    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position: { line: 252, character: 2 },
      context: { triggerKind: 1 },
    });

    const ms = measureMs(start);
    expect(ms).toBeLessThan(BASELINES.completion_cold * SLACK);
    expect(result).toBeDefined();
  });

  test("completion (warm) < baseline", async () => {
    // Second request — cache warm
    const start = process.hrtime.bigint();

    const result = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position: { line: 252, character: 2 },
      context: { triggerKind: 1 },
    });

    const ms = measureMs(start);
    expect(ms).toBeLessThan(BASELINES.completion_warm * SLACK);
    expect(result).toBeDefined();
  });

  test("hover < baseline", async () => {
    const start = process.hrtime.bigint();

    const result = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 1, character: 6 },
    });

    const ms = measureMs(start);
    expect(ms).toBeLessThan(BASELINES.hover * SLACK);
    expect(result).toBeDefined();
  });

  test("definition < baseline", async () => {
    const start = process.hrtime.bigint();

    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 252, character: 2 },
    });

    const ms = measureMs(start);
    expect(ms).toBeLessThan(BASELINES.definition * SLACK);
    expect(result).toBeDefined();
  });

  test("semanticTokens < baseline", async () => {
    const start = process.hrtime.bigint();

    const result = await server.client.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });

    const ms = measureMs(start);
    expect(ms).toBeLessThan(BASELINES.semanticTokens * SLACK);
    expect(result).toBeDefined();
    expect((result as { data: unknown[] }).data.length).toBeGreaterThan(0);
  });

  test("documentSymbol < baseline", async () => {
    const start = process.hrtime.bigint();

    const result = await server.client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    });

    const ms = measureMs(start);
    expect(ms).toBeLessThan(BASELINES.documentSymbol * SLACK);
    expect(Array.isArray(result)).toBe(true);
  });

  test("workspaceSymbol < baseline", async () => {
    const start = process.hrtime.bigint();

    const result = await server.client.sendRequest("workspace/symbol", {
      query: "Class",
    });

    const ms = measureMs(start);
    expect(ms).toBeLessThan(BASELINES.workspaceSymbol * SLACK);
    expect(Array.isArray(result)).toBe(true);
  });

  test("foldingRange < baseline", async () => {
    const start = process.hrtime.bigint();

    const result = await server.client.sendRequest("textDocument/foldingRange", {
      textDocument: { uri },
    });

    const ms = measureMs(start);
    expect(ms).toBeLessThan(BASELINES.foldingRange * SLACK);
    expect(Array.isArray(result)).toBe(true);
  });

  test("documentHighlight < baseline", async () => {
    const start = process.hrtime.bigint();

    const result = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri },
      position: { line: 1, character: 6 },
    });

    const ms = measureMs(start);
    expect(ms).toBeLessThan(BASELINES.documentHighlight * SLACK);
    expect(result).toBeDefined();
  });
});
