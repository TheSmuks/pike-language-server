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

const EXTENSION_ROOT = path.resolve(import.meta.dir, "..", "..");

async function run() {
  // Verify extension is built
  const serverJs = path.join(EXTENSION_ROOT, "server", "dist", "server.js");
  const clientJs = path.join(EXTENSION_ROOT, "client", "dist", "extension.js");

  if (!fs.existsSync(serverJs)) {
    console.error("Server not built. Run: bun run build:extension");
    process.exit(1);
  }
  if (!fs.existsSync(clientJs)) {
    console.error("Client not built. Run: bun run build:extension");
    process.exit(1);
  }

  try {
    const { runTests } = await import("@vscode/test-electron");

    const testsPath = path.join(import.meta.dir, "suite");

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
