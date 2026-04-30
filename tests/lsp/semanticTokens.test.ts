/**
 * Semantic token production tests (US-013).
 *
 * Tests the produceSemanticTokens and deltaEncodeTokens functions
 * against simple Pike source parsed through tree-sitter.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Parser, Language } from "web-tree-sitter";
import { buildSymbolTable, type SymbolTable } from "../../server/src/features/symbolTable";
import { createTestServer, type TestServer } from "./helpers";
import {
  produceSemanticTokens,
  deltaEncodeTokens,
  tokenTypeForDeclKind,
  tokenModifiersForDecl,
  METHOD_TYPE_ID,
  SEMANTIC_TOKENS_LEGEND,
  type SemanticToken,
} from "../../server/src/features/semanticTokens";

let parser: Parser;

beforeAll(async () => {
  await Parser.init();
  parser = new Parser();
  const lang = await Language.load("./server/tree-sitter-pike.wasm");
  parser.setLanguage(lang);
});

afterAll(() => {
  parser.delete();
});

// Helper to parse and build symbol table
function parseAndBuild(src: string): SymbolTable {
  const tree = parser.parse(src);
  assert(tree, "Parse failed");
  return buildSymbolTable(tree, src, "file:///test.pike");
}

function assert(condition: unknown, msg: string): asserts condition {
  if (!condition) throw new Error(msg);
}

// Helper to find a token by name
function findToken(tokens: SemanticToken[], line: number, character: number): SemanticToken | undefined {
  return tokens.find(t => t.line === line && t.character === character);
}

// ---------------------------------------------------------------------------
// Legend structure
// ---------------------------------------------------------------------------

describe("Semantic token legend", () => {
  test("legend has correct number of token types", () => {
    expect(SEMANTIC_TOKENS_LEGEND.tokenTypes.length).toBe(9);
  });

  test("legend has correct number of token modifiers", () => {
    expect(SEMANTIC_TOKENS_LEGEND.tokenModifiers.length).toBe(5);
  });

  test("token types include class, function, variable, method", () => {
    expect(SEMANTIC_TOKENS_LEGEND.tokenTypes).toContain("class");
    expect(SEMANTIC_TOKENS_LEGEND.tokenTypes).toContain("function");
    expect(SEMANTIC_TOKENS_LEGEND.tokenTypes).toContain("variable");
    expect(SEMANTIC_TOKENS_LEGEND.tokenTypes).toContain("method");
  });
});

// ---------------------------------------------------------------------------
// DeclKind → TokenType mapping
// ---------------------------------------------------------------------------

describe("DeclKind to TokenType mapping", () => {
  test("class maps to class (index 0)", () => {
    expect(tokenTypeForDeclKind("class")).toBe(0);
  });

  test("function maps to function (index 3)", () => {
    expect(tokenTypeForDeclKind("function")).toBe(3);
  });

  test("variable maps to variable (index 5)", () => {
    expect(tokenTypeForDeclKind("variable")).toBe(5);
  });

  test("constant maps to variable (index 5) with readonly", () => {
    expect(tokenTypeForDeclKind("constant")).toBe(5);
    const mods = tokenModifiersForDecl("constant");
    expect(mods & (1 << 2)).toBeTruthy(); // readonly bit
  });

  test("parameter maps to parameter (index 6)", () => {
    expect(tokenTypeForDeclKind("parameter")).toBe(6);
  });

  test("inherit maps to namespace (index 8)", () => {
    expect(tokenTypeForDeclKind("inherit")).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Token production from symbol table
// ---------------------------------------------------------------------------

describe("produceSemanticTokens", () => {
  test("produces tokens for class and method", () => {
    const src = [
      "class Dog {",
      "  void speak() {}",
      "}",
    ].join("\n");
    const table = parseAndBuild(src);
    const tokens = produceSemanticTokens(table);

    // 'Dog' at line 0, char 6
    const classToken = findToken(tokens, 0, 6);
    expect(classToken).toBeDefined();
    expect(classToken!.typeId).toBe(0); // class

    // 'speak' at line 1, char 7 — should be promoted to method (index 4)
    const methodToken = findToken(tokens, 1, 7);
    expect(methodToken).toBeDefined();
    expect(methodToken!.typeId).toBe(METHOD_TYPE_ID); // method (4)
  });

  test("produces tokens for top-level function (not method)", () => {
    const src = "int add(int a, int b) { return a + b; }";
    const table = parseAndBuild(src);
    const tokens = produceSemanticTokens(table);

    // 'add' at line 0, char 4 — should be function (3), not method (4)
    const fnToken = findToken(tokens, 0, 4);
    expect(fnToken).toBeDefined();
    expect(fnToken!.typeId).toBe(3); // function

    // 'a' parameter at line 0, char 12
    const paramA = findToken(tokens, 0, 12);
    expect(paramA).toBeDefined();
    expect(paramA!.typeId).toBe(6); // parameter
  });

  test("produces tokens for enum and enum members", () => {
    const src = [
      "enum Color {",
      "  RED, GREEN, BLUE,",
      "}",
    ].join("\n");
    const table = parseAndBuild(src);
    const tokens = produceSemanticTokens(table);

    // 'Color' at line 0, char 5
    const enumToken = findToken(tokens, 0, 5);
    expect(enumToken).toBeDefined();
    expect(enumToken!.typeId).toBe(1); // enum

    // 'RED' at line 1, char 2
    const memberToken = findToken(tokens, 1, 2);
    expect(memberToken).toBeDefined();
    expect(memberToken!.typeId).toBe(2); // enumMember
  });

  test("produces tokens for variables with correct types", () => {
    const src = [
      "int main() {",
      "  int count = 42;",
      "  string name = \"hello\";",
      "  return 0;",
      "}",
    ].join("\n");
    const table = parseAndBuild(src);
    const tokens = produceSemanticTokens(table);

    // 'count' at line 1, char 6
    const countToken = findToken(tokens, 1, 6);
    expect(countToken).toBeDefined();
    expect(countToken!.typeId).toBe(5); // variable

    // 'name' at line 2, char 9
    const nameToken = findToken(tokens, 2, 9);
    expect(nameToken).toBeDefined();
    expect(nameToken!.typeId).toBe(5); // variable
  });

  test("produces tokens for inherit declarations as namespace", () => {
    const src = [
      "class Animal {",
      "  string name;",
      "}",
      "class Dog {",
      "  inherit Animal;",
      "}",
    ].join("\n");
    const table = parseAndBuild(src);
    const tokens = produceSemanticTokens(table);

    // 'Animal' (inherit) at line 4, char 10 — should be namespace (8)
    // The inherit node's name is the inherited class name
    const inheritToken = tokens.find(t => t.typeId === 8);
    expect(inheritToken).toBeDefined();
  });

  test("tokens are sorted by position", () => {
    const src = [
      "class Dog { void speak() {} }",
      "int main() { return 0; }",
    ].join("\n");
    const table = parseAndBuild(src);
    const tokens = produceSemanticTokens(table);

    for (let i = 1; i < tokens.length; i++) {
      const prev = tokens[i - 1];
      const curr = tokens[i];
      if (prev.line === curr.line) {
        expect(curr.character).toBeGreaterThan(prev.character);
      } else {
        expect(curr.line).toBeGreaterThan(prev.line);
      }
    }
  });

  test("class members get static modifier", () => {
    const src = [
      "class Foo {",
      "  int value;",
      "  void set_value(int v) { value = v; }",
      "}",
    ].join("\n");
    const table = parseAndBuild(src);
    const tokens = produceSemanticTokens(table);

    // 'value' at line 1, char 6 — should have static modifier (bit 3)
    const valueToken = findToken(tokens, 1, 6);
    expect(valueToken).toBeDefined();
    expect(valueToken!.modifiers & (1 << 3)).toBeTruthy(); // static

    // 'set_value' at line 2, char 7 — should be method with static
    const methodToken = findToken(tokens, 2, 7);
    expect(methodToken).toBeDefined();
    expect(methodToken!.typeId).toBe(METHOD_TYPE_ID);
    expect(methodToken!.modifiers & (1 << 3)).toBeTruthy(); // static
  });
});

// ---------------------------------------------------------------------------
// Delta encoding
// ---------------------------------------------------------------------------

describe("deltaEncodeTokens", () => {
  test("encodes a single token correctly", () => {
    const tokens: SemanticToken[] = [
      { line: 0, character: 4, length: 3, typeId: 3, modifiers: 3 },
    ];
    const encoded = deltaEncodeTokens(tokens);
    // [deltaLine=0, deltaChar=4, length=3, typeId=3, modifiers=3]
    expect(encoded).toEqual([0, 4, 3, 3, 3]);
  });

  test("encodes two tokens on same line with relative positions", () => {
    const tokens: SemanticToken[] = [
      { line: 0, character: 4, length: 3, typeId: 3, modifiers: 3 },
      { line: 0, character: 12, length: 5, typeId: 5, modifiers: 3 },
    ];
    const encoded = deltaEncodeTokens(tokens);
    // Token 1: [0, 4, 3, 3, 3]
    // Token 2: [0, 8 (=12-4), 5, 5, 3]
    expect(encoded).toEqual([
      0, 4, 3, 3, 3,
      0, 8, 5, 5, 3,
    ]);
  });

  test("encodes tokens on different lines with absolute char positions", () => {
    const tokens: SemanticToken[] = [
      { line: 0, character: 4, length: 3, typeId: 3, modifiers: 3 },
      { line: 2, character: 6, length: 5, typeId: 0, modifiers: 3 },
    ];
    const encoded = deltaEncodeTokens(tokens);
    // Token 1: [0, 4, 3, 3, 3]
    // Token 2: [2 (=2-0), 6 (absolute since line changed), 5, 0, 3]
    expect(encoded).toEqual([
      0, 4, 3, 3, 3,
      2, 6, 5, 0, 3,
    ]);
  });

  test("returns empty array for empty input", () => {
    expect(deltaEncodeTokens([])).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// LSP protocol tests — textDocument/semanticTokens/full (US-014)
// ---------------------------------------------------------------------------


describe("US-014: semanticTokens/full LSP protocol", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("returns tokens for class with methods", async () => {
    const src = [
      'class Dog {',
      '  void speak() {}',
      '  string get_name() { return ""; }',
      '}',
    ].join('\n');
    const uri = server.openDoc("file:///test/semantic-class.pike", src);

    const result = await server.client.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data.length).toBeGreaterThan(0);
    // Should have at least Dog (class), speak (method), get_name (method)
    expect(result.data.length).toBeGreaterThanOrEqual(15); // 3 tokens × 5 ints each
  });

  test("returns tokens for variables and parameters", async () => {
    const src = [
      'int add(int a, int b) {',
      '  int result = a + b;',
      '  return result;',
      '}',
    ].join('\n');
    const uri = server.openDoc("file:///test/semantic-vars.pike", src);

    const result = await server.client.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    // Should have add (function), a (parameter), b (parameter), result (variable)
    expect(result.data.length).toBeGreaterThanOrEqual(15);
  });

  test("returns empty data for unknown document", async () => {
    const result = await server.client.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri: "file:///nonexistent.pike" },
    });

    expect(result).toBeDefined();
    expect(result.data).toEqual([]);
  });

  test("returns tokens for enum declarations", async () => {
    const src = [
      'enum Color { RED, GREEN, BLUE }',
    ].join('\n');
    const uri = server.openDoc("file:///test/semantic-enum.pike", src);

    const result = await server.client.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    // Color (enum) + RED, GREEN, BLUE (enumMember) = 4 tokens
    expect(result.data.length).toBeGreaterThanOrEqual(20); // 4 tokens × 5 ints
  });

  test("returns tokens for inherit declarations", async () => {
    const src = [
      'class Base { int value; }',
      'class Child {',
      '  inherit Base;',
      '}',
    ].join('\n');
    const uri = server.openDoc("file:///test/semantic-inherit.pike", src);

    const result = await server.client.sendRequest("textDocument/semanticTokens/full", {
      textDocument: { uri },
    });

    expect(result).toBeDefined();
    expect(result.data).toBeDefined();
    expect(result.data.length).toBeGreaterThan(0);
  });
});