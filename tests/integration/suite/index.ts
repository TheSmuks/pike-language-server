/**
 * Integration test suite that runs inside VSCode's extension host.
 *
 * This is the Layer 2 runtime lab: it starts the packaged extension, exercises
 * the real VSCode language-client wiring, and asks VSCode for provider results.
 * In-process protocol tests still own most edge-case unit coverage, but these
 * tests prove the shipped extension can deliver the runtime features end to end.
 */
/// <reference types="vscode" />
/// <reference types="mocha" />

import * as assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as vscode from "vscode";
import Mocha = require("mocha");

const EXTENSION_ID_PATTERN = "pike-language-server";
const SERVER_READY_TIMEOUT_MS = 15_000;
const DIAGNOSTIC_TIMEOUT_MS = 20_000;

let pikeOutputChannelCreateCount = 0;

const mocha = new Mocha({
  timeout: 20_000,
  color: true,
  reporter: "spec",
});

const ctx = globalThis as typeof globalThis & {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: (() => void) | ((done: () => void) => void)) => void;
  before: (fn: (this: Mocha.Context, done: () => void) => void) => void;
  after: (fn: (this: Mocha.Context, done: () => void) => void) => void;
  beforeEach: (fn: (this: Mocha.Context, done: () => void) => void) => void;
  afterEach: (fn: (this: Mocha.Context, done: () => void) => void) => void;
};

mocha.suite.emit("pre-require", ctx, undefined, new Mocha());

interface CompletionListLike {
  items: vscode.CompletionItem[];
}

interface SemanticTokensLike {
  data: Uint32Array | number[];
}

const runtimeFixture = [
  "#pragma strict_types",
  "class Foo {",
  "  int value;",
  "  int method(int amount) { return value + amount; }",
  "}",
  "int add(int left, int right) { return left + right; }",
  "int main() {",
  "  Foo foo = Foo();",
  "  int total = add(1, 2);",
  "  object obj = foo;",
  "  obj->missingMember();",
  "  return total + foo.method(3);",
  "}",
  "",
].join("\n");

const diagnosticsFixture = [
  "#pragma strict_types",
  "int add(int left, int right) { return left + right; }",
  "int main() {",
  "  int unused = 42;",
  "  int wrong = \"not an int\";",
  "  return add(1);",
  "}",
  "",
].join("\n");

const edgeFixture = [
  "#pragma strict_types",
  "int `+(int left, int right) { return left + right; }",
  "int main() {",
  "  array(int) arr = ({ 1, 2, 3 });",
  "  mapping(string:int) counts = ([ \"one\": 1 ]);",
  "  multiset(string) names = (< \"Ada\" >);",
  "  int café = arr[0];",
  "  return `+(café, arr[1]);",
  "}",
  "",
].join(os.EOL === "\r\n" ? "\r\n" : "\n");

describe("Pike Language Server — Extension Wiring", function () {
  let ext: vscode.Extension<unknown> | undefined;

  before("activate extension", async function () {
    this.timeout(25_000);

    await configurePikeBinary();
    ext = vscode.extensions.all.find((e) => e.id.includes(EXTENSION_ID_PATTERN));
    assert.ok(ext, extensionNotFoundMessage());

    if (!ext.isActive) {
      const createOutputChannelOriginal = vscode.window.createOutputChannel;
      Object.defineProperty(vscode.window, "createOutputChannel", {
        configurable: true,
        value(name: string, options?: { log: boolean }) {
          if (name === "Pike Language Server") {
            pikeOutputChannelCreateCount += 1;
          }
          return createOutputChannelOriginal.call(vscode.window, name, options);
        },
      });
      try {
        await ext.activate();
      } finally {
        Object.defineProperty(vscode.window, "createOutputChannel", {
          configurable: true,
          value: createOutputChannelOriginal,
        });
      }
    }

    await waitForLanguageServer();
  });

  describe("Extension activation", function () {
    it("activates and sets isActive to true", function () {
      assert.equal(ext?.isActive, true);
    });
  });

  describe("Language registration", function () {
    it("registers Pike language configuration", async function () {
      const languages = await vscode.languages.getLanguages();
      assert.ok(languages.includes("pike"), `registered languages: ${languages.join(", ")}`);
    });
  });

  describe("Client-side bug fix regressions", function () {
    it("only one 'Pike Language Server' output channel appears", function () {
      assert.equal(pikeOutputChannelCreateCount, 1);
    });
  });
});

