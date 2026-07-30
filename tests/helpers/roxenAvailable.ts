import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Locate a real Roxen tree for tests that must run against the genuine layout
 * rather than a fixture.
 *
 * Candidates, in order: an explicit `$ROXEN_HOME`, the corpus checkout named by
 * `$ROXEN_CORPUS`, the conventional sibling clone, and finally the install
 * location the Docker lab uses (present when the suite runs inside the lab).
 *
 * A synthetic fixture can only ever confirm that detection matches the shape we
 * imagined; these confirm it matches the shape Roxen actually ships. Tests that
 * use this must skip, not fail, when it returns null — most machines have no
 * Roxen, which is precisely the case the feature is designed for.
 */
function findRoxenTree(): string | null {
  const candidates = [
    process.env.ROXEN_HOME,
    process.env.ROXEN_CORPUS,
    "/tank/projects/roxen-6.1",
    "/usr/local/roxen6",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);

  for (const candidate of candidates) {
    if (
      existsSync(join(candidate, "server", "base_server", "roxen.pike")) &&
      existsSync(join(candidate, "server", "etc", "include", "module.h"))
    ) {
      return candidate;
    }
  }
  return null;
}

export const roxenHome: string | null = findRoxenTree();
export const roxenAvailable = roxenHome !== null;
