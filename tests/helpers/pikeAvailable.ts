import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const PIKE_BINARY = process.env.PIKE_BINARY ?? "pike";

let _available = false;
let _version: string | null = null;
let _pikeHome: string | null = null;

try {
  const output = execSync(`"${PIKE_BINARY}" --version 2>&1`, { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  _available = true;
  const match = output.match(/Pike v(\d+\.\d+\.\d+)/);
  if (match) _version = match[1];

  const pathsOutput = execSync(`"${PIKE_BINARY}" --show-paths 2>&1`, { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  for (const line of pathsOutput.split("\n")) {
    const m = line.match(/^master\.pike\.\.\.\s*:\s*(.+)$/);
    if (m) {
      const masterPath = m[1].trim();
      if (masterPath.endsWith("/lib/master.pike")) {
        _pikeHome = dirname(dirname(masterPath));
      } else {
        _pikeHome = dirname(masterPath);
      }
      break;
    }
  }
} catch (_) {
  // Pike not available
}

export const pikeAvailable = _available;
export const pikeVersion = _version;
export const pikeHome = _pikeHome;

/**
 * The stdlib module root of the *running* Pike, or null when unavailable.
 *
 * Source builds put modules under $PIKE_HOME/lib/modules; package layouts use
 * $PIKE_HOME/modules. Never hardcode an absolute path: a developer box may have
 * Pike at /usr/local/pike/<ver> while CI builds it into $HOME/.pike, and a test
 * pinned to one of those silently only ever runs in one place.
 */
export const pikeModulesDir: string | null = (() => {
  if (!_pikeHome) return null;
  for (const candidate of [join(_pikeHome, "lib", "modules"), join(_pikeHome, "modules")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
})();

/**
 * Resolve a path relative to the stdlib module root.
 * Returns null when Pike is absent or the module is not part of this build —
 * Pike is configurable, so an optional module's absence is not a test failure.
 */
export function stdlibModulePath(relative: string): string | null {
  if (!pikeModulesDir) return null;
  const full = join(pikeModulesDir, relative);
  return existsSync(full) ? full : null;
}
