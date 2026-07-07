#!/usr/bin/env bun
/**
 * Keep the dev-layout manifest in sync with the shipped extension manifest.
 *
 * There are two package manifests, and they used to drift by hand:
 *   - extension.package.json — the SINGLE SOURCE OF TRUTH for `contributes`
 *     (grammars, languages, semantic-token scopes, commands, keybindings, and
 *     the full configuration schema). This is what the VSIX ships.
 *   - package.json — the bun project manifest, which VSCode also reads as the
 *     extension manifest when you F5-debug from source (dev layout).
 *
 * The two `contributes` blocks are identical except that the dev layout keeps
 * the grammar and language-configuration files under client/, while the VSIX
 * copies them to the package root. This module copies `contributes` from the
 * extension manifest into package.json, rewriting those two paths to the dev
 * layout, so the F5 experience always matches what ships.
 *
 * Run modes (CLI):
 *   bun run scripts/sync-manifest.ts          # write package.json in place
 *   bun run scripts/sync-manifest.ts --check  # exit non-zero if out of sync
 *
 * Edit `contributes` ONLY in extension.package.json; package.json is generated.
 * The `manifest stays in sync` test enforces this in CI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXTENSION_MANIFEST_PATH = resolve(repoRoot, "extension.package.json");
export const DEV_MANIFEST_PATH = resolve(repoRoot, "package.json");

/** Rewrite VSIX-layout resource paths to the dev (client/) layout. */
function toDevLayout(contributes: any): any {
  const clone = JSON.parse(JSON.stringify(contributes));
  for (const lang of clone.languages ?? []) {
    if (lang.configuration === "./language-configuration.json") {
      lang.configuration = "./client/language-configuration.json";
    }
  }
  for (const grammar of clone.grammars ?? []) {
    if (grammar.path === "./syntaxes/pike.tmLanguage.json") {
      grammar.path = "./client/syntaxes/pike.tmLanguage.json";
    }
  }
  return clone;
}

/** Compute the dev package.json text with `contributes` sourced from the VSIX manifest. */
export function computeSyncedDevManifest(): { current: string; next: string } {
  const ext = JSON.parse(readFileSync(EXTENSION_MANIFEST_PATH, "utf8"));
  const current = readFileSync(DEV_MANIFEST_PATH, "utf8");
  const devManifest = JSON.parse(current);
  devManifest.contributes = toDevLayout(ext.contributes);
  const next = JSON.stringify(devManifest, null, 2) + "\n";
  return { current, next };
}

/** True when package.json's `contributes` already matches the VSIX manifest. */
export function isManifestInSync(): boolean {
  const { current, next } = computeSyncedDevManifest();
  return current === next;
}

function main(): void {
  const check = process.argv.includes("--check");
  const { current, next } = computeSyncedDevManifest();
  if (current === next) {
    console.log("manifest: package.json contributes is in sync with extension.package.json");
    return;
  }
  if (check) {
    console.error("manifest: package.json is OUT OF SYNC with extension.package.json.");
    console.error("  Fix: bun run scripts/sync-manifest.ts   (edit contributes in extension.package.json, not package.json)");
    process.exit(1);
  }
  writeFileSync(DEV_MANIFEST_PATH, next);
  console.log("manifest: synced package.json contributes from extension.package.json");
}

if (import.meta.main) main();
