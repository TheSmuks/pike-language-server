/**
 * `with { type: "file" }` imports of embedded assets.
 *
 * Bun embeds the file into a compiled binary and resolves the import to a path
 * inside it, readable with Bun.file(). TypeScript has no built-in knowledge of
 * these module types, so declare the shape here — used by compileEntry.ts.
 */
declare module "*.wasm" {
  const path: string;
  export default path;
}

/** Pike sources the compiled binary carries for the worker subprocess. */
declare module "*.pike" {
  const path: string;
  export default path;
}

/**
 * Pike MODULE sources (`.pmod`) the binary carries — the introspect module the
 * worker resolves stdlib symbols through.
 */
declare module "*.pmod" {
  const path: string;
  export default path;
}
