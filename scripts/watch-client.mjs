/**
 * Incremental rebuild of the VSCode extension client bundle.
 *
 * Mirrors scripts/build-client.sh exactly, including the import_meta polyfill,
 * but runs esbuild in watch mode so edits under client/ rebuild in ~100ms.
 *
 * Why a wrapper instead of `esbuild --watch`: build-client.sh post-processes the
 * bundle (the import_meta → pathToFileURL polyfill that keeps web-tree-sitter's
 * WASM resolution working under CJS). A bare `esbuild --watch` would skip that
 * step and emit a subtly broken bundle, which is exactly the kind of silent
 * failure that makes the extension "look unusable" with no obvious cause.
 */
import esbuild from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "client", "dist", "extension.cjs");

// esbuild converts import.meta to `var import_meta = {}` for CJS, which breaks
// web-tree-sitter's WASM resolution (import_meta.url becomes undefined). Patch
// it back to a real file URL — identical to the sed step in build-client.sh.
const importMetaPolyfill = {
  name: "import-meta-polyfill",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) {
        console.error(`[watch:client] build failed with ${result.errors.length} error(s)`);
        return;
      }
      const code = readFileSync(outfile, "utf8").replace(
        "var import_meta = {}",
        'var import_meta = { url: require("url").pathToFileURL(__filename).href }',
      );
      writeFileSync(outfile, code);
      console.log("[watch:client] build finished");
    });
  },
};

const context = await esbuild.context({
  entryPoints: [path.join(root, "client", "extension.ts")],
  bundle: true,
  outfile,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  external: ["vscode"],
  logLevel: "warning",
  plugins: [importMetaPolyfill],
});

await context.watch();
console.log("[watch:client] watching client/ for changes...");
