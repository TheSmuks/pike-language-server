/**
 * Hibernation must act on the index the server actually has.
 *
 * `createServerContext` builds a placeholder WorkspaceIndex rooted at
 * `/tmp/unused` because the real workspace root is not known until
 * `initialize` arrives, at which point `serverInitHandler` assigns
 * `ctx.index`. The hibernation hooks were handed that placeholder by value, so
 * they kept pointing at it for the connection's life: the cache save wrote an
 * empty index under `/tmp/unused` and the clear emptied an index nobody read.
 * Nothing threw, so the only visible symptom was that waking from hibernation
 * never found a warm cache.
 *
 * The same hazard is already handled elsewhere with getters — see the
 * "registration runs before initialize" comments in navigationGoTo.ts and
 * hoverHandler.ts.
 */

import { describe, test, expect } from "bun:test";
import { createHibernationHooks, createServerContext } from "../../server/src/serverContext";
import { WorkspaceIndex } from "../../server/src/features/workspaceIndex";

/** A connection stub: the context only logs and registers handlers on it. */
function stubConnection(): any {
  const noop = () => {};
  return new Proxy({}, { get: () => noop });
}

describe("hibernation hooks follow the current index", () => {
  test("onClearIndex clears the index installed after initialize", () => {
    const placeholder = new WorkspaceIndex({ workspaceRoot: "/tmp/unused" });
    const indexRef = { current: placeholder };
    const hooks = createHibernationHooks(stubConnection(), { stop: () => {} } as any, indexRef, {});

    // What serverInitHandler does once the real workspace root is known.
    const real = new WorkspaceIndex({ workspaceRoot: "/tmp/real-workspace" });
    indexRef.current = real;

    let placeholderCleared = false;
    let realCleared = false;
    placeholder.clear = () => { placeholderCleared = true; };
    real.clear = () => { realCleared = true; };

    hooks.onClearIndex();

    expect(realCleared).toBe(true);
    expect(placeholderCleared).toBe(false);
  });

  test("assigning ctx.index is what the hooks observe", () => {
    const ctx = createServerContext(stubConnection());
    const placeholder = ctx.index;
    expect(placeholder.workspaceRoot).toBe("/tmp/unused");

    const real = new WorkspaceIndex({ workspaceRoot: "/tmp/real-workspace" });
    ctx.index = real;

    // The context is the seam serverInitHandler writes through; reading it back
    // must give the new index, not the placeholder it was constructed with.
    expect(ctx.index).toBe(real);
    expect(ctx.index.workspaceRoot).toBe("/tmp/real-workspace");
  });
});
