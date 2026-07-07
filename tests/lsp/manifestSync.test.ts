/**
 * Guards against the two-manifest drift that broke config and grammar wiring.
 *
 * `contributes` is authored once in extension.package.json (the VSIX manifest)
 * and mirrored into package.json (the dev/F5 manifest) by scripts/sync-manifest.ts,
 * with the grammar and language-configuration paths rewritten to the client/
 * dev layout. If someone edits one manifest without the other, this test fails
 * and points them at the sync command.
 */
import { describe, test, expect } from "bun:test";
import { computeSyncedDevManifest, isManifestInSync } from "../../scripts/sync-manifest";

describe("extension manifest sync", () => {
  test("package.json contributes stays in sync with extension.package.json", () => {
    if (!isManifestInSync()) {
      // Surface a precise, actionable failure rather than a bare boolean.
      throw new Error(
        "package.json is out of sync with extension.package.json. " +
          "Edit contributes in extension.package.json, then run: bun run scripts/sync-manifest.ts",
      );
    }
    expect(isManifestInSync()).toBe(true);
  });

  test("dev manifest keeps client/ layout paths, not VSIX paths", () => {
    const { next } = computeSyncedDevManifest();
    const dev = JSON.parse(next);
    expect(dev.contributes.grammars[0].path).toBe("./client/syntaxes/pike.tmLanguage.json");
    expect(dev.contributes.languages[0].configuration).toBe("./client/language-configuration.json");
  });
});
