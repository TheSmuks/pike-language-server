/**
 * Crash-restart policy for the language client.
 *
 * Kept free of any `vscode` import so it can be unit-tested: the restart
 * decision is where a crash loop becomes an infinite loop, and that has to be
 * verifiable without an extension host.
 *
 * The bug this exists to prevent: resetting the attempt counter the moment the
 * server reports Running. A server that starts successfully and then crashes
 * resets the counter every cycle, so a "give up after N" cap never fires and
 * the user is restarted — and re-notified — forever. The counter may only be
 * cleared once the server has stayed up long enough to call the session
 * healthy.
 */

/** The client states this policy reacts to. */
export type ServerState = "starting" | "running" | "stopped";

export type RestartDecision =
  | { action: "none" }
  | { action: "restart"; delayMs: number; attempt: number; maxAttempts: number }
  | { action: "give-up"; maxAttempts: number };

export interface RestartPolicyOptions {
  /** How many crashes in a row before giving up. */
  maxAttempts?: number;
  /**
   * How long the server must stay Running before its next crash is treated as
   * a fresh incident rather than a continuation of the current loop.
   */
  stableMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

export class RestartPolicy {
  private attempt = 0;
  private runningSince: number | null = null;
  private readonly maxAttempts: number;
  private readonly stableMs: number;
  private readonly now: () => number;

  constructor(options: RestartPolicyOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.stableMs = options.stableMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Attempts used so far in the current crash loop. Exposed for logging. */
  get attempts(): number {
    return this.attempt;
  }

  onStateChange(newState: ServerState, oldState: ServerState): RestartDecision {
    if (newState === "running") {
      this.runningSince = this.now();
      return { action: "none" };
    }

    // Only a Running → Stopped transition is a crash. Stopping from Starting,
    // or an explicit shutdown, is not.
    if (newState !== "stopped" || oldState !== "running") {
      return { action: "none" };
    }

    // A session that stayed up past the stability window was healthy, so this
    // crash starts a new loop rather than continuing the old one.
    if (this.runningSince !== null && this.now() - this.runningSince >= this.stableMs) {
      this.attempt = 0;
    }
    this.runningSince = null;

    if (this.attempt >= this.maxAttempts) {
      return { action: "give-up", maxAttempts: this.maxAttempts };
    }

    this.attempt++;
    return {
      action: "restart",
      delayMs: this.attempt * 2000,
      attempt: this.attempt,
      maxAttempts: this.maxAttempts,
    };
  }
}