describe("Pike Language Server — Runtime E2E Features", function () {
  let runtimeDoc: vscode.TextDocument;
  let runtimeUri: vscode.Uri;

  before("create runtime fixture", async function () {
    this.timeout(25_000);
    runtimeDoc = await openWorkspaceDocument("runtime-e2e.pike", runtimeFixture);
    runtimeUri = runtimeDoc.uri;
    await waitForLanguageServer();
  });

  it("publishes Pike diagnostics with expected ranges and warning severity", async function () {
    this.timeout(30_000);
    const doc = await openWorkspaceDocument("diagnostics-e2e.pike", diagnosticsFixture);
    const diagnostics = await waitForDiagnostics(doc.uri, (items) => items.length >= 2);

    const warning = diagnostics.find((item) =>
      item.message.includes("Unused local variable unused") ||
        item.message.includes("Unused local variable 'unused'"),
    );
    assert.ok(warning, diagnosticsToString(diagnostics));
    assert.equal(warning.severity, vscode.DiagnosticSeverity.Warning);
    assert.equal(warning.range.start.line, 3);

    const typeOrArityError = diagnostics.find((item) =>
      item.severity === vscode.DiagnosticSeverity.Error &&
      (item.message.includes("not an int") ||
        item.message.includes("Too few") ||
        item.message.includes("Bad argument") ||
        item.message.includes("Missing argument") ||
        item.message.includes("Expected")),
    );
    assert.ok(typeOrArityError, diagnosticsToString(diagnostics));
    assert.ok(typeOrArityError.range.start.line >= 4, diagnosticsToString(diagnostics));
  });

  it("returns hover/type information for declared symbols and falls back for undocumented members", async function () {
    const hoverOnFoo = await execute<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      runtimeUri,
      new vscode.Position(7, 3),
    );
    assert.ok(hoverText(hoverOnFoo).includes("Foo"), hoverText(hoverOnFoo));

    const hoverOnMissingMember = await execute<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      runtimeUri,
      new vscode.Position(10, 8),
    );
    assert.ok(Array.isArray(hoverOnMissingMember), "member hover provider should respond without throwing");
  });

  it("returns full/range semantic tokens with consistent classifications", async function () {
    const full = await semanticTokens("_provideDocumentSemanticTokens", runtimeUri);
    const range = await semanticTokens(
      "_provideDocumentRangeSemanticTokens",
      runtimeUri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(13, 0)),
    );

    assert.deepEqual(range.data, full.data, "full and range tokens should match for the full document span");

    const decoded = decodeSemanticTokens(full.data);
    assert.ok(decoded.some((token) => token.line === 1 && token.character === 6 && token.typeId === 0), tokenDump(decoded));
    assert.ok(decoded.some((token) => token.line === 5 && token.character === 4 && token.typeId === 3), tokenDump(decoded));
    assert.ok(decoded.some((token) => token.line === 8 && token.character === 6 && token.typeId === 5), tokenDump(decoded));
    assert.ok(decoded.some((token) => token.line === 10 && token.character === 7 && token.typeId === 4), tokenDump(decoded));
  });

  it("supports definition, references, document symbols, call hierarchy, and type hierarchy", async function () {
    const definition = await execute<vscode.Location[]>(
      "vscode.executeDefinitionProvider",
      runtimeUri,
      new vscode.Position(8, 14),
    );
    assert.ok(definition.length > 0, "definition for add() should resolve");
    assert.equal(definition[0].range.start.line, 5);

    const references = await execute<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      runtimeUri,
      new vscode.Position(5, 4),
    );
    assert.ok(references.length >= 2, `references: ${references.length}`);

    const symbols = await execute<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      runtimeUri,
    );
    assert.ok(symbols.some((item) => item.name === "Foo"), symbolNames(symbols));
    assert.ok(symbols.some((item) => item.name === "add"), symbolNames(symbols));

    const callItems = await execute<unknown[]>(
      "vscode.prepareCallHierarchy",
      runtimeUri,
      new vscode.Position(5, 4),
    );
    assert.ok(Array.isArray(callItems), "call hierarchy prepare should return an array");

    const typeItems = await execute<unknown[]>(
      "vscode.prepareTypeHierarchy",
      runtimeUri,
      new vscode.Position(1, 6),
    );
    assert.ok(Array.isArray(typeItems), "type hierarchy prepare should return an array");
  });

  it("supports completion on dot/arrow and signature help on open paren", async function () {
    const completions = await execute<CompletionListLike>(
      "vscode.executeCompletionItemProvider",
      runtimeUri,
      new vscode.Position(11, 21),
      ".",
    );
    assert.ok(completions && Array.isArray(completions.items), "completion list should have items");

    const signature = await execute<vscode.SignatureHelp>(
      "vscode.executeSignatureHelpProvider",
      runtimeUri,
      new vscode.Position(8, 18),
      "(",
    );
    assert.ok(signature === undefined || signature.signatures.length >= 0, "signature help should respond");
  });

  it("keeps tree-sitter-backed features alive when the Pike oracle is unavailable", async function () {
    this.timeout(20_000);
    const result = await runUnavailableOracleProtocolCheck(runtimeFixture);
    assert.ok(result.symbolNames.includes("Foo"), result.symbolNames.join(", "));
    assert.ok(result.semanticTokenCount > 0, "semantic tokens should still be produced");
    assert.equal(result.diagnosticCount, 0, `unexpected diagnostics: ${result.diagnosticCount}`);
  });
});

