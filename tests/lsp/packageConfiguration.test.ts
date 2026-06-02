import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("VSCode configuration contributions", () => {
  test("contributes a path redaction setting in both development and packaged manifests", () => {
    const root = process.cwd();
    const manifests = [
      readJson(join(root, "package.json")),
      readJson(join(root, "extension.package.json")),
    ];

    for (const manifest of manifests) {
      const property = manifest.contributes.configuration.properties[
        "pike.languageServer.log.redactPaths"
      ];
      expect(property).toEqual({
        type: "boolean",
        default: true,
        description: expect.stringContaining("Redact"),
        scope: "window",
      });
    }
  });
});
