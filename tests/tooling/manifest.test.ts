/**
 * Tests for the corpus manifest tool (scripts/manifest.ts).
 *
 * `--sync` rewrites corpus/manifest.md in place, so a round trip through
 * parse + render has to preserve what the document already says. The category
 * a file sits under is part of that: it is only recorded in the `###` heading
 * above the table, nowhere else, so a render that forgets it loses information
 * the tool cannot get back.
 */

import { describe, test, expect } from "bun:test";
import { parseManifestMd, renderManifest, shouldWrite } from "../../scripts/manifest";

const FIXTURE = [
  "# Corpus Manifest",
  "",
  "## Corpus Files (2 committed)",
  "",
  "### Basic types and variables",
  "",
  "| # | File | Feature(s) | Priority | Status |",
  "|---|------|------------|----------|--------|",
  "| 1 | `basic-types.pike` | All primitive types | P0 | Valid |",
  "",
  "### Error cases",
  "",
  "| # | File | Feature(s) | Priority | Status |",
  "|---|------|------------|----------|--------|",
  "| 2 | `err-undef-var.pike` | Reference to undefined variable | P0 | Error |",
  "",
  "## Summary",
  "",
].join("\n");

const ON_DISK = ["basic-types.pike", "err-undef-var.pike"];

describe("manifest round trip", () => {
  test("keeps every committed file under the category heading it came from", () => {
    const rendered = renderManifest(parseManifestMd(FIXTURE), ON_DISK, {});

    expect(rendered).toContain("### Basic types and variables");
    expect(rendered).toContain("### Error cases");
  });

  test("never emits a section with an empty heading", () => {
    const rendered = renderManifest(parseManifestMd(FIXTURE), ON_DISK, {});

    expect(rendered.split("\n").filter((l) => l.trimEnd() === "###")).toEqual([]);
  });

  test("does not tell the reader to sync files the render just committed", () => {
    // renderManifest only ever runs on the write path, so a file it is adding
    // is committed by the time anyone reads the output.
    const rendered = renderManifest(parseManifestMd(FIXTURE), [
      ...ON_DISK,
      "class-create.pike",
    ], {});

    expect(rendered).not.toContain("not yet committed to the manifest");
  });

  test("files new to the manifest are classified by their filename prefix", () => {
    const rendered = renderManifest(parseManifestMd(FIXTURE), [
      ...ON_DISK,
      "class-create.pike",
    ], {});

    expect(rendered).toContain("### Classes and inheritance");
    expect(rendered).toContain("`class-create.pike`");
  });
});

describe("write gating", () => {
  test("--sync writes", () => {
    expect(shouldWrite(["--sync"])).toBe(true);
  });

  test("no flag does not write", () => {
    expect(shouldWrite([])).toBe(false);
  });

  test("--dry-run suppresses the write it is documented to suppress", () => {
    expect(shouldWrite(["--sync", "--dry-run"])).toBe(false);
  });
});
