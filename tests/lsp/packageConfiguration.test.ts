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

  test("enables semantic highlighting for Pike in both manifests", () => {
    const root = process.cwd();
    const manifests = [
      readJson(join(root, "package.json")),
      readJson(join(root, "extension.package.json")),
    ];

    for (const manifest of manifests) {
      const defaults = manifest.contributes.configurationDefaults["[pike]"];
      expect(defaults["editor.semanticHighlighting.enabled"]).toBe(true);
    }
  });

  test("declares Pike line-move commands for both keybinding manifests", () => {
    const root = process.cwd();
    const manifests = [
      readJson(join(root, "package.json")),
      readJson(join(root, "extension.package.json")),
    ];

    for (const manifest of manifests) {
      const commands = manifest.contributes.commands ?? [];
      const keybindings = manifest.contributes.keybindings ?? [];
      const commandIds = commands.map((entry: any) => entry.command);

      expect(commandIds).toContain("pike.moveLinesUp");
      expect(commandIds).toContain("pike.moveLinesDown");
      expect(keybindings).toContainEqual(expect.objectContaining({
        key: "alt+up",
        command: "pike.moveLinesUp",
        when: "editorTextFocus && editorLangId == pike",
      }));
      expect(keybindings).toContainEqual(expect.objectContaining({
        key: "alt+down",
        command: "pike.moveLinesDown",
        when: "editorTextFocus && editorLangId == pike",
      }));
    }
  });

  test("maps every emitted semantic token type to TextMate fallback scopes", () => {
    const root = process.cwd();
    const manifests = [
      readJson(join(root, "package.json")),
      readJson(join(root, "extension.package.json")),
    ];
    const emittedTokenTypes = [
      "class",
      "enum",
      "enumMember",
      "function",
      "method",
      "variable",
      "parameter",
      "type",
      "namespace",
      "builtinFunction",
    ];

    for (const manifest of manifests) {
      const entries = manifest.contributes.semanticTokenScopes;
      const pikeEntry = entries.find((entry: any) => entry.language === "pike");
      expect(pikeEntry).toBeDefined();
      for (const tokenType of emittedTokenTypes) {
        expect(pikeEntry.scopes[tokenType]).toBeArray();
        expect(pikeEntry.scopes[tokenType].length).toBeGreaterThan(0);
      }
      expect(pikeEntry.scopes.method).toContain("variable.other.property");
      expect(pikeEntry.scopes.variable).toContain("variable");
      expect(pikeEntry.scopes.parameter).toContain("variable.parameter");
    }
  });
});
