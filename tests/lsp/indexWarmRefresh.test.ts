/**
 * Regression tests for cold workspace-index refresh wiring.
 *
 * The bug was not that CodeLens/reference counting was wrong once the index was
 * warm; it was that VS Code was never asked to re-request index-dependent
 * features after background indexing made dependencies available.
 *
 * These drive createIndexWarmRefresh directly with fakes. An earlier version of
 * this file asserted that certain strings appeared in the source of
 * serverLifecycle.ts, which stopped meaning anything the moment the wiring moved
 * into its own module — and would have passed just as happily on dead code.
 */

import { describe, test, expect } from "bun:test";
import {
  createIndexWarmRefresh,
  type IndexWarmRefreshContext,
} from "../../server/src/features/indexWarmRefresh";

const DEBOUNCE_MS = 200;
/** Wait past the module's internal debounce window. */
const afterDebounce = () => new Promise((r) => setTimeout(r, DEBOUNCE_MS + 100));

/** Everything the fakes record. Held in one object so counters stay shared. */
interface RefreshState {
  requests: string[];
  semanticRefreshes: number;
  diagnosticsRefreshed: string[];
  rewired: string[];
}

interface Harness {
  ctx: IndexWarmRefreshContext;
  state: RefreshState;
}

/**
 * Build a refresh context over fake collaborators.
 *
 * @param dependents  newly-indexed uri → uris that depend on it
 * @param openUris    documents the editor currently has open
 */
function makeHarness(
  dependents: Record<string, string[]>,
  openUris: string[],
  opts: { clientSupportsSemanticTokensRefresh?: boolean } = {},
): Harness {
  const state: RefreshState = {
    requests: [],
    semanticRefreshes: 0,
    diagnosticsRefreshed: [],
    rewired: [],
  };

  const ctx = {
    connection: {
      sendRequest: (method: string) => {
        state.requests.push(method);
        return Promise.resolve();
      },
      languages: {
        semanticTokens: {
          refresh: () => {
            state.semanticRefreshes += 1;
            return Promise.resolve();
          },
        },
      },
    },
    documents: {
      all: () => openUris.map((uri) => ({ uri })),
    },
    index: {
      getDependents: (uri: string) => dependents[uri] ?? [],
      rewireDependents: (uri: string) => {
        state.rewired.push(uri);
        return dependents[uri] ?? [];
      },
    },
    clientSupportsSemanticTokensRefresh:
      opts.clientSupportsSemanticTokensRefresh ?? true,
    diagnosticManager: {
      onDidChange: (uri: string) => {
        state.diagnosticsRefreshed.push(uri);
      },
    },
  } as unknown as IndexWarmRefreshContext;

  return { state, ctx };
}

describe("index-warm refresh wiring", () => {
  test("background indexing refreshes affected open documents", async () => {
    const h = makeHarness({ "file:///dep.pike": ["file:///open.pike"] }, ["file:///open.pike"]);
    const refresh = createIndexWarmRefresh(h.ctx);

    refresh.onFileIndexed("file:///dep.pike");

    // Debounced: nothing has fired yet.
    expect(h.state.requests).toEqual([]);

    await afterDebounce();

    expect(h.state.requests).toEqual(["workspace/codeLens/refresh"]);
    expect(h.state.semanticRefreshes).toBe(1);
    expect(h.state.diagnosticsRefreshed).toEqual(["file:///open.pike"]);
  });

  test("does not refresh when no dependent is open", async () => {
    const h = makeHarness({ "file:///dep.pike": ["file:///closed.pike"] }, []);
    const refresh = createIndexWarmRefresh(h.ctx);

    refresh.onFileIndexed("file:///dep.pike");
    await afterDebounce();

    expect(h.state.requests).toEqual([]);
    expect(h.state.semanticRefreshes).toBe(0);
    expect(h.state.diagnosticsRefreshed).toEqual([]);
  });

  test("coalesces a batch of indexed files into a single refresh", async () => {
    const h = makeHarness(
      {
        "file:///a.pike": ["file:///open.pike"],
        "file:///b.pike": ["file:///open.pike"],
        "file:///c.pike": ["file:///open.pike"],
      },
      ["file:///open.pike"],
    );
    const refresh = createIndexWarmRefresh(h.ctx);

    // A workspace scan indexes many files in quick succession.
    refresh.onFileIndexed("file:///a.pike");
    refresh.onFileIndexed("file:///b.pike");
    refresh.onFileIndexed("file:///c.pike");
    await afterDebounce();

    // One refresh per batch, not one per file.
    expect(h.state.requests).toEqual(["workspace/codeLens/refresh"]);
    expect(h.state.semanticRefreshes).toBe(1);
    expect(h.state.diagnosticsRefreshed).toEqual(["file:///open.pike"]);
  });

  test("skips semantic-tokens refresh when the client does not support it", async () => {
    const h = makeHarness(
      { "file:///dep.pike": ["file:///open.pike"] },
      ["file:///open.pike"],
      { clientSupportsSemanticTokensRefresh: false },
    );
    const refresh = createIndexWarmRefresh(h.ctx);

    refresh.onFileIndexed("file:///dep.pike");
    await afterDebounce();

    expect(h.state.semanticRefreshes).toBe(0);
    // CodeLens refresh is unconditional and must still happen.
    expect(h.state.requests).toEqual(["workspace/codeLens/refresh"]);
  });

  test("cancel() drops a pending refresh", async () => {
    const h = makeHarness({ "file:///dep.pike": ["file:///open.pike"] }, ["file:///open.pike"]);
    const refresh = createIndexWarmRefresh(h.ctx);

    refresh.onFileIndexed("file:///dep.pike");
    refresh.cancel();
    await afterDebounce();

    expect(h.state.requests).toEqual([]);
    expect(h.state.semanticRefreshes).toBe(0);
  });

  test("newly indexed files invalidate dependents for inheritance rewire", () => {
    const h = makeHarness({ "file:///base.pike": ["file:///derived.pike"] }, ["file:///derived.pike"]);
    const refresh = createIndexWarmRefresh(h.ctx);

    refresh.onFileIndexed("file:///base.pike");

    // Rewiring is immediate — the next analysis must see the new target table
    // even if the debounced UI refresh has not fired yet.
    expect(h.state.rewired).toEqual(["file:///base.pike"]);
    refresh.cancel();
  });
});
