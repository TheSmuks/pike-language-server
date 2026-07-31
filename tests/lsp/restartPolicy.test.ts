/**
 * Crash-restart policy.
 *
 * The defect these pin: the previous handler reset its attempt counter the
 * instant the server reported Running, so a server that started and then
 * crashed reset the cap on every cycle. The "give up after 3" never fired, the
 * client restarted forever, and every restart re-ran server init — which is
 * how a missing Pike binary turned into an endless stream of notifications.
 */

import { describe, test, expect } from "bun:test";
import { RestartPolicy } from "../../client/restartPolicy";

/** Drive one crash cycle: the server comes up, then dies. */
function crashCycle(policy: RestartPolicy) {
  policy.onStateChange("running", "starting");
  return policy.onStateChange("stopped", "running");
}

describe("RestartPolicy", () => {
  test("restarts with increasing backoff", () => {
    const policy = new RestartPolicy({ now: () => 1000 });
    expect(crashCycle(policy)).toMatchObject({ action: "restart", attempt: 1, delayMs: 2000 });
    expect(crashCycle(policy)).toMatchObject({ action: "restart", attempt: 2, delayMs: 4000 });
    expect(crashCycle(policy)).toMatchObject({ action: "restart", attempt: 3, delayMs: 6000 });
  });

  test("gives up after the cap — a fast crash loop cannot restart forever", () => {
    // The clock never advances, so the server never stays up long enough to
    // count as healthy. This is the exact shape of the infinite loop.
    const policy = new RestartPolicy({ now: () => 1000 });
    crashCycle(policy);
    crashCycle(policy);
    crashCycle(policy);
    expect(crashCycle(policy)).toEqual({ action: "give-up", maxAttempts: 3 });
    // …and stays given up.
    expect(crashCycle(policy)).toEqual({ action: "give-up", maxAttempts: 3 });
  });

  test("reaching Running does NOT by itself clear the counter", () => {
    // This is the regression. Under the old logic each `running` reset the
    // count, so this sequence restarted indefinitely.
    let clock = 0;
    const policy = new RestartPolicy({ now: () => clock });
    for (let i = 0; i < 3; i++) {
      clock += 1000; // up for one second — well short of the stability window
      crashCycle(policy);
    }
    clock += 1000;
    expect(crashCycle(policy).action).toBe("give-up");
  });

  test("a session that stayed healthy starts a fresh budget", () => {
    let clock = 0;
    const policy = new RestartPolicy({ now: () => clock, stableMs: 60_000 });
    crashCycle(policy);
    crashCycle(policy);
    crashCycle(policy);

    // Now the server comes up and stays up past the stability window.
    policy.onStateChange("running", "starting");
    clock += 120_000;
    expect(policy.onStateChange("stopped", "running")).toMatchObject({ action: "restart", attempt: 1 });
  });

  test("ignores transitions that are not a crash", () => {
    const policy = new RestartPolicy();
    expect(policy.onStateChange("starting", "stopped")).toEqual({ action: "none" });
    expect(policy.onStateChange("running", "starting")).toEqual({ action: "none" });
    // Stopped from Starting is a failed launch, not a crash of a live server.
    expect(policy.onStateChange("stopped", "starting")).toEqual({ action: "none" });
  });
});
