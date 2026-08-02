/**
 * Repair of open documents whose workspace-index entry was left empty.
 *
 * Indexing a file invalidates its dependents (`rewireDependents`) so the
 * synchronous inheritance/include wiring re-runs against the now-available
 * target. For a file the server only reads lazily that is enough: the next
 * query routed through `getOrIndexSymbolTable` rebuilds it from disk. An
 * *open* document has no such trigger — nothing re-indexes it until the user
 * edits it, so its entry would sit `stale` with a null symbol table for the
 * rest of the session and every consumer that reads index entries directly
 * instead of through the on-demand path would silently skip it:
 * `workspace/symbol`, cross-file references, call/type hierarchy, and cache
 * persistence.
 *
 * The repair runs on open, never per keystroke, so the stale-mark plus
 * lazy-rebuild design that keeps editing cheap is untouched.
 *
 * Order is what makes it cheap. Repairing a document rewires its own
 * dependents, so repairing a base class after its subclass leaves the subclass
 * stale again. Repaired dependencies-first, every invalidation lands on a
 * document still ahead in the order and an acyclic graph settles in exactly one
 * upsert per document — where repeating whole passes until nothing was stale
 * cost cubically many upserts in the number of open documents.
 */

import type { TextDocument } from "vscode-languageserver-textdocument";
import type { ServerContext } from "../serverContext";
import { logWarn } from "../util/errorLog";

/** Re-index a document fully: invalidate, upsert, rewire its dependents. */
export type ReindexFn = (doc: TextDocument) => Promise<void>;
/** Install a symbol table for a document without touching any other entry. */
export type ReinstallFn = (doc: TextDocument) => Promise<void>;

/**
 * How many times one scheduled repair may restart because another caller asked
 * for a repair while it was running. Each restart covers every caller that
 * arrived during the previous round, so this bound is generous.
 */
const MAX_REPAIR_ROUNDS = 4;

/**
 * How long a scheduled repair waits after the most recent request.
 *
 * An editor restoring a session opens every document in one burst, and each
 * open invalidates the ones that inherit it. Starting immediately would run a
 * pass per open, each walking every open document — quadratically many upserts
 * for one burst. Deferring until the requests stop lets the whole burst
 * collapse into a single pass. The repair is background work behind on-demand
 * resolution, so the delay costs nothing a user can observe.
 */
const REPAIR_COALESCE_MS = 50;

/**
 * Cap on the total deferral, so a workspace that keeps opening documents
 * cannot starve the repair indefinitely.
 */
const MAX_REPAIR_DELAY_MS = 1_000;

/** Deferral slices, bounding the wait loop. MAX_REPAIR_DELAY_MS / 50 + slack. */
const MAX_COALESCE_WAITS = 32;

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Order documents so that a document's dependencies come before it.
 *
 * Iterative post-order depth-first search over the index's forward dependency
 * edges. Only the given documents are emitted; files walked through on the way
 * (a dependency nobody has open) just order the ones that are. A back edge —
 * a dependency cycle — is skipped rather than followed, so the walk terminates
 * and the cycle's members come out in an arbitrary but stable relative order.
 */
export function orderByDependenciesFirst(
  ctx: ServerContext,
  docs: TextDocument[],
): TextDocument[] {
  const byUri = new Map(docs.map((d) => [d.uri, d]));
  const ordered: TextDocument[] = [];
  const done = new Set<string>();
  const onPath = new Set<string>();
  const stack = docs.map((d) => ({ uri: d.uri, expanded: false }));

  // Bounded: a URI is expanded at most once (guarded by `done`/`onPath`), and
  // each expansion pushes one frame per forward edge, so the loop runs at most
  // (nodes + edges) times over a finite graph.
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    if (done.has(frame.uri)) continue;

    if (frame.expanded) {
      done.add(frame.uri);
      onPath.delete(frame.uri);
      const doc = byUri.get(frame.uri);
      if (doc) ordered.push(doc);
      continue;
    }

    if (onPath.has(frame.uri)) continue;
    onPath.add(frame.uri);
    stack.push({ uri: frame.uri, expanded: true });
    pushUnvisitedDependencies(ctx, frame.uri, done, onPath, stack);
  }

  return ordered;
}

