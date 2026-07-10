/**
 * Regression tests for validateResolveResult null-tolerance.
 *
 * pike-introspect emits `source_file: null` (and omits `source_line`) for
 * symbols whose location it cannot determine — e.g. inner classes like
 * `Protocols.HTTP.Session.Cookie`. The validator must treat null like absent
 * rather than throwing, which would discard an otherwise-valid result full of
 * real methods. This surfaced when PikeWorker.resolve() was first wired into
 * completion (audit iteration-6 C1).
 */

import { describe, it, expect } from "bun:test";
import { validateResolveResult } from "../../server/src/util/jsonValidation";

describe("validateResolveResult null-tolerance", () => {
  it("accepts a member with source_file: null", () => {
    const raw = {
      resolved: true,
      kind: "class",
      methods: [
        { name: "Cookie", source_file: null },
        { name: "request", source_file: "/lib/Session.pike", source_line: 72 },
      ],
    };
    const result = validateResolveResult(raw);
    expect(result.resolved).toBe(true);
    expect(result.methods).toHaveLength(2);
    expect(result.methods?.[0].name).toBe("Cookie");
  });

  it("accepts top-level source_file: null", () => {
    const raw = { resolved: true, kind: "class", name: "Foo", source_file: null };
    const result = validateResolveResult(raw);
    expect(result.resolved).toBe(true);
    expect(result.name).toBe("Foo");
  });

  it("accepts a member with source_line: null", () => {
    const raw = {
      resolved: true,
      constants: [{ name: "FLAG", source_file: "/x.pike", source_line: null }],
    };
    const result = validateResolveResult(raw);
    expect(result.constants).toHaveLength(1);
  });

  it("still rejects a non-string, non-null source_file", () => {
    const raw = {
      resolved: true,
      methods: [{ name: "bad", source_file: { nested: "object" } }],
    };
    expect(() => validateResolveResult(raw)).toThrow();
  });

  it("still rejects a missing member name", () => {
    const raw = { resolved: true, methods: [{ source_file: null }] };
    expect(() => validateResolveResult(raw)).toThrow();
  });
});
