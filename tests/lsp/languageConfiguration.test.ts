import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Verifies that language-configuration.json exists, is valid JSON, and contains
 * all required keys for VS Code language configuration registration.
 */
describe("languageConfiguration", () => {
  const configPath = resolve(__dirname, "../../client/language-configuration.json");

  it("file exists", () => {
    expect(() => readFileSync(configPath, "utf8")).not.toThrow();
  });

  it("is valid JSON", () => {
    const content = readFileSync(configPath, "utf8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("has all required top-level keys", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const required = [
      "comments",
      "brackets",
      "autoClosingPairs",
      "surroundingPairs",
      "indentationRules",
      "folding",
      "onEnterRules",
    ];
    for (const key of required) {
      expect(config).toHaveProperty(key);
    }
  });

  it("comments block has both comment tokens", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.comments).toHaveProperty("lineComment");
    expect(config.comments).toHaveProperty("blockComment");
  });

  it("brackets is a non-empty array", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Array.isArray(config.brackets)).toBe(true);
    expect(config.brackets.length).toBeGreaterThan(0);
  });

  it("autoClosingPairs is a non-empty array", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Array.isArray(config.autoClosingPairs)).toBe(true);
    expect(config.autoClosingPairs.length).toBeGreaterThan(0);
  });

  it("surroundingPairs is a non-empty array", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Array.isArray(config.surroundingPairs)).toBe(true);
    expect(config.surroundingPairs.length).toBeGreaterThan(0);
  });

  it("onEnterRules is an array", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(Array.isArray(config.onEnterRules)).toBe(true);
  });

  it("folding is an object", () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    expect(config.folding).toBeObject();
  });
});
