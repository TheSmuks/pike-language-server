/**
 * Oracle gate: ask Pike whether a Roxen file is valid before we call our
 * behaviour on it a defect.
 *
 * Roxen contains source that no correct tool accepts. Without this gate a
 * Roxen-driven audit produces a findings list padded with non-defects. The
 * verdict, not the error count, is what triage reads — see
 * tools/roxen-lab/README.md.
 */

import { execFileSync } from "node:child_process";

export type Verdict = "ok" | "semantic" | "cpp_error" | "syntax" | "unreadable" | "unavailable";

export interface OracleResult {
  file: string;
  verdict: Verdict;
  detail?: string;
}

const IMAGE = "pike-lsp/roxen-lab:6.1";
/** Files per docker run. One container start per file would dominate runtime. */
const BATCH = 40;

/** True when a bad result on this file is our bug rather than invalid source. */
export function isOurDefect(verdict: Verdict): boolean {
  return verdict === "ok" || verdict === "semantic" || verdict === "cpp_error";
}

export function oracleAvailable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Parse `oracle --json` output into corpus-relative path → result. */
export function parseOracleOutput(stdout: string): Map<string, OracleResult> {
  const results = new Map<string, OracleResult>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { file: string; verdict: Verdict; detail?: string };
      const relative = parsed.file.replace(/^\/corpus\//, "");
      results.set(relative, { file: relative, verdict: parsed.verdict, detail: parsed.detail });
    } catch {
      // Not a result line.
    }
  }
  return results;
}

/**
 * Classify files (paths relative to `roxenRoot`) by compiling them with Pike
 * inside the lab container.
 *
 * When Docker or the image is missing every file comes back "unavailable";
 * triage marks those findings unclassified rather than guessing.
 */
export function classify(relativeFiles: string[], roxenRoot: string): Map<string, OracleResult> {
  const results = new Map<string, OracleResult>();
  if (!oracleAvailable()) {
    for (const file of relativeFiles) {
      results.set(file, { file, verdict: "unavailable" });
    }
    return results;
  }

  for (let i = 0; i < relativeFiles.length; i += BATCH) {
    const batch = relativeFiles.slice(i, i + BATCH);
    const args = [
      "run", "--rm",
      "-v", `${roxenRoot}:/corpus:ro`,
      IMAGE, "oracle", "--json",
      ...batch.map((f) => `/corpus/${f}`),
    ];
    let stdout = "";
    try {
      stdout = execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      // oracle.pike exits non-zero when any file fails to compile, which is
      // the normal case here. Its stdout is still the answer.
      stdout = (error as { stdout?: string }).stdout ?? "";
    }
    for (const [path, result] of parseOracleOutput(stdout)) {
      results.set(path, result);
    }
  }

  for (const file of relativeFiles) {
    if (!results.has(file)) results.set(file, { file, verdict: "unreadable" });
  }
  return results;
}