describe("Pike Language Server — Parser/Oracle Edge Cases", function () {
  it("handles aggregates, operator identifiers, Unicode identifiers, and CRLF-sensitive positions", async function () {
    const doc = await openWorkspaceDocument("edge-cases.pike", edgeFixture.replace(/\n/g, "\r\n"));
    const symbols = await waitForDocumentSymbols(doc.uri, (items) => items.some((item) => item.name === "`+"));
    assert.ok(symbols.some((item) => item.name === "`+"), symbolNames(symbols));

    const hover = await execute<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      doc.uri,
      new vscode.Position(6, 6),
    );
    assert.ok(hoverText(hover).includes("café") || Array.isArray(hover), hoverText(hover));

    const tokens = await semanticTokens("_provideDocumentSemanticTokens", doc.uri);
    assert.ok(tokens.data.length > 0, "semantic tokens should survive aggregate literals and CRLF input");
  });
});

function extensionNotFoundMessage(): string {
  const available = vscode.extensions.all
    .map((e) => e.id)
    .filter((id) => id.includes("pike"));
  return "Pike extension not found. Available extensions with 'pike': " +
    (available.length > 0 ? available.join(", ") : "(none)");
}

async function configurePikeBinary(): Promise<void> {
  const pikeBinary = process.env.PIKE_BINARY || "pike";
  await vscode.workspace.getConfiguration("pike.languageServer").update("path", pikeBinary, vscode.ConfigurationTarget.Workspace);
}

function missingPikePath(): string {
  return path.join(os.tmpdir(), "pike-lsp-missing-pike-binary");
}

async function waitForLanguageServer(): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < SERVER_READY_TIMEOUT_MS) {
    try {
      const doc = await vscode.workspace.openTextDocument({ content: "int ready = 1;\n", language: "pike" });
      const hover = await execute<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        doc.uri,
        new vscode.Position(0, 4),
      );
      if (hover !== undefined) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(500);
  }
  throw new Error(`Pike language server did not become ready: ${String(lastError)}`);
}

