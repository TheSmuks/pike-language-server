/**
 * Entry point for the single-file compiled binary (`bun build --compile`).
 *
 * A compiled binary has no files beside it, so the on-disk `.wasm` lookups in
 * `parser.ts` fail. Both blobs are embedded into the executable here (Bun turns
 * a `with { type: "file" }` import into a path inside the binary), read out,
 * and registered before the server is loaded.
 *
 * The dynamic `import("./main.js")` is deliberate and load-bearing: main.ts
 * starts listening at module scope, so a static import would hoist above the
 * asset registration and the parser would initialize with nothing embedded.
 *
 * The JSON indexes need no handling — they are `import`ed as modules and Bun
 * bundles them into the binary automatically.
 */

import grammarWasmPath from "../tree-sitter-pike.wasm" with { type: "file" };
import runtimeWasmPath from "../../node_modules/web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import { setEmbeddedAssets } from "./embeddedAssets.js";

const grammarWasm = new Uint8Array(await Bun.file(grammarWasmPath).arrayBuffer());
const runtimeWasm = await Bun.file(runtimeWasmPath).arrayBuffer();

setEmbeddedAssets({ grammarWasm, runtimeWasm });

await import("./main.js");
