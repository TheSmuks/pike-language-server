/**
 * Integration test entry point.
 *
 * Runs via @vscode/test-electron: downloads VSCode, installs the extension,
 * and runs the test suite inside the extension host.
 *
 * Run: cd tests/integration && npm test
 */
import * as path from "node:path";
import * as fs from "node:fs";

// Extension root is three levels up from tests/integration/dist
const EXTENSION_ROOT = path.resolve(__dirname, "..", "..", "..");

// Clean stale VSCode lockfiles before running tests
// These can be left behind if a previous test run was interrupted
function cleanStaleLocks() {
  const vscodeTestDir = path.join(__dirname, "..", ".vscode-test");
  if (!fs.existsSync(vscodeTestDir)) return;

  function rmdir(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          rmdir(full);
        } else if (entry.name === "code.lock" || entry.name.endsWith(".lock")) {
          fs.unlinkSync(full);
        }
      }
    } catch {
      // Ignore errors during cleanup
    }
  }

  rmdir(vscodeTestDir);
}

async function run() {
  // Clean stale locks first
  cleanStaleLocks();

  // Verify extension is built
  const serverMjs = path.join(EXTENSION_ROOT, "server", "dist", "server.mjs");
  const clientJs = path.join(EXTENSION_ROOT, "client", "dist", "extension.cjs");

  if (!fs.existsSync(serverMjs)) {
    console.error("Server not built. Run: bun run build:extension");
    process.exit(1);
  }
  if (!fs.existsSync(clientJs)) {
    console.error("Client not built. Run: bun run build:extension");
    process.exit(1);
  }

  try {
    const { runTests } = await import("@vscode/test-electron");

    // Absolute path to the compiled CJS test suite
    const testsPath = path.resolve(__dirname, "suite", "index.js");

    await runTests({
      extensionDevelopmentPath: EXTENSION_ROOT,
      extensionTestsPath: testsPath,
      launchArgs: [
        "--disable-extensions",
        path.join(EXTENSION_ROOT, "corpus", "files"),
      ],
    });
    console.log("All integration tests passed.");
  } catch (err) {
    console.error("Integration test failure:", err);
    process.exit(1);
  }
}

run();