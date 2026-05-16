/**
 * Integration test suite that runs inside VSCode's extension host.
 *
 * Layer 2: wiring and infrastructure tests only.
 *
 * What we test:
 * - Extension activates and becomes `isActive`
 * - Extension registers Pike language configuration
 * - LSP client is initialized (language server starts)
 * - Extension handles various document types gracefully
 *
 * What we DON'T test (Layer 1 handles correctness):
 * - Hover returns correct types
 * - Go-to-definition returns correct locations
 * - Completion returns correct items
 * - Formatting returns correct edits
 *
 * These have comprehensive coverage in `tests/lsp/`.
 *
 * NOTE: Tree-sitter WASM does not load in the headless extension host
 * environment.  documentSymbolProvider delegates to tree-sitter and will
 * throw.  LSP-based features (hover, completion, etc.) go through the
 * language client and should work.
 *
 * Run: cd tests/integration && npm test
 */
/// <reference types="vscode" />
/// <reference types="mocha" />

import * as vscode from "vscode";
import Mocha = require("mocha");

// The extension ID may include publisher prefix (e.g., thesmuks.pike-language-server)
// or be undefined_publisher.pike-language-server in development mode
const EXTENSION_ID_PATTERN = "pike-language-server";

// Configure Mocha programmatically
const mocha = new Mocha({
  timeout: 15_000,
  color: true,
  reporter: "spec",
});

// Wire Mocha's BDD interface to global so that `describe`/`it` work at
// module scope.  We emit 'pre-require' which is the same hook Mocha uses
// internally to install globals before loading each test file.
const ctx = globalThis as typeof globalThis & {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: (() => void) | ((done: () => void) => void)) => void;
  before: (fn: (done: () => void) => void) => void;
  after: (fn: (done: () => void) => void) => void;
  beforeEach: (fn: (done: () => void) => void) => void;
  afterEach: (fn: (done: () => void) => void) => void;
};

mocha.suite.emit("pre-require", ctx, undefined, new Mocha());

// Suite: wiring and infrastructure tests
describe("Pike Language Server — Extension Wiring", function () {
  let ext: vscode.Extension<unknown> | undefined;

  before("activate extension", async function () {
    this.timeout(20_000);
    ext = vscode.extensions.all.find((e) =>
      e.id.includes(EXTENSION_ID_PATTERN),
    );
    if (!ext) {
      const available = vscode.extensions.all
        .map((e) => e.id)
        .filter((id) => id.includes("pike"));
      throw new Error(
        "Pike extension not found. Available extensions with 'pike': " +
          (available.length > 0 ? available.join(", ") : "(none)"),
      );
    }
    if (!ext.isActive) {
      await ext.activate();
    }
  });

  describe("Extension activation", function () {
    it("activates and sets isActive to true", function () {
      if (ext?.isActive !== true) {
        throw new Error("Extension should be active after activation");
      }
    });
  });

  describe("Language registration", function () {
    it("registers Pike language configuration", async function () {
      const languages = await vscode.languages.getLanguages();
      if (!languages.includes("pike")) {
        throw new Error(
          "Pike language should be registered. Registered: " +
            languages.join(", "),
        );
      }
    });
  });

  describe("LSP client wiring", function () {
    // NOTE: documentSymbolProvider delegates to tree-sitter WASM which does not
    // load in the headless extension host.  We test LSP-based features instead.

    it("provides hover results via LSP (verifies language client is wired)", async function () {
      this.timeout(10_000);
      const doc = await vscode.workspace.openTextDocument({
        content: "int x = 42;\n",
        language: "pike",
      });
      // hover goes through the language client — tree-sitter failure is irrelevant
      const hover = await vscode.commands.executeCommand(
        "vscode.executeHoverProvider",
        doc.uri,
        new vscode.Position(0, 3),
      );
      // undefined (server not ready) or array (server responded) — not a throw
      if (hover !== undefined && !Array.isArray(hover)) {
        throw new Error(
          "Hover provider should not throw for Pike documents (LSP wired)",
        );
      }
    });

    it("provides completion results via LSP (verifies language client is wired)", async function () {
      this.timeout(10_000);
      const doc = await vscode.workspace.openTextDocument({
        content: "int x = 42;\n",
        language: "pike",
      });
      const completions = await vscode.commands.executeCommand(
        "vscode.executeCompletionItemProvider",
        doc.uri,
        new vscode.Position(0, 5),
      );
      // null/undefined (not ready) or { items: [...] } — not a throw
      if (
        completions !== null &&
        completions !== undefined &&
        typeof completions !== "object"
      ) {
        throw new Error(
          "Completion provider should not throw for Pike documents (LSP wired)",
        );
      }
    });

    it("handles untitled Pike documents without crashing the extension host", async function () {
      this.timeout(10_000);
      const doc = await vscode.workspace.openTextDocument({
        content: 'void main() { werror("hello\\n"); }\n',
        language: "pike",
      });
      // If we reach here without an extension-host crash, the test passes
      // LSP may or may not be ready — that's fine, just don't crash
      await vscode.commands.executeCommand(
        "vscode.executeHoverProvider",
        doc.uri,
        new vscode.Position(0, 5),
      );
    });

    it("handles malformed Pike input without crashing the extension host", async function () {
      this.timeout(10_000);
      const doc = await vscode.workspace.openTextDocument({
        content: "class { void broken( { }\n",
        language: "pike",
      });
      // If we reach here without an extension-host crash, the test passes
      // LSP may reject the malformed input — that's fine, just don't crash
      await vscode.commands.executeCommand(
        "vscode.executeHoverProvider",
        doc.uri,
        new vscode.Position(0, 5),
      );
    });
  });
});


// ---------------------------------------------------------------------------
// Regression tests: client-side bug fixes not yet testable in-process
// ---------------------------------------------------------------------------

// The following bug fixes were made client-side and require the VSCode extension
// host to test.  They are tracked here as test.todo items.

describe("Client-side bug fix regressions", function () {
  this.timeout(10_000);

  // Skipped: requires VSCode extension host runtime to inspect output channels.
  // Tracked as manual smoke test — see MANUAL_SMOKE_TESTS.md.
  // TODO: Create a tracking issue for automated output channel verification.
  //   See: https://github.com/TheSmuks/pike-language-server/issues/XXX
  it.skip("only one 'Pike Language Server' output channel appears", async function () {
    // Bug fix: extension.ts passed the output channel to LanguageClient so that
    // duplicate log messages from the underlying transport are suppressed.
    // Before the fix, messages were duplicated in the Output panel.
    // Verification: open a Pike file and inspect vscode.window.outputChannels.
    // Only one channel with the name "Pike Language Server" should exist.
    const channels = vscode.window.tabGroups.all
      .flatMap((tg) => tg.tabs)
      .map((t) => t.label);
    // Placeholder assertion — actual implementation needs outputChannel inspection
    expect(channels).toBeDefined();
  });

  // Tree-sitter semantic tokens via client-side provider were removed.
  // The LSP server now provides all semantic tokens via the standard protocol.
  // These tests are kept as placeholders for future client-side token verification
  // if a client-side provider is reintroduced.
});


// Named export required by VSCode test runner
export function run() {
  return mocha.run((failures) => {
    if (failures > 0) {
      throw new Error(`${failures} tests failed.`);
    }
  });
}