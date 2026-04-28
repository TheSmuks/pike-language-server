/**
 * Integration test suite that runs inside VSCode's extension host.
 *
 * This file is loaded by @vscode/test-electron's runTests() mechanism.
 * It has access to the vscode API and the activated extension.
 */
import * as assert from "node:assert";
import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";

const EXTENSION_ID = "pike-language-server";

async function testActivation() {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) {
    // Try alternate ID patterns
    const all = vscode.extensions.all.filter(e => e.id.includes("pike"));
    if (all.length > 0) {
      console.log("Found pike extensions:", all.map(e => e.id));
    }
  }
  assert.ok(ext, "Extension should be installed");

  if (!ext.isActive) {
    await ext.activate();
  }
  assert.strictEqual(ext.isActive, true, "Extension should be active");
  console.log("PASS: Extension activates");
}

async function testDocumentSymbol() {
  const corpusDir = path.resolve(
    import.meta.dir, "..", "..", "..", "corpus", "files",
  );
  const testFile = path.join(corpusDir, "basic-types.pike");

  if (!fs.existsSync(testFile)) {
    console.log("SKIP: documentSymbol (corpus not available)");
    return;
  }

  const doc = await vscode.workspace.openTextDocument(testFile);
  const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
    "vscode.executeDocumentSymbolProvider",
    doc.uri,
  );

  assert.ok(symbols, "Should return symbols");
  assert.ok(symbols.length > 0, "Should have at least one symbol");
  console.log(`PASS: documentSymbol returns ${symbols.length} symbols`);
}

async function testErrorRecovery() {
  const malformedContent = "class { void broken( { }\n";
  const doc = await vscode.workspace.openTextDocument({
    content: malformedContent,
    language: "pike",
  });

  try {
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      doc.uri,
    );
    assert.ok(Array.isArray(symbols), "Should return an array");
    console.log("PASS: Error recovery handles malformed input");
  } catch (e) {
    assert.fail(`Extension threw on malformed input: ${(e as Error).message}`);
  }
}

// Run all tests
async function runAll() {
  console.log("Running integration tests inside VSCode...\n");

  await testActivation();
  await testDocumentSymbol();
  await testErrorRecovery();

  console.log("\nAll integration tests passed.");
}

// Export for @vscode/test-electron runner
export = runAll;