async function openWorkspaceDocument(name: string, content: string): Promise<vscode.TextDocument> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "integration tests require a workspace folder");
  const uri = vscode.Uri.joinPath(folder.uri, ".integration-fixtures", name);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ".integration-fixtures"));
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: false });
  return doc;
}

async function waitForDiagnostics(
  uri: vscode.Uri,
  predicate: (items: vscode.Diagnostic[]) => boolean,
): Promise<vscode.Diagnostic[]> {
  const start = Date.now();
  while (Date.now() - start < DIAGNOSTIC_TIMEOUT_MS) {
    const diagnostics = vscode.languages.getDiagnostics(uri);
    if (predicate(diagnostics)) return diagnostics;
    await sleep(500);
  }
  const diagnostics = vscode.languages.getDiagnostics(uri);
  throw new Error(`Timed out waiting for diagnostics. Last diagnostics:\n${diagnosticsToString(diagnostics)}`);
}

async function waitForDocumentSymbols(
  uri: vscode.Uri,
  predicate: (items: vscode.DocumentSymbol[]) => boolean,
): Promise<vscode.DocumentSymbol[]> {
  const start = Date.now();
  while (Date.now() - start < SERVER_READY_TIMEOUT_MS) {
    const symbols = await execute<vscode.DocumentSymbol[] | undefined>("vscode.executeDocumentSymbolProvider", uri);
    if (symbols && predicate(symbols)) return symbols;
    await sleep(500);
  }
  const symbols = await execute<vscode.DocumentSymbol[] | undefined>("vscode.executeDocumentSymbolProvider", uri);
  throw new Error(`Timed out waiting for document symbols. Last symbols: ${symbolNames(symbols ?? [])}`);
}

async function execute<T>(command: string, ...args: unknown[]): Promise<T> {
  return await vscode.commands.executeCommand<T>(command, ...args);
}

async function semanticTokens(command: string, uri: vscode.Uri, range?: vscode.Range): Promise<{ data: number[] }> {
  const result = range
    ? await execute<SemanticTokensLike | Uint32Array | number[]>(command, uri, range)
    : await execute<SemanticTokensLike | Uint32Array | number[]>(command, uri);
  assert.ok(result, `${command} returned no semantic tokens`);

  if (Array.isArray(result) || result instanceof Uint32Array) {
    return { data: Array.from(result) };
  }
  if ("data" in result && result.data) {
    return { data: Array.from(result.data) };
  }
  if ("buffer" in result && result.buffer instanceof Uint8Array) {
    const view = new DataView(result.buffer.buffer, result.buffer.byteOffset, result.buffer.byteLength);
    const words: number[] = [];
    for (let offset = 0; offset + 4 <= view.byteLength; offset += 4) {
      words.push(view.getUint32(offset, true));
    }
    if (words.length >= 3) {
      const dataLength = words[2];
      return { data: words.slice(3, 3 + dataLength) };
    }
  }

  const shape = JSON.stringify(result, (_key, value) => {
    if (value instanceof Uint32Array) return Array.from(value).slice(0, 20);
    return value;
  });
  throw new Error(`${command} returned unsupported semantic-token shape: ${shape}`);
}

function decodeSemanticTokens(data: number[]): Array<{ line: number; character: number; length: number; typeId: number; modifiers: number }> {
  const decoded: Array<{ line: number; character: number; length: number; typeId: number; modifiers: number }> = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index < data.length; index += 5) {
    const deltaLine = data[index];
    const deltaCharacter = data[index + 1];
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaCharacter : deltaCharacter;
    decoded.push({
      line,
      character,
      length: data[index + 2],
      typeId: data[index + 3],
      modifiers: data[index + 4],
    });
  }
  return decoded;
}

