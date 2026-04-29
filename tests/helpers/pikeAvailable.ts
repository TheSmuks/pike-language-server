import { execSync } from "node:child_process";
import { dirname } from "node:path";

let _available = false;
let _version: string | null = null;
let _pikeHome: string | null = null;

try {
  const output = execSync("pike --version", { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  _available = true;
  const match = output.match(/Pike v(\d+\.\d+\.\d+)/);
  if (match) _version = match[1];

  const pathsOutput = execSync("pike --show-paths", { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
  for (const line of pathsOutput.split("\n")) {
    const m = line.match(/^master\.pike\.\.\.\s*:\s*(.+)$/);
    if (m) {
      _pikeHome = dirname(dirname(m[1].trim()));
      break;
    }
  }
} catch {
  // Pike not available
}

export const pikeAvailable = _available;
export const pikeVersion = _version;
export const pikeHome = _pikeHome;
