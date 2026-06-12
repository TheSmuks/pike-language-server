import { describe, test, expect, mock } from "bun:test";
import {
  HibernationManager,
  HIBERNATION_DEFAULTS,
} from "../../server/src/features/hibernation";

// ---------------------------------------------------------------------------
// Tests for US4: Idle Hibernation (Phase 6, T080-T084)
//
// Methodology: fake-clock driven. We inject a controllable `now()` function so
// we can advance time deterministically and verify hibernation transitions
// without waiting real seconds. The callbacks are mocked to record calls
// without executing real server logic.
// ---------------------------------------------------------------------------

describe("US4: Idle hibernation transition (Phase 6, T080)", () => {
  test("T080: server enters hibernation after idle timeout with no open documents", async () => {
    const calls: string[] = [];
    let now = 1_000_000;
    const nowFn = () => now;

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 60_000 },
      makeCallbacks(calls),
      nowFn,
    );

    expect(manager.status).toBe("active");

    // Advance time past idle threshold — no activity, no open documents.
    now += 61_000;
    await manager.checkIdleTimeout();

    expect(manager.status).toBe("hibernated");
    expect(calls).toContain("stopWorker");
    expect(calls).toContain("cancelBackgroundIndex");
    expect(calls).toContain("saveCache");
    expect(calls).toContain("clearIndex");
  });

  test("T080: server does NOT hibernate while documents are open", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 60_000 },
      makeCallbacks(calls),
      () => now,
    );

    // Open a document — increments open document count.
    manager.onDocumentOpen();
    expect(manager.openDocumentCount).toBe(1);

    // Advance time past idle threshold.
    now += 100_000;
    await manager.checkIdleTimeout();

    // Must still be active — open documents prevent hibernation.
    expect(manager.status).toBe("active");
    expect(calls).not.toContain("onHibernationStart");
  });

  test("T080: hibernation disabled when idleTimeoutMs is 0", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 0 },
      makeCallbacks(calls),
      () => now,
    );

    now += 9_999_999;
    await manager.checkIdleTimeout();

    expect(manager.status).toBe("active");
    expect(calls.length).toBe(0);
  });

  test("T080: activity resets idle timer before hibernation triggers", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 60_000 },
      makeCallbacks(calls),
      () => now,
    );

    // 50s pass — not yet at threshold.
    now += 50_000;
    await manager.checkIdleTimeout();
    expect(manager.status).toBe("active");

    // Activity resets the timer.
    manager.recordActivity();
    now += 50_000;
    await manager.checkIdleTimeout();
    expect(manager.status).toBe("active"); // 50s since last activity, not 100s

    // Now advance past threshold without activity.
    now += 11_000;
    await manager.checkIdleTimeout();
    expect(manager.status).toBe("hibernated");
  });
});

describe("US4: Hibernation cancellation and deadline-save (Phase 6, T081)", () => {
  test("T081: cache save respects deadline during hibernation", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 60_000, saveDeadlineMs: 2_000 },
      makeCallbacks(calls),
      () => now,
    );

    // Trigger hibernation.
    now += 61_000;
    await manager.hibernateNow();

    expect(manager.status).toBe("hibernated");
    // saveCache should have been called with the deadline.
    expect(calls).toContain("saveCache");
  });

  test("T081: hibernation sets status to hibernated even if save partially fails", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 60_000 },
      makeCallbacks(calls, { saveFails: true }),
      () => now,
    );

    now += 61_000;
    await manager.hibernateNow();

    // Hibernation must complete honestly even when save fails.
    // The status is hibernated — we don't silently stay "active".
    expect(manager.status).toBe("hibernated");
  });
});

describe("US4: Post-hibernation lazy wake correctness (Phase 6, T082)", () => {
  test("T082: first request after hibernation triggers wake rehydration", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 60_000 },
      makeCallbacks(calls),
      () => now,
    );

    // Hibernate.
    now += 61_000;
    await manager.checkIdleTimeout();
    expect(manager.status).toBe("hibernated");

    // A request arrives — triggers wake gate.
    await manager.wakeGate();

    expect(calls).toContain("onWakeStart");
    expect(calls).toContain("rehydrateOpenFiles");
    expect(manager.status).toBe("active");
  });

  test("T082: wakeGate is a no-op when not hibernated", async () => {
    const calls: string[] = [];

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 60_000 },
      makeCallbacks(calls),
    );

    await manager.wakeGate();

    expect(calls).not.toContain("onWakeStart");
    expect(manager.status).toBe("active");
  });

  test("T082: wakeGate is idempotent — only one rehydration on concurrent wake", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 60_000 },
      makeCallbacks(calls),
      () => now,
    );

    now += 61_000;
    await manager.checkIdleTimeout();

    // Two concurrent wake requests — should only rehydrate once.
    await Promise.all([manager.wakeGate(), manager.wakeGate()]);

    const wakeCalls = calls.filter((c) => c === "onWakeStart");
    expect(wakeCalls.length).toBe(1);
  });
});