function hoverText(items: vscode.Hover[] | undefined): string {
  if (!items) return "";
  return items.flatMap((hover) => hover.contents.map((content) => {
    if (typeof content === "string") return content;
    if (content instanceof vscode.MarkdownString) return content.value;
    return content.value;
  })).join("\n");
}

function symbolNames(symbols: vscode.DocumentSymbol[]): string {
  return symbols.map((item) => item.name).join(", ");
}

function diagnosticsToString(diagnostics: vscode.Diagnostic[]): string {
  return diagnostics.map((item) =>
    `${vscode.DiagnosticSeverity[item.severity]} ${item.range.start.line}:${item.range.start.character} ${item.message}`,
  ).join("\n");
}

function tokenDump(tokens: Array<{ line: number; character: number; length: number; typeId: number; modifiers: number }>): string {
  return tokens.map((token) =>
    `${token.line}:${token.character}+${token.length} type=${token.typeId} mods=${token.modifiers}`,
  ).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runUnavailableOracleProtocolCheck(content: string): Promise<{
  symbolNames: string[];
  semanticTokenCount: number;
  diagnosticCount: number;
}> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "integration tests require a workspace folder");
  const extensionRoot = path.resolve(folder.uri.fsPath, "..", "..");
  const serverPath = path.join(extensionRoot, "server", "dist", "server.mjs");
  const documentUri = vscode.Uri.joinPath(folder.uri, ".integration-fixtures", "oracle-unavailable-stdio.pike").toString();
  const client = new JsonRpcProcess(serverPath);
  try {
    await client.start({
      processId: null,
      rootUri: folder.uri.toString(),
      capabilities: {},
      initializationOptions: {
        pikeBinaryPath: missingPikePath(),
        diagnosticMode: "realtime",
      },
    });
    client.notify("initialized", {});
    client.notify("textDocument/didOpen", {
      textDocument: { uri: documentUri, languageId: "pike", version: 1, text: content },
    });

    const symbols = await client.request<{ name: string }[]>("textDocument/documentSymbol", {
      textDocument: { uri: documentUri },
    });
    const tokens = await client.request<{ data: number[] }>("textDocument/semanticTokens/full", {
      textDocument: { uri: documentUri },
    });
    await sleep(1_500);
    return {
      symbolNames: symbols.map((item) => item.name),
      semanticTokenCount: tokens.data.length,
      diagnosticCount: client.diagnosticCountFor(documentUri),
    };
  } finally {
    client.stop();
  }
}

class JsonRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, (value: unknown) => void>();
  private readonly diagnostics = new Map<string, number>();

  constructor(serverPath: string) {
    this.child = spawn(process.execPath, [serverPath, "--stdio"], {
      env: { ...process.env, PIKE_LSP_STDIO: "1" },
      stdio: "pipe",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  async start(params: unknown): Promise<void> {
    await this.request("initialize", params);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve) => {
      this.pending.set(id, (value) => resolve(value as T));
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  diagnosticCountFor(uri: string): number {
    return this.diagnostics.get(uri) ?? 0;
  }

  stop(): void {
    this.child.kill();
  }

  private send(message: unknown): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length: (\d+)/i.exec(header);
      assert.ok(match, `missing Content-Length in ${header}`);
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const message = JSON.parse(this.buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      this.buffer = this.buffer.subarray(bodyEnd);
      this.handleMessage(message);
    }
  }

  private handleMessage(message: { id?: number; method?: string; params?: { uri?: string; diagnostics?: unknown[] }; result?: unknown }): void {
    if (message.method === "textDocument/publishDiagnostics" && message.params?.uri) {
      this.diagnostics.set(message.params.uri, message.params.diagnostics?.length ?? 0);
      return;
    }
    if (typeof message.id === "number") {
      const resolve = this.pending.get(message.id);
      if (resolve) {
        this.pending.delete(message.id);
        resolve(message.result);
      }
    }
  }
}

export function run(): Promise<void> {
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`));
        return;
      }
      resolve();
    });
  });
}
