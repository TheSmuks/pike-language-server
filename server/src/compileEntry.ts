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
 * The Pike worker sources ride along for a different reason: the worker is a
 * separate `pike` process, so those cannot be handed over in memory and are
 * written to a temp directory on first spawn. Without them the binary resolved
 * the worker against a path baked in at build time — it worked on the build
 * machine and nowhere else.
 *
 * The JSON indexes need no handling — they are `import`ed as modules and Bun
 * bundles them into the binary automatically.
 */

import grammarWasmPath from "../tree-sitter-pike.wasm" with { type: "file" };
import runtimeWasmPath from "../../node_modules/web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import workerPikePath from "../pike/worker.pike" with { type: "file" };
import commonPikePath from "../pike/Common.pike" with { type: "file" };
// The introspect module answers every `resolve` request. It is pmp-installed
// under modules/ and shipped in no distribution at all, so the binary reported
// "Introspect module not available" for stdlib hover and member completion —
// invisibly on the build machine, where the checkout's copy was still on disk.
// Keys keep the `Introspect.pmod/` prefix so it materialises as a directory
// inside the runtime dir, which is always on the worker's -M path.
import introspectModulePath from "../../modules/pike_introspect/src/Introspect.pmod/module.pmod" with { type: "file" };
import introspectDiscoverPath from "../../modules/pike_introspect/src/Introspect.pmod/Discover.pmod" with { type: "file" };
import introspectDescribePath from "../../modules/pike_introspect/src/Introspect.pmod/Describe.pmod" with { type: "file" };
import introspectJsonPath from "../../modules/pike_introspect/src/Introspect.pmod/Json.pmod" with { type: "file" };
import introspectSearchPath from "../../modules/pike_introspect/src/Introspect.pmod/Search.pmod" with { type: "file" };
import { setEmbeddedAssets } from "./embeddedAssets.js";

const grammarWasm = new Uint8Array(await Bun.file(grammarWasmPath).arrayBuffer());
const runtimeWasm = await Bun.file(runtimeWasmPath).arrayBuffer();
const pikeRuntime = {
  "worker.pike": new Uint8Array(await Bun.file(workerPikePath).arrayBuffer()),
  "Common.pike": new Uint8Array(await Bun.file(commonPikePath).arrayBuffer()),
  "Introspect.pmod/module.pmod": new Uint8Array(await Bun.file(introspectModulePath).arrayBuffer()),
  "Introspect.pmod/Discover.pmod": new Uint8Array(await Bun.file(introspectDiscoverPath).arrayBuffer()),
  "Introspect.pmod/Describe.pmod": new Uint8Array(await Bun.file(introspectDescribePath).arrayBuffer()),
  "Introspect.pmod/Json.pmod": new Uint8Array(await Bun.file(introspectJsonPath).arrayBuffer()),
  "Introspect.pmod/Search.pmod": new Uint8Array(await Bun.file(introspectSearchPath).arrayBuffer()),
};

setEmbeddedAssets({ grammarWasm, runtimeWasm, pikeRuntime });

await import("./main.js");
