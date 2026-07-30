/**
 * Launcher for the extension-host memory probe.
 *
 * Same mechanism as run-tests.ts, but points VSCode at the probe entry instead
 * of the test suite. Separate because the probe opens Pike's stdlib and idles
 * for a minute to read the settled figure — not something the suite should do.
 *
 *   bun run memory:probe
 */
import * as path from "node:path";
import * as fs from "node:fs";

const EXTENSION_ROOT = path.resolve(__dirname, "..", "..", "..");

async function run(): Promise<void> {
  const serverMjs = path.join(EXTENSION_ROOT, "server", "dist", "server.mjs");
  const clientJs = path.join(EXTENSION_ROOT, "client", "dist", "extension.cjs");
  if (!fs.existsSync(serverMjs) || !fs.existsSync(clientJs)) {
    console.error("Extension not built. Run: bun run build:extension");
    process.exit(1);
  }

  const { runTests } = await import("@vscode/test-electron");
  await runTests({
    extensionDevelopmentPath: EXTENSION_ROOT,
    extensionTestsPath: path.resolve(__dirname, "suite", "memory-probe-entry.js"),
    launchArgs: ["--disable-extensions", path.join(EXTENSION_ROOT, "corpus", "files")],
  });
}

run().catch((err) => {
  console.error("memory probe failed:", err);
  process.exit(1);
});
