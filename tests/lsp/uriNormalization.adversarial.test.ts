/**
 * Adversarial tests for URI normalization in WorkspaceIndex.
 *
 * These tests try to break the normalization by exercising edge cases that
 * could produce different index keys for the same file. The fix (normalizeUri
 * at every WorkspaceIndex boundary) must survive all of these.
 *
 * Motivation: The LSP has two distinct code paths that produce file URIs:
 *   1. ModuleResolver — resolves import/inherit to filesystem paths, converts
 *      via Node's pathToFileURL(). These paths come from pike --show-paths and
 *      may contain symlinks, relative paths, or un-normalized components.
 *   2. VSCode didOpen — sends the URI of the document as the editor sees it.
 *      VSCode resolves symlinks differently (or not at all) depending on the
 *      platform and the URI scheme used.
 *
 * If these two paths produce different URIs for the same file, the
 * WorkspaceIndex creates two entries, and cross-file navigation (go-to-def,
 * find-references) breaks silently — the resolver follows one URI but the
 * symbol table is stored under the other.
 *
 * The fix: normalizeUri() at every WorkspaceIndex boundary resolves symlinks
 * via realpathSync, ensuring both paths always produce the same canonical URI.
 *
 * These tests verify the fix is robust against edge cases.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";
import { normalizeUri, uriToPath, pathToUri } from "../../server/src/util/uri";
import {
  readFileSync, writeFileSync, symlinkSync, unlinkSync,
  existsSync, mkdirSync, rmSync, realpathSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");
const STAGING_DIR = join(import.meta.dir, "..", "..", "corpus", "adversarial-uri");

const REAL_FILE = join(CORPUS_DIR, "cross-inherit-simple-a.pike");
const FILE_CONTENT = readFileSync(REAL_FILE, "utf-8");

/** Create staging dir fresh for each test run. */
function setupStaging(): void {
  if (existsSync(STAGING_DIR)) rmSync(STAGING_DIR, { recursive: true });
  mkdirSync(STAGING_DIR, { recursive: true });
}

function teardownStaging(): void {
  if (existsSync(STAGING_DIR)) rmSync(STAGING_DIR, { recursive: true });
}

function makeUri(path: string): string {
  return pathToFileURL(path).href;
}

async function indexWithContent(
  index: WorkspaceIndex, uri: string, content: string, version = 1,
): Promise<void> {
  const tree = parse(content);
  await index.upsertFile(uri, version, tree, content, ModificationSource.DidOpen);
}

// ---------------------------------------------------------------------------
// normalizeUri unit tests — pure function, no filesystem assumptions
// ---------------------------------------------------------------------------

describe("normalizeUri — pure function edge cases", () => {
  test("non-file:// URI passes through unchanged", () => {
    expect(normalizeUri("untitled:Untitled-1")).toBe("untitled:Untitled-1");
    expect(normalizeUri("inmemory://model/1")).toBe("inmemory://model/1");
    expect(normalizeUri("vscode-notebook-cell:///file.ipynb#ch0000000")).toBe(
      "vscode-notebook-cell:///file.ipynb#ch0000000",
    );
  });

  test("empty string passes through unchanged", () => {
    expect(normalizeUri("")).toBe("");
  });

  test("double normalization is idempotent", () => {
    const uri = makeUri(REAL_FILE);
    const once = normalizeUri(uri);
    const twice = normalizeUri(once);
    expect(twice).toBe(once);
  });

  test("non-lowercase scheme passes through unchanged (not a file:// URI)", () => {
    // normalizeUri only handles lowercase "file://" — VSCode always sends
    // lowercase, and Node's pathToFileURL always produces lowercase.
    // FILE:// is NOT a file URI per RFC 8089 — it's an unknown scheme.
    const upperScheme = "FILE:///tmp/test.pike";
    expect(normalizeUri(upperScheme)).toBe(upperScheme);
  });

  test("percent-encoded path roundtrips correctly", () => {
    setupStaging();
    try {
      const weirdPath = join(STAGING_DIR, "file with spaces.pike");
      writeFileSync(weirdPath, FILE_CONTENT);
      // Manually construct a percent-encoded URI
      const encodedUri = `file://${encodeURI("/" + weirdPath.slice(1))}`;
      const normalized = normalizeUri(encodedUri);
      // Should produce the same canonical URI as pathToFileURL
      expect(normalized).toBe(makeUri(weirdPath));
    } finally {
      teardownStaging();
    }
  });

  test("dangling symlink falls back gracefully", () => {
    setupStaging();
    try {
      const danglingLink = join(STAGING_DIR, "dangling.pike");
      const nonexistent = join(STAGING_DIR, "no-such-file.pike");
      symlinkSync(nonexistent, danglingLink);

      const danglingUri = makeUri(danglingLink);
      // realpathSync should throw for dangling symlink.
      // normalizeUri should fall back to path-based normalization.
      const result = normalizeUri(danglingUri);
      // Should still be a valid file:// URI
      expect(result.startsWith("file://")).toBe(true);
      // Should NOT be the nonexistent target
      expect(result).not.toBe(makeUri(nonexistent));
    } finally {
      teardownStaging();
    }
  });

  test("non-existent file falls back gracefully", () => {
    const nonexistentUri = makeUri("/tmp/this-file-does-not-exist-xyzzy.pike");
    const result = normalizeUri(nonexistentUri);
    // Should return a valid URI (path-based fallback)
    expect(result.startsWith("file://")).toBe(true);
    // Should be idempotent even for non-existent files
    expect(normalizeUri(result)).toBe(result);
  });
});

