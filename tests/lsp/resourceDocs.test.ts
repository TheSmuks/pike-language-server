/**
 * T097: Smoke checks for the lingering-session troubleshooting guide.
 *
 * Verifies that docs/lingering-remote-sessions.md exists and contains
 * the key sections users need to diagnose resource-resilience issues.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DOC_PATH = resolve(import.meta.dirname, "../../docs/lingering-remote-sessions.md");

function readDoc(): string {
  if (!existsSync(DOC_PATH)) {
    throw new Error(`Documentation file not found: ${DOC_PATH}`);
  }
  return readFileSync(DOC_PATH, "utf-8");
}

describe("US5: Lingering session troubleshooting guide (Phase 7, T097)", () => {
  test("document exists at docs/lingering-remote-sessions.md", () => {
    expect(() => readDoc()).not.toThrow();
  });

  test("contains hibernation section", () => {
    const content = readDoc();
    expect(content.toLowerCase()).toContain("hibernation");
  });

  test("contains degraded mode section", () => {
    const content = readDoc();
    expect(content.toLowerCase()).toContain("degraded");
  });

  test("contains resource-state notification explanation", () => {
    const content = readDoc();
    expect(content.toLowerCase()).toContain("resource-state");
  });

  test("contains troubleshooting steps for high memory", () => {
    const content = readDoc();
    expect(content.toLowerCase()).toContain("memory");
    expect(content.toLowerCase()).toContain("troubleshoot");
  });

  test("contains log/output channel guidance", () => {
    const content = readDoc();
    expect(content.toLowerCase()).toContain("output channel");
  });

  test("contains configuration guidance for resource settings", () => {
    const content = readDoc();
    expect(content.toLowerCase()).toContain("indexing");
    expect(content.toLowerCase()).toContain("hibernation");
  });
});
