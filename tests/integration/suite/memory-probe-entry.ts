/**
 * Extension-host entry point for the memory probe.
 *
 * @vscode/test-electron calls `run()` on this module inside the host. Kept
 * separate from suite/index.ts so the probe never runs as part of the ordinary
 * integration suite — it opens Pike's whole stdlib and idles for a minute.
 */

import { probe } from "./memory-probe";

export async function run(): Promise<void> {
  await probe();
}
