import { execSync } from "node:child_process";
import { dirname } from "node:path";

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
} catch {
  // Pike not available
}

export const pikeAvailable = _available;
export const pikeVersion = _version;
export const pikeHome = _pikeHome;