// ---------------------------------------------------------------------------
// Symlink topology tests — verify realpath resolves correctly
// ---------------------------------------------------------------------------

describe("normalizeUri — symlink topology", () => {
  beforeAll(() => setupStaging());
  afterAll(() => teardownStaging());

  test("direct symlink resolves to real path", () => {
    const realFile = join(STAGING_DIR, "real.pike");
    const linkFile = join(STAGING_DIR, "link.pike");
    writeFileSync(realFile, FILE_CONTENT);
    symlinkSync(realFile, linkFile);

    const realUri = makeUri(realFile);
    const linkUri = makeUri(linkFile);

    expect(normalizeUri(realUri)).toBe(realUri);
    expect(normalizeUri(linkUri)).toBe(realUri);
    // Both must produce the SAME canonical URI
    expect(normalizeUri(realUri)).toBe(normalizeUri(linkUri));
  });

  test("symlink chain (A -> B -> C -> real) resolves to real path", () => {
    const realFile = join(STAGING_DIR, "chain-real.pike");
    const link1 = join(STAGING_DIR, "chain-link1.pike");
    const link2 = join(STAGING_DIR, "chain-link2.pike");
    const link3 = join(STAGING_DIR, "chain-link3.pike");

    writeFileSync(realFile, FILE_CONTENT);
    symlinkSync(realFile, link1);
    symlinkSync(link1, link2);
    symlinkSync(link2, link3);

    const realUri = makeUri(realFile);
    expect(normalizeUri(makeUri(link3))).toBe(realUri);
    expect(normalizeUri(makeUri(link2))).toBe(realUri);
    expect(normalizeUri(makeUri(link1))).toBe(realUri);
  });

  test("circular symlink does not hang or crash", () => {
    const linkA = join(STAGING_DIR, "circle-a.pike");
    const linkB = join(STAGING_DIR, "circle-b.pike");

    // Create circular: A -> B, B -> A
    // Must create B first as a file, then overwrite as symlink
    writeFileSync(linkB, "");
    symlinkSync(linkB, linkA);
    unlinkSync(linkB);
    symlinkSync(linkA, linkB);

    // Should not hang. realpathSync detects the cycle and throws.
    const uri = makeUri(linkA);
    const result = normalizeUri(uri);
    expect(result.startsWith("file://")).toBe(true);
  });

  test("relative symlink resolves correctly", () => {
    const subdir = join(STAGING_DIR, "subdir");
    mkdirSync(subdir, { recursive: true });
    const realFile = join(subdir, "target.pike");
    const linkFile = join(STAGING_DIR, "rel-link.pike");

    writeFileSync(realFile, FILE_CONTENT);
    // Relative symlink: link points to "subdir/target.pike"
    symlinkSync("subdir/target.pike", linkFile);

    const realUri = makeUri(realFile);
    expect(normalizeUri(makeUri(linkFile))).toBe(realUri);
  });
});

// ---------------------------------------------------------------------------
// WorkspaceIndex integration — adversarial multi-path access patterns
// ---------------------------------------------------------------------------

