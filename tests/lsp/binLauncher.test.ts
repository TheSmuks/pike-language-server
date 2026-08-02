/**
 * bin/pike-language-server: --version and --help must exit 0 before any
 * server start.
 *
 * Before this test existed, an unrecognized flag like --version fell through
 * to the normal stdio-server startup path instead of being rejected or
 * handled — `pike-language-server --version` silently launched a full LSP
 * server that then sat waiting on stdin. Both flags must short-circuit
 * before bin/pike-language-server even checks for the standalone bundle, so
 * they work whether or not the project has been built.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = resolve(ROOT, "bin", "pike-language-server");
const TEMPLATE_VERSION = readFileSync(resolve(ROOT, ".template-version"), "utf8").trim();

function runBin(args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", timeout: 10000 });
}

describe("bin/pike-language-server: --version and --help", () => {
  test("--version prints the .template-version release and exits 0", () => {
    const result = runBin(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(TEMPLATE_VERSION);
  });

  test("--help prints usage and exits 0", () => {
    const result = runBin(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("pike-language-server");
  });

  test("--version/--help handling precedes the standalone-bundle existence check", () => {
    // Moving standalone/ aside to prove this at runtime would race other
    // build scripts that write there concurrently; a source-order check is
    // just as conclusive since main() never returns.
    const source = readFileSync(BIN, "utf8");
    const versionCheckIndex = source.indexOf('"--version"');
    const bundleCheckIndex = source.indexOf("existsSync(serverPath)");
    expect(versionCheckIndex).toBeGreaterThan(-1);
    expect(bundleCheckIndex).toBeGreaterThan(-1);
    expect(versionCheckIndex).toBeLessThan(bundleCheckIndex);
  });
});