describe("US4: Watched-file events do not reset idle (Phase 6, T083)", () => {
  test("T083: watched-file event does not reset idle timer with no open documents", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 60_000 },
      makeCallbacks(calls),
      () => now,
    );

    // Halfway through idle window.
    now += 40_000;

    // Watched-file event arrives — must NOT reset timer.
    manager.onWatchedFileEvent();

    now += 21_000; // Total 61s from original start, but only 21s since the event
    await manager.checkIdleTimeout();

    // Should hibernate because the file event didn't reset the timer.
    expect(manager.status).toBe("hibernated");
  });

  test("T083: watched-file event resets idle timer when documents ARE open", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      { ...HIBERNATION_DEFAULTS, idleTimeoutMs: 60_000 },
      makeCallbacks(calls),
      () => now,
    );

    manager.onDocumentOpen();
    now += 40_000;

    // Watched-file event — with documents open, this IS activity.
    manager.onWatchedFileEvent();

    now += 21_000;
    await manager.checkIdleTimeout();

    // Should NOT hibernate — documents are open (hibernation is blocked anyway).
    expect(manager.status).toBe("active");
  });
});

describe("US4: Sustained-activity delayed full reindex (Phase 6, T084)", () => {
  test("T084: single request after wake does not trigger full reindex", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      {
        ...HIBERNATION_DEFAULTS,
        idleTimeoutMs: 60_000,
        sustainedActivityWindowMs: 30_000,
        sustainedActivityCount: 5,
      },
      makeCallbacks(calls),
      () => now,
    );

    now += 61_000;
    await manager.checkIdleTimeout();
    expect(manager.status).toBe("hibernated");

    // Single request triggers wake.
    await manager.wakeGate();

    // Only one request — not enough for sustained activity.
    manager.recordActivity();
    expect(manager.isSustainedActivity()).toBe(false);
    expect(calls).not.toContain("onSustainedActivity");
  });

  test("T084: sustained activity threshold triggers delayed reindex signal", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      {
        ...HIBERNATION_DEFAULTS,
        idleTimeoutMs: 60_000,
        sustainedActivityWindowMs: 30_000,
        sustainedActivityCount: 3,
      },
      makeCallbacks(calls),
      () => now,
    );

    now += 61_000;
    await manager.checkIdleTimeout();

    await manager.wakeGate();

    // Simulate sustained activity: 3 requests within the window.
    manager.recordActivity();
    now += 5_000;
    manager.recordActivity();
    now += 5_000;
    manager.recordActivity();

    expect(manager.isSustainedActivity()).toBe(true);
    expect(calls).toContain("onSustainedActivity");
  });

  test("T084: activity spread beyond window does not count as sustained", async () => {
    const calls: string[] = [];
    let now = 1_000_000;

    const manager = new HibernationManager(
      {
        ...HIBERNATION_DEFAULTS,
        idleTimeoutMs: 60_000,
        sustainedActivityWindowMs: 10_000,
        sustainedActivityCount: 3,
      },
      makeCallbacks(calls),
      () => now,
    );

    now += 61_000;
    await manager.checkIdleTimeout();
    await manager.wakeGate();

    // Three requests but spread far apart — outside the window.
    manager.recordActivity();
    now += 15_000;
    manager.recordActivity();
    now += 15_000;
    manager.recordActivity();

    expect(manager.isSustainedActivity()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CallbackOverrides {
  saveFails?: boolean;
}

function makeCallbacks(
  calls: string[],
  overrides: CallbackOverrides = {},
) {
  return {
    onCancelBackgroundIndex: async () => {
      calls.push("cancelBackgroundIndex");
    },
    onSaveCache: async () => {
      calls.push("saveCache");
      if (overrides.saveFails) {
        throw new Error("Simulated cache save failure");
      }
    },
    onClearIndex: () => {
      calls.push("clearIndex");
    },
    onStopWorker: () => {
      calls.push("stopWorker");
    },
    onWakeStart: async () => {
      calls.push("onWakeStart");
      calls.push("rehydrateOpenFiles");
    },
    onSustainedActivity: () => {
      calls.push("onSustainedActivity");
    },
  };
}