describe("WorkspaceIndex — adversarial URI access patterns", () => {
  beforeAll(async () => {
    await initParser();
    setupStaging();
  });
  afterAll(() => teardownStaging());

  test("index via symlink, lookup via real path, remove via another symlink", async () => {
    const realFile = join(STAGING_DIR, "multi-real.pike");
    const link1 = join(STAGING_DIR, "multi-link1.pike");
    const link2 = join(STAGING_DIR, "multi-link2.pike");

    writeFileSync(realFile, FILE_CONTENT);
    symlinkSync(realFile, link1);
    symlinkSync(realFile, link2);

    const index = new WorkspaceIndex({ workspaceRoot: STAGING_DIR });

    // Index via link1
    await indexWithContent(index, makeUri(link1), FILE_CONTENT);
    expect(index.size).toBe(1);

    // Lookup via real path — should find the entry
    const realEntry = index.getFile(makeUri(realFile));
    expect(realEntry).not.toBeUndefined();

    // Lookup via link2 — should find the same entry
    const link2Entry = index.getFile(makeUri(link2));
    expect(link2Entry).not.toBeUndefined();
    expect(link2Entry!.version).toBe(realEntry!.version);

    // Remove via link2 — should remove the single entry
    index.removeFile(makeUri(link2));
    expect(index.size).toBe(0);
    expect(index.getFile(makeUri(realFile))).toBeUndefined();
    expect(index.getFile(makeUri(link1))).toBeUndefined();
  });

  test("upsertFile via symlink then upsertFile via real path — single entry, latest version wins", async () => {
    const realFile = join(STAGING_DIR, "version-real.pike");
    const link = join(STAGING_DIR, "version-link.pike");

    writeFileSync(realFile, FILE_CONTENT);
    symlinkSync(realFile, link);

    const index = new WorkspaceIndex({ workspaceRoot: STAGING_DIR });

    // Index via symlink (version 1)
    await indexWithContent(index, makeUri(link), FILE_CONTENT, 1);

    // Re-index via real path (version 2) — should overwrite, not create second entry
    await indexWithContent(index, makeUri(realFile), FILE_CONTENT, 2);

    expect(index.size).toBe(1);

    // Both lookups return version 2
    const viaReal = index.getFile(makeUri(realFile));
    const viaLink = index.getFile(makeUri(link));
    expect(viaReal!.version).toBe(2);
    expect(viaLink!.version).toBe(2);
  });

  test("upsertBackgroundFile via symlink then getFile via real path", () => {
    const realFile = join(STAGING_DIR, "bg-real.pike");
    const link = join(STAGING_DIR, "bg-link.pike");

    writeFileSync(realFile, FILE_CONTENT);
    symlinkSync(realFile, link);

    const index = new WorkspaceIndex({ workspaceRoot: STAGING_DIR });
    const tree = parse(FILE_CONTENT);
    index.upsertBackgroundFile(makeUri(link), 1, tree, FILE_CONTENT);

    // Lookup via real path
    const entry = index.getFile(makeUri(realFile));
    expect(entry).not.toBeUndefined();
    expect(entry!.uri).toBe(makeUri(realFile));
  });

  test("invalidate via symlink affects real-path lookup", async () => {
    const realFile = join(STAGING_DIR, "inv-real.pike");
    const link = join(STAGING_DIR, "inv-link.pike");

    writeFileSync(realFile, FILE_CONTENT);
    symlinkSync(realFile, link);

    const index = new WorkspaceIndex({ workspaceRoot: STAGING_DIR });
    await indexWithContent(index, makeUri(realFile), FILE_CONTENT);
    expect(index.isStale(makeUri(realFile))).toBe(false);

    // Invalidate via symlink
    index.invalidate(makeUri(link));

    // Real-path lookup should see stale
    expect(index.isStale(makeUri(realFile))).toBe(true);
    expect(index.getSymbolTable(makeUri(realFile))).toBeNull();
  });

  test("dependency graph: reverse deps work across symlinked URIs", async () => {
    const realA = join(STAGING_DIR, "dep-a.pike");
    const realB = join(STAGING_DIR, "dep-b.pike");
    const linkA = join(STAGING_DIR, "dep-a-link.pike");

    // A: simple class
    const contentA = 'class DepA { int x; }';
    // B: inherits A via real path
    const contentB = `inherit "${realA}"; class DepB { }`;

    writeFileSync(realA, contentA);
    writeFileSync(realB, contentB);
    symlinkSync(realA, linkA);

    const index = new WorkspaceIndex({ workspaceRoot: STAGING_DIR });

    // Index A via symlink (not real path)
    await indexWithContent(index, makeUri(linkA), contentA);
    // Index B via real path — B's inherit points to realA
    await indexWithContent(index, makeUri(realB), contentB);

    // B should be a dependent of A (even though A was indexed via linkA)
    const dependentsOfA = index.getDependents(makeUri(linkA));
    const dependentsViaReal = index.getDependents(makeUri(realA));

    // Both should return B because the URI was normalized
    expect(dependentsOfA.size).toBeGreaterThan(0);
    expect(dependentsViaReal.size).toBe(dependentsOfA.size);
  });

  test("invalidateWithDependents propagates across symlinked URIs", async () => {
    const realA = join(STAGING_DIR, "prop-real-a.pike");
    const realB = join(STAGING_DIR, "prop-real-b.pike");
    const linkA = join(STAGING_DIR, "prop-link-a.pike");

    const contentA = 'class PropA { int val; }';
    const contentB = `inherit "${realA}"; class PropB { }`;

    writeFileSync(realA, contentA);
    writeFileSync(realB, contentB);
    symlinkSync(realA, linkA);

    const index = new WorkspaceIndex({ workspaceRoot: STAGING_DIR });

    // Index A via real path, B via real path
    await indexWithContent(index, makeUri(realA), contentA);
    await indexWithContent(index, makeUri(realB), contentB);

    // Invalidate A via symlink — should propagate to B
    const invalidated = index.invalidateWithDependents(makeUri(linkA));
    expect(invalidated.length).toBeGreaterThanOrEqual(1);
    expect(index.isStale(makeUri(realB))).toBe(true);
  });

  test("non-file URI (untitled:) crashes in dependency extraction — known limitation", async () => {
    const index = new WorkspaceIndex({ workspaceRoot: STAGING_DIR });
    const content = 'class Untitled { int x; }';
    const tree = parse(content);

    // KNOWN BUG: non-file URIs (untitled:, inmemory:) crash when
    // extractDependencies -> findDirectoryModulePmod -> fileURLToPath
    // is called on them. fileURLToPath rejects non-file:// schemes.
    // This is a pre-existing bug, not caused by the URI normalization fix.
    //
    // The correct behavior would be to skip dependency resolution for
    // non-file URIs, but that requires changes to workspaceDependencies.ts
    // and moduleResolver.ts — out of scope for the normalization fix.
    expect(async () => {
      await index.upsertFile(
        "untitled:Untitled-1", 1, tree, content, ModificationSource.DidOpen,
      );
    }).toThrow();

    // upsertBackgroundFile works because it skips dependency resolution
    index.upsertBackgroundFile(
      "untitled:Untitled-1", 1, tree, content,
    );
    expect(index.getFile("untitled:Untitled-1")).not.toBeUndefined();
  });

  test("restoreDependencies normalizes cached dependency URIs", async () => {
    const realFile = join(STAGING_DIR, "cache-real.pike");
    const link = join(STAGING_DIR, "cache-link.pike");

    writeFileSync(realFile, FILE_CONTENT);
    symlinkSync(realFile, link);

    const index = new WorkspaceIndex({ workspaceRoot: STAGING_DIR });
    const tree = parse(FILE_CONTENT);

    // Insert as cached file (simulates cache restoration)
    index.upsertCachedFile(makeUri(realFile), 1, buildMinimalTable(makeUri(realFile)), "abc123");

    // Restore dependencies — using symlink URI (as if cached before symlink existed)
    const deps = new Set([makeUri(link)]);
    index.restoreDependencies(makeUri(realFile), deps);

    // getDependents via symlink should find the real file
    const dependents = index.getDependents(makeUri(link));
    // The real file should be a dependent of itself (unusual but tests normalization)
    expect(dependents.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Performance sanity — normalizeUri called in hot loops must be fast
// ---------------------------------------------------------------------------

describe("normalizeUri — performance sanity", () => {
  test("1000 normalizations of same URI complete in under 500ms", () => {
    const uri = makeUri(REAL_FILE);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      normalizeUri(uri);
    }
    const elapsed = performance.now() - start;
    // realpathSync is a syscall — should be fast for cached inodes
    // but we allow generous margin. If this exceeds 500ms there's
    // a real problem.
    expect(elapsed).toBeLessThan(500);
  });

  test("1000 normalizations of non-existent file complete in under 500ms", () => {
    const uri = makeUri("/tmp/nonexistent-adversarial-test-file.pike");
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      normalizeUri(uri);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { SymbolTable } from "../../server/src/features/symbolTable";

/** Build a minimal symbol table for cache restoration tests. */
function buildMinimalTable(uri: string): SymbolTable {
  const content = FILE_CONTENT;
  const tree = parse(content);
  // Use the actual buildSymbolTable to get a valid table
  const { buildSymbolTable } = require("../../server/src/features/symbolTable");
  return buildSymbolTable(tree, uri, 1, { index: { getSymbolTable: () => null, resolveImport: () => null, resolveInherit: () => null } });
}
