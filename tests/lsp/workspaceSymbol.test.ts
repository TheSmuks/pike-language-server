/**
 * Workspace symbol search tests (US-020).
 *
 * Tests workspace/symbol via LSP protocol.
 * Verifies cross-file symbol search with prefix matching.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

interface SymbolInfoResult {
  name: string;
  kind: number;
  location: {
    uri: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  };
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

describe("US-020: workspace/symbol", () => {
  test("finds class by name", async () => {
    const src = [
      "class Animal {",
      "  string name;",
      "  void speak() { }",
      "}",
    ].join("\n");
    server.openDoc("file:///test/ws-class.pike", src);

    const result = await server.client.sendRequest("workspace/symbol", {
      query: "Animal",
    }) as SymbolInfoResult[] | null;

    expect(result).not.toBeNull();
    const animal = result!.find(s => s.name === "Animal");
    expect(animal).toBeDefined();
    expect(animal!.kind).toBe(5); // SymbolKind.Class
    expect(animal!.location.uri).toBe("file:///test/ws-class.pike");
  });

  test("finds function by name", async () => {
    const src = [
      "int calculate(int x) {",
      "  return x * 2;",
      "}",
    ].join("\n");
    server.openDoc("file:///test/ws-func.pike", src);

    const result = await server.client.sendRequest("workspace/symbol", {
      query: "calc",
    }) as SymbolInfoResult[] | null;

    expect(result).not.toBeNull();
    const calc = result!.find(s => s.name === "calculate");
    expect(calc).toBeDefined();
    expect(calc!.kind).toBe(12); // SymbolKind.Function
  });

  test("partial match is case-insensitive", async () => {
    const src = [
      "class MyHandler { }",
    ].join("\n");
    server.openDoc("file:///test/ws-partial.pike", src);

    const result = await server.client.sendRequest("workspace/symbol", {
      query: "myh",
    }) as SymbolInfoResult[] | null;

    expect(result).not.toBeNull();
    const handler = result!.find(s => s.name === "MyHandler");
    expect(handler).toBeDefined();
  });

  test("returns empty for no matches", async () => {
    const result = await server.client.sendRequest("workspace/symbol", {
      query: "zzz_nonexistent",
    }) as SymbolInfoResult[] | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBe(0);
  });

  test("finds symbols across multiple files", async () => {
    const src1 = [
      "class Logger { }",
    ].join("\n");
    const src2 = [
      "class LogWriter { }",
    ].join("\n");
    server.openDoc("file:///test/ws-multi1.pike", src1);
    server.openDoc("file:///test/ws-multi2.pike", src2);

    const result = await server.client.sendRequest("workspace/symbol", {
      query: "Log",
    }) as SymbolInfoResult[] | null;

    expect(result).not.toBeNull();
    const names = result!.map(s => s.name);
    expect(names).toContain("Logger");
    expect(names).toContain("LogWriter");
  });

  test("skips parameters from results", async () => {
    const src = [
      "int add(int a, int b) {",
      "  return a + b;",
      "}",
    ].join("\n");
    server.openDoc("file:///test/ws-skip-params.pike", src);

    const result = await server.client.sendRequest("workspace/symbol", {
      query: "a",
    }) as SymbolInfoResult[] | null;

    expect(result).not.toBeNull();
    const params = result!.filter(s => s.name === "a" || s.name === "b");
    // Parameters should not appear in workspace symbol results
    expect(params.length).toBe(0);
  });
});
