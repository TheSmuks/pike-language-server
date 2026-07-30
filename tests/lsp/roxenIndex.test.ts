/**
 * Tests for the bundled Roxen index.
 *
 * The index exists so that a Roxen file works on a machine that has never run
 * Roxen, so most of these assert against the real committed data rather than a
 * fixture — a fixture would only prove the lookup functions work, not that the
 * shipped index actually contains what Roxen code refers to.
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_ROXEN_INDEX,
  asRoxenIndex,
  indexCoversHeader,
  lookupRoxenConstant,
  lookupRoxenIdentifier,
  lookupRoxenSymbol,
  roxenCompletionCandidates,
  roxenMembersOf,
  type RoxenIndexData,
} from "../../server/src/features/roxenIndex";

const INDEX_PATH = join(import.meta.dir, "..", "..", "server", "src", "data", "roxen-index.json");
const index: RoxenIndexData = asRoxenIndex(JSON.parse(readFileSync(INDEX_PATH, "utf-8")));

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

describe("the shipped index", () => {
  test("names the pinned revision it was generated from", () => {
    expect(index.roxenRevision).toBe("4f1d04f82b3ea95f680cddab552d4912990c9c2f");
    expect(index.roxenVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("covers the constant families module.h defines", () => {
    const names = Object.keys(index.constants);
    for (const family of ["TYPE_", "VAR_", "MOD_"]) {
      const found = names.filter((n) => n.startsWith(family));
      expect(found.length, `${family}* constants`).toBeGreaterThan(0);
    }
  });

  test("covers the MODULE_* taxonomy", () => {
    // Roxen 6.1 declares roughly twenty of these in module_constants.h.
    const moduleTypes = Object.keys(index.constants).filter((n) => n.startsWith("MODULE_"));
    expect(moduleTypes.length).toBeGreaterThanOrEqual(20);
    expect(moduleTypes).toContain("MODULE_LOCATION");
    expect(moduleTypes).toContain("MODULE_TAG");
    expect(moduleTypes).toContain("MODULE_PROVIDER");
  });

  test("records which header each constant came from", () => {
    expect(lookupRoxenConstant(index, "TYPE_STRING")?.header).toBe("module.h");
    expect(lookupRoxenConstant(index, "MODULE_LOCATION")?.header).toBe("module_constants.h");
  });

  test("carries the Roxen and RXML API surface", () => {
    const fqns = Object.keys(index.symbols);
    expect(fqns.some((f) => f.startsWith("Roxen."))).toBe(true);
    expect(fqns.some((f) => f.startsWith("RXML."))).toBe(true);
    // The module prototype's members are what a module author sees bare.
    expect(fqns.some((f) => f.startsWith("RoxenModule."))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

describe("lookup", () => {
  test("resolves a constant referenced by real Roxen code", () => {
    const entry = lookupRoxenConstant(index, "TYPE_STRING");
    expect(entry).not.toBeNull();
    expect(entry!.signature).toContain("TYPE_STRING");
  });

  test("resolves a module type", () => {
    expect(lookupRoxenConstant(index, "MODULE_LOCATION")?.signature)
      .toContain("MODULE_LOCATION");
  });

  test("resolves a prototype member by bare name", () => {
    // A module writes `find_file(...)` unqualified because it inherits the
    // prototype; the index stores it under RoxenModule.
    const bare = lookupRoxenIdentifier(index, "find_file");
    const qualified = lookupRoxenSymbol(index, "RoxenModule.find_file");
    if (qualified) {
      expect(bare).not.toBeNull();
      expect(bare!.signature).toBe(qualified.signature);
    }
  });

  test("returns null for a name Roxen does not define", () => {
    expect(lookupRoxenConstant(index, "NOT_A_ROXEN_SYMBOL")).toBeNull();
    expect(lookupRoxenIdentifier(index, "NOT_A_ROXEN_SYMBOL")).toBeNull();
  });

  test("carries no locations, so nothing can fabricate one", () => {
    // Go-to-definition on an index-only symbol must return nothing rather than
    // a path into a tree that may not exist on this machine.
    const entry = lookupRoxenConstant(index, "TYPE_STRING") as unknown as Record<string, unknown>;
    expect(entry["uri"]).toBeUndefined();
    expect(entry["path"]).toBeUndefined();
    expect(entry["line"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Header coverage
// ---------------------------------------------------------------------------

describe("indexCoversHeader", () => {
  test("covers the headers the corpus includes most", () => {
    for (const header of ["module.h", "module_constants.h"]) {
      expect(indexCoversHeader(index, header), header).toBe(true);
    }
  });

  test("accepts the raw include spelling", () => {
    expect(indexCoversHeader(index, "<module.h>")).toBe(true);
    expect(indexCoversHeader(index, '"module.h"')).toBe(true);
  });

  test("does not claim a header it has nothing from", () => {
    expect(indexCoversHeader(index, "stdio.h")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

describe("completion candidates", () => {
  test("offers constants by bare name", () => {
    const names = new Set(roxenCompletionCandidates(index).map((c) => c.name));
    expect(names.has("TYPE_STRING")).toBe(true);
    expect(names.has("MODULE_LOCATION")).toBe(true);
  });

  test("offers no dotted names at top level", () => {
    for (const candidate of roxenCompletionCandidates(index)) {
      expect(candidate.name).not.toContain(".");
    }
  });

  test("offers immediate children of a dotted prefix only", () => {
    const members = roxenMembersOf(index, "RXML");
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      expect(member.name).not.toContain(".");
    }
  });

  test("offers nothing for a prefix that is not in the index", () => {
    expect(roxenMembersOf(index, "NotARoxenModule")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe("malformed data", () => {
  test("degrades to an empty index rather than throwing", () => {
    // Static data is loaded before the server accepts a connection; a bad file
    // must mean "no Roxen symbols", never a crash.
    for (const bad of [null, undefined, 42, "text", {}, { constants: 1 }, { symbols: {} }]) {
      expect(asRoxenIndex(bad)).toEqual(EMPTY_ROXEN_INDEX);
    }
  });

  test("an empty index answers every lookup with null", () => {
    expect(lookupRoxenConstant(EMPTY_ROXEN_INDEX, "TYPE_STRING")).toBeNull();
    expect(lookupRoxenIdentifier(EMPTY_ROXEN_INDEX, "find_file")).toBeNull();
    expect(roxenCompletionCandidates(EMPTY_ROXEN_INDEX)).toEqual([]);
    expect(indexCoversHeader(EMPTY_ROXEN_INDEX, "module.h")).toBe(false);
  });
});
