/**
 * Embedded WASM assets for the single-file compiled binary.
 *
 * The server normally reads `tree-sitter-pike.wasm` from disk next to the
 * bundle, and web-tree-sitter reads its own runtime `.wasm` the same way. A
 * `bun build --compile` binary has no files beside it, so both loads fail with
 * an emscripten `Aborted(ENOENT)` and every parse-dependent feature dies.
 *
 * `compileEntry.ts` reads both WASM blobs out of the binary and registers them
 * here *before* importing the server, so `parser.ts` can hand the bytes
 * straight to web-tree-sitter and never touch the filesystem.
 *
 * Empty in every other build (extension, standalone), where the on-disk lookup
 * in `parser.ts` is used instead.
 */

export interface EmbeddedAssets {
  /** tree-sitter-pike grammar, passed to Language.load(). */
  grammarWasm?: Uint8Array;
  /** web-tree-sitter runtime, passed to Parser.init() as wasmBinary. */
  runtimeWasm?: ArrayBuffer;
}

let assets: EmbeddedAssets = {};

/** Register embedded assets. Must run before initParser(). */
export function setEmbeddedAssets(next: EmbeddedAssets): void {
  assets = next;
}

/** Assets embedded in this binary, or an empty object for on-disk builds. */
export function getEmbeddedAssets(): EmbeddedAssets {
  return assets;
}
