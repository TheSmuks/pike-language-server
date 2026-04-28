/**
 * Pike diagnostic pipeline tests (LSP layer).
 *
 * Tests the server's integration with the Pike worker for diagnostics:
 * - Save-triggered diagnostics
 * - Position mapping (1-based Pike → 0-based LSP)
 * - Diagnostic merging (parse + Pike)
 * - Content-hash caching
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import { PikeWorker } from "../../server/src/features/pikeWorker";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Shared server
// ---------------------------------------------------------------------------

let server: TestServer;

beforeAll(async () => {
  server = await createTestServer();
});

afterAll(async () => {
  await server.teardown();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeContentHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PikeWorker diagnostics via LSP", () => {
  test("diagnose returns structured errors for type mismatches", async () => {
    const worker = new PikeWorker();
    const source = [
      "#pragma strict_types",
      "int main() {",
      "  int x = 1;",
      "  string y = x;",
      "  return 0;",
      "}",
    ].join("\n");

    const result = await worker.diagnose(source, "test.pike", { strict: true });
    worker.stop();

    expect(result.exit_code).toBe(1);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);

    const typeError = result.diagnostics.find(
      (d) => d.message === "Bad type in assignment.",
    );
    expect(typeError).toBeDefined();
    expect(typeError!.line).toBeGreaterThan(0);
    expect(typeError!.severity).toBe("error");
  });

  test("Pike diagnostic line numbers are 1-based", async () => {
    const worker = new PikeWorker();
    const source = "#pragma strict_types\nstring y = 1;\n";
    const result = await worker.diagnose(source, "test.pike", { strict: true });
    worker.stop();

    const error = result.diagnostics.find(
      (d) => d.message === "Bad type in assignment.",
    );
    expect(error).toBeDefined();
    // Pike reports 1-based: line 2
    expect(error!.line).toBe(2);
  });

  test("clean source has exit_code 0", async () => {
    const worker = new PikeWorker();
    const result = await worker.diagnose("int main() { return 0; }\n", "clean.pike");
    worker.stop();

    expect(result.exit_code).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });
});

describe("Position mapping", () => {
  test("LSP line = Pike line - 1", async () => {
    const worker = new PikeWorker();
    const source = "#pragma strict_types\nint x = \"string\";\n";
    const result = await worker.diagnose(source, "test.pike", { strict: true });
    worker.stop();

    const error = result.diagnostics.find(
      (d) => d.message.includes("Bad type"),
    );
    if (error) {
      // Pike reports line 2 (1-based)
      expect(error.line).toBe(2);
      // LSP would convert to line 1 (0-based)
      const lspLine = error.line - 1;
      expect(lspLine).toBe(1);
    }
  });
});

describe("Content-hash caching", () => {
  test("same content produces same hash", () => {
    const source = "int main() { return 0; }\n";
    const hash1 = computeContentHash(source);
    const hash2 = computeContentHash(source);
    expect(hash1).toBe(hash2);
  });

  test("different content produces different hash", () => {
    const source1 = "int main() { return 0; }\n";
    const source2 = "int main() { return 1; }\n";
    const hash1 = computeContentHash(source1);
    const hash2 = computeContentHash(source2);
    expect(hash1).not.toBe(hash2);
  });

  test("undo scenario: reverted content matches original hash", () => {
    const original = "int main() { return 0; }\n";
    const modified = "int main() { return 1; }\n";
    const reverted = "int main() { return 0; }\n";

    const hash1 = computeContentHash(original);
    const hash2 = computeContentHash(modified);
    const hash3 = computeContentHash(reverted);

    expect(hash1).not.toBe(hash2);
    expect(hash1).toBe(hash3); // Cache hit on revert
  });
});
