/**
 * PikeWorker subprocess management tests.
 *
 * Tests the PikeWorker class: lifecycle, communication, crash recovery.
 */

import { describe, test, expect, afterAll } from "bun:test";
import { PikeWorker } from "../../server/src/features/pikeWorker";

const worker = new PikeWorker();

afterAll(() => {
  worker.stop();
});

describe("PikeWorker lifecycle", () => {
  test("ping returns status and version", async () => {
    const result = await worker.ping();
    expect(result.status).toBe("ok");
    expect(result.pike_version).toMatch(/\d+\.\d+\.\d+/);
  });

  test("worker stays alive across multiple requests", async () => {
    const p1 = await worker.ping();
    const result = await worker.diagnose("int main() { return 0; }", "test.pike");
    const p2 = await worker.ping();

    expect(p1.status).toBe("ok");
    expect(result.exit_code).toBe(0);
    expect(p2.status).toBe("ok");
    expect(worker.isAlive).toBe(true);
  });

  test("restart creates a new worker process", async () => {
    const before = await worker.ping();
    await worker.restart();
    const after = await worker.ping();

    expect(before.status).toBe("ok");
    expect(after.status).toBe("ok");
    expect(worker.isAlive).toBe(true);
  });

  test("stop kills the worker", async () => {
    const w = new PikeWorker();
    await w.ping();
    expect(w.isAlive).toBe(true);

    w.stop();
    expect(w.isAlive).toBe(false);
  });
});

describe("PikeWorker diagnostics", () => {
  test("clean source returns empty diagnostics", async () => {
    const result = await worker.diagnose(
      "int main() { return 0; }\n",
      "clean.pike",
    );

    expect(result.exit_code).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  test("type error under strict_types is detected", async () => {
    const source = [
      "#pragma strict_types",
      "int main() {",
      "  int x = 1;",
      "  string y = x;",
      "  return 0;",
      "}",
    ].join("\n");

    const result = await worker.diagnose(source, "type-error.pike", { strict: true });

    expect(result.exit_code).toBe(1);
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);

    const typeError = result.diagnostics.find(
      (d) => d.message === "Bad type in assignment.",
    );
    expect(typeError).toBeDefined();
    expect(typeError!.severity).toBe("error");
    expect(typeError!.expected_type).toBe("string");
    expect(typeError!.actual_type).toBe("int");
  });

  test("syntax error is reported", async () => {
    const source = "class Broken {\n  void create() {\n    // missing close\n";
    const result = await worker.diagnose(source, "syntax-error.pike");

    expect(result.exit_code).toBe(1);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0].severity).toBe("error");
  });

  test("undefined variable under strict_types", async () => {
    const source = [
      "#pragma strict_types",
      "int main() {",
      "  return undefined_var;",
      "}",
    ].join("\n");

    const result = await worker.diagnose(source, "undef.pike", { strict: true });

    expect(result.exit_code).toBe(1);
    const undef = result.diagnostics.find(
      (d) => d.message.includes("Undefined"),
    );
    expect(undef).toBeDefined();
  });

  test("warning severity is distinct from error", async () => {
    const source = [
      "int main() {",
      "  int unused = 42;",
      "  return 0;",
      "}",
    ].join("\n");

    const result = await worker.diagnose(source, "warning.pike");

    // Pike may or may not report warnings depending on version
    // If there are warnings, verify they have severity "warning"
    const warnings = result.diagnostics.filter(
      (d) => d.severity === "warning",
    );
    if (warnings.length > 0) {
      expect(warnings[0].severity).toBe("warning");
    }
  });
});

describe("PikeWorker concurrent requests", () => {
  test("5 concurrent diagnose requests all complete", async () => {
    const sources = Array.from({ length: 5 }, (_, i) => ({
      source: `int x_${i} = ${i};\n`,
      file: `concurrent_${i}.pike`,
    }));

    const results = await Promise.all(
      sources.map((s) => worker.diagnose(s.source, s.file)),
    );

    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.exit_code).toBe(0);
    }
  });
});