function pushUnvisitedDependencies(
  ctx: ServerContext,
  uri: string,
  done: Set<string>,
  onPath: Set<string>,
  stack: Array<{ uri: string; expanded: boolean }>,
): void {
  for (const dep of ctx.index.getFile(uri)?.dependencies ?? []) {
    if (done.has(dep)) continue;
    if (onPath.has(dep)) continue; // back edge — a dependency cycle
    stack.push({ uri: dep, expanded: false });
  }
}

// ---------------------------------------------------------------------------
// Repair
// ---------------------------------------------------------------------------

/** Open documents whose entry is stale and has no upsert already in flight. */
function staleOpenDocuments(ctx: ServerContext): TextDocument[] {
  return ctx.documents.all().filter(
    (doc) => ctx.index.isStale(doc.uri) && !ctx.upsertInFlight.has(doc.uri),
  );
}

/**
 * Bring every stale open document back to a populated symbol table.
 *
 * Two phases, because dependency order alone cannot settle a cycle: with
 * `a.pike` and `b.pike` inheriting each other, repairing either one empties the
 * other, forever. Phase one repairs in dependency order, which is all an
 * acyclic graph needs. Phase two installs a table for whatever a cycle left
 * behind *without* rewiring dependents — that cannot invalidate anything, so it
 * always terminates, and by then every cycle member's dependencies do hold
 * tables, so the wiring it builds is complete.
 */
export async function repairStaleOpenDocuments(
  ctx: ServerContext,
  reindex: ReindexFn,
  reinstall: ReinstallFn,
): Promise<void> {
  const initial = staleOpenDocuments(ctx);
  if (initial.length === 0) return;

  for (const doc of orderByDependenciesFirst(ctx, initial)) {
    if (!ctx.index.isStale(doc.uri)) continue;
    if (ctx.upsertInFlight.has(doc.uri)) continue;
    await reindex(doc);
  }

  for (const doc of staleOpenDocuments(ctx)) {
    await reinstall(doc);
  }

  const unresolved = staleOpenDocuments(ctx);
  if (unresolved.length === 0) return;
  logWarn(
    ctx.connection,
    `[index] repair left ${unresolved.length} open document(s) without a symbol ` +
    `table: ${unresolved.map((d) => d.uri).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Run a repair, coalescing concurrent requests into one.
 *
 * Both the post-open upsert and the dependency-closure walk ask for a repair,
 * and several documents can be opened in the same tick. Without coalescing that
 * is one full pass over the open documents per request. A request that arrives
 * while a pass is running sets `rerun` instead, so its invalidation is covered
 * by one more round rather than by a pass of its own.
 */
/**
 * Defer until REPAIR_COALESCE_MS have passed since the most recent request,
 * or MAX_REPAIR_DELAY_MS since the first, whichever comes first.
 */
async function waitForRequestsToStop(
  state: ServerContext["indexRepair"],
): Promise<void> {
  const deadline = Date.now() + MAX_REPAIR_DELAY_MS;
  // Bounded by MAX_COALESCE_WAITS: every iteration sleeps at least until the
  // last request plus the coalescing window, and the cap ends it regardless.
  for (let slice = 0; slice < MAX_COALESCE_WAITS; slice++) {
    const remaining = Math.min(
      state.requestedAt + REPAIR_COALESCE_MS - Date.now(),
      deadline - Date.now(),
    );
    if (remaining <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

export function scheduleIndexRepair(
  ctx: ServerContext,
  reindex: ReindexFn,
  reinstall: ReinstallFn,
): Promise<void> {
  const state = ctx.indexRepair;
  state.requestedAt = Date.now();
  if (state.inFlight) {
    state.rerun = true;
    return state.inFlight;
  }

  const run = (async () => {
    try {
      await waitForRequestsToStop(state);
      // Bounded by MAX_REPAIR_ROUNDS: each round clears `rerun` before the pass
      // it covers, so only requests that arrive mid-pass can ask for another.
      for (let round = 0; round < MAX_REPAIR_ROUNDS; round++) {
        state.rerun = false;
        await repairStaleOpenDocuments(ctx, reindex, reinstall);
        if (!state.rerun) return;
      }
    } finally {
      state.inFlight = null;
      state.rerun = false;
    }
  })();

  state.inFlight = run;
  return run;
}
