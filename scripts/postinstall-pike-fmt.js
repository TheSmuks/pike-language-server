/**
 * postinstall: Fix pike-fmt v0.1.5 packaging bug.
 *
 * pike-fmt v0.1.5 bundles its CLI with esbuild, which inlines the
 * web-tree-sitter runtime JS. However, web-tree-sitter.wasm (the tree-sitter
 * parser framework WASM) is NOT included in the npm tarball.
 *
 * The bundled dist/cli.js uses import.meta.url to locate web-tree-sitter.wasm
 * relative to itself (dist/), but the file lives in the sibling
 * node_modules/web-tree-sitter/ package.
 *
 * This script creates a symlink so the bundled CLI can find it.
 */
import { existsSync, symlinkSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(__dirname, "..");
const distWasm = join(pkgRoot, "node_modules/pike-fmt/dist/web-tree-sitter.wasm");
const actualWasm = join(pkgRoot, "node_modules/web-tree-sitter/web-tree-sitter.wasm");

// Only act if pike-fmt is installed and the symlink is missing
if (!existsSync(join(pkgRoot, "node_modules/pike-fmt/dist/cli.js"))) {
  process.exit(0); // pike-fmt not installed, nothing to do
}

if (existsSync(actualWasm) && !existsSync(distWasm)) {
  // Relative path from dist/ to web-tree-sitter/: ../../web-tree-sitter/web-tree-sitter.wasm
  const rel = "../../web-tree-sitter/web-tree-sitter.wasm";
  try {
    symlinkSync(rel, distWasm);
    console.log("[postinstall] Symlinked web-tree-sitter.wasm for pike-fmt v0.1.5");
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}
