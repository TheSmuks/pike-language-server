/**
 * Server release version, stamped at build time.
 *
 * build-server.sh, build-standalone.sh, and build-binary.sh each inject
 * __PIKE_LSP_VERSION__ via an esbuild/bun `--define` sourced from
 * .template-version — the canonical release version. Root package.json's
 * `version` is deliberately stale and must never be read for this.
 *
 * Outside a build (bun test, `bun server/src/main.ts` in dev) the define is
 * absent; `typeof` on an undeclared identifier is safe in JS and falls back
 * to "dev" rather than throwing.
 */
declare const __PIKE_LSP_VERSION__: string | undefined;

export const SERVER_VERSION: string =
  typeof __PIKE_LSP_VERSION__ === "string" ? __PIKE_LSP_VERSION__ : "dev";
