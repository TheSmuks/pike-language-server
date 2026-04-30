/**
 * Signature help tests (US-017).
 *
 * Tests textDocument/signatureHelp via LSP protocol.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

interface SignatureHelpResult {
  signatures: Array<{
    label: string;
    documentation?: string;
    parameters: Array<{ label: string }>;
  }>;
  activeSignature: number;
  activeParameter: number;
}

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

describe("US-017: textDocument/signatureHelp", () => {
  test("shows signature for local function call", async () => {
    const src = [
      "int add(int a, int b) { return a + b; }",
      "int main() {",
      "  int result = add(",
      "    1,",
      "    2",
      "  );",
      "  return result;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/sig-local.pike", src);

    // Position after 'add(' — line 2, char 18
    const result = await server.client.sendRequest("textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: 2, character: 18 },
    }) as SignatureHelpResult | null;

    expect(result).not.toBeNull();
    expect(result!.signatures.length).toBe(1);
    expect(result!.signatures[0].label).toContain("add");
    expect(result!.signatures[0].parameters.length).toBe(2);
    expect(result!.activeParameter).toBe(0);
  });

  test("tracks active parameter after comma", async () => {
    const src = [
      "int add(int a, int b) { return a + b; }",
      "int main() {",
      "  int result = add(1,",
      "    2",
      "  );",
      "  return result;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/sig-comma.pike", src);

    // Position after '1,' — line 3, char 4 (after the comma and newline)
    const result = await server.client.sendRequest("textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: 3, character: 4 },
    }) as SignatureHelpResult | null;

    expect(result).not.toBeNull();
    expect(result!.activeParameter).toBe(1); // Second parameter active
  });

  test("shows signature for class method call", async () => {
    const src = [
      "class Dog {",
      "  string get_name() { return \"\"; }",
      "  void speak(int volume) {}",
      "}",
      "int main() {",
      "  Dog d = Dog();",
      "  d->speak(",
      "    10",
      "  );",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/sig-method.pike", src);

    // Position after 'speak(' — line 7, char 9
    const result = await server.client.sendRequest("textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: 7, character: 9 },
    }) as SignatureHelpResult | null;

    expect(result).not.toBeNull();
    expect(result!.signatures[0].label).toContain("speak");
    expect(result!.signatures[0].parameters.length).toBe(1);
  });

  test("shows signature for local function with no parameters", async () => {
    const src = [
      "string greet() { return \"hello\"; }",
      "int main() {",
      "  string s = greet(",
      "  );",
      "  return 0;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/sig-noparam.pike", src);

    // Position after 'greet(' — line 2, char 19
    const result = await server.client.sendRequest("textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: 2, character: 19 },
    }) as SignatureHelpResult | null;

    expect(result).not.toBeNull();
    expect(result!.signatures[0].label).toContain("greet");
    expect(result!.signatures[0].parameters.length).toBe(0);
  });

  test("returns null when not inside a call", async () => {
    const src = [
      "int main() {",
      "  int x = 42;",
      "  return x;",
      "}",
    ].join("\n");
    const uri = server.openDoc("file:///test/sig-nocall.pike", src);

    // Position on 'x' — not inside a call
    const result = await server.client.sendRequest("textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: 1, character: 6 },
    });

    expect(result).toBeNull();
  });
});
