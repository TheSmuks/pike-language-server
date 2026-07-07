/**
 * Incremental rebuild of the LSP server bundle.
 *
 * Mirrors scripts/build-server.sh exactly, including the createRequire banner
 * and the runtime WASM copies, but runs esbuild in watch mode so edits under
 * server/ rebuild in ~1s instead of a full VSIX round-trip.
 *
 * Why a wrapper instead of `esbuild --watch`: the server resolves its WASM
 * assets relative to server/dist/server.mjs at runtime, and esbuild does not
 * copy those unless they are imported directly. build-server.sh installs them
 * explicitly; we replicate that on every rebuild so the watched output is
 * runnable, not just compiled.
 */
import esbuild from "esbuild";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "server", "dist");

// Copy the runtime WASM assets next to the bundle after each successful build.
// The grammar WASM ships in the repo; the web-tree-sitter runtime WASM lives in
// node_modules. Both must sit beside server.mjs for the server to start.
const copyWasmAssets = {
  name: "copy-wasm-assets",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        console.error(`[watch:server] build failed with ${result.errors.length} error(s)`);
        return;
      }
      copyFileSync(
        path.join(root, "server", "tree-sitter-pike.wasm"),
        path.join(distDir, "tree-sitter-pike.wasm"),
      );
      copyFileSync(
        path.join(root, "node_modules", "web-tree-sitter", "web-tree-sitter.wasm"),
        path.join(distDir, "web-tree-sitter.wasm"),
      );
      console.log("[watch:server] build finished");
    });
  },
};

const context = await esbuild.context({
  entryPoints: [path.join(root, "server", "src", "main.ts")],
  bundle: true,
  outfile: path.join(distDir, "server.mjs"),
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  loader: { ".wasm": "file" },
  banner: {
    js: "import{createRequire}from'module';const require=createRequire(import.meta.url)",
  },
  logLevel: "warning",
  plugins: [copyWasmAssets],
});

await context.watch();
console.log("[watch:server] watching server/ for changes...");
