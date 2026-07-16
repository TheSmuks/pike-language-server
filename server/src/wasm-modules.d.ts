/**
 * `with { type: "file" }` imports of .wasm assets.
 *
 * Bun embeds the file into a compiled binary and resolves the import to a path
 * inside it, readable with Bun.file(). TypeScript has no built-in knowledge of
 * .wasm modules, so declare the shape here — used by compileEntry.ts.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}
