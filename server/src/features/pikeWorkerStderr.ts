/**
 * Pike worker stderr handling — extracted from PikeWorkerProcess to keep
 * each file under 500 lines.
 */

import type { PikeWorkerConfig } from "./pikeWorkerTypes.js";

export interface StderrHandlerDeps {
  pikeAvailable: boolean | null;
  warnedAboutMissingLibs: boolean;
  consecutiveCrashes: number;
  config: PikeWorkerConfig;
  onCriticalError: ((ctx: string, err: unknown) => void) | null;
  onWarning: ((ctx: string, msg: string) => void) | null;
  crashBackoffThreshold: number;
}

/**
 * Handle a single stderr line from the Pike worker.
 * Detects missing-library warnings, Pike fatal errors, and routes
 * other output as critical errors.
 *
 * Returns an updated `warnedAboutMissingLibs` flag.
 */
export function handlePikeStderr(
  msg: string,
  deps: StderrHandlerDeps,
): boolean {
  if (!msg) return deps.warnedAboutMissingLibs;
  if (deps.pikeAvailable === false) return deps.warnedAboutMissingLibs;

  const libMatch = /Failed to load library: (lib[\w-]+\.so[\d.]*)/.exec(msg);
  if (!deps.warnedAboutMissingLibs && libMatch) {
    const libName = libMatch[1];
    if (deps.config.libraryPath) {
      deps.onWarning?.(
        "worker.missingLibrary",
        `Failed to load ${libName} — the configured ` +
        `pike.languageServer.worker.ldLibraryPath ` +
        `("${deps.config.libraryPath}") may not contain it.`,
      );
    } else {
      deps.onWarning?.(
        "worker.missingLibrary",
        `Failed to load ${libName}. ` +
        `Set pike.languageServer.worker.ldLibraryPath to the directory ` +
        `containing this library (e.g. /usr/lib/x86_64-linux-gnu).`,
      );
    }
    return true;
  }

  const isFatalPikeError = /Fatal error:/i.test(msg);
  if (isFatalPikeError) {
    if (deps.consecutiveCrashes >= deps.crashBackoffThreshold) {
      return deps.warnedAboutMissingLibs;
    }
    deps.onWarning?.("worker.pikeFatal", `[pike-worker stderr] ${msg}`);
    return deps.warnedAboutMissingLibs;
  }

  deps.onCriticalError?.("worker.stderr", new Error(`[pike-worker stderr] ${msg}`));
  return deps.warnedAboutMissingLibs;
}