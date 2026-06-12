import { describe, expect, test } from "bun:test";
import { runGateFixture } from "./detectHarness";

describe("quality gate detector fixtures", () => {
  test("flags nesting depth greater than four", async () => {
    const result = await runGateFixture("nesting-depth", "--nesting");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("max-nesting-depth");
    expect(result.stderr).toContain("bad.ts");
  });

  test("flags modules exporting more than twenty public symbols", async () => {
    const result = await runGateFixture("module-exports", "--exports");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("max-module-exports");
    expect(result.stderr).toContain("21 exports");
  });

  test("flags unbounded loops without proof comments", async () => {
    const result = await runGateFixture("loop-bounds", "--loops");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("bounded-loops");
    expect(result.stderr).toContain("bad.ts");
  });

  test("allows bounded collection and range loops", async () => {
    const result = await runGateFixture("loop-bounds", "--loops");
    expect(result.stderr).not.toContain("clean-bounded.ts");
  });

  test("flags bare markers without tracked issue links", async () => {
    const result = await runGateFixture("markers", "--markers");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("linked-markers");
    expect(result.stderr).toContain("bad.ts");
  });

  test("does not match marker substrings inside identifiers", async () => {
    const result = await runGateFixture("markers", "--markers");
    expect(result.stderr).not.toContain("clean-autodoc.ts");
  });

  test("flags skipped tests without documented reasons", async () => {
    const result = await runGateFixture("skipped-tests", "--skips");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("documented-skips");
    expect(result.stderr).toContain("bad.test.ts");
  });

  test("allows documented skipped tests", async () => {
    const result = await runGateFixture("skipped-tests", "--skips");
    expect(result.stderr).not.toContain("clean-documented.test.ts");
  });

  test("rejects invalid rule catalog entries as setup errors", async () => {
    const result = await runGateFixture("catalog-invalid", "--catalog");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid rule catalog");
  });

  test("rejects invalid suppression entries as setup errors", async () => {
    const result = await runGateFixture("suppressions-invalid", "--catalog");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid suppression registry");
  });
});
