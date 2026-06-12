# Data Model: Resource-Resilient Language Server

## IndexingMode

**Fields**
- `mode`: `openFiles` | `full` | `auto`.
- `fullScanFileLimit`: positive integer; default 500.
- `dependencyClosureDepthMax`: positive integer; default 5.
- `dependencyClosureFileCountMax`: positive integer; default 200.
- `ignoreGlobs`: ordered list of ignored directories/patterns.
- `sourceFileSizeBytesMax`: positive integer; default 1 MB.

**Validation**
- Unknown mode is rejected at initialization/configuration boundary.
- `auto` behaves like `full` only when discovery count is at or below `fullScanFileLimit`; otherwise it behaves like `openFiles` and logs the demotion.
- Limits must be finite and non-negative where `0` has documented disable semantics only.

**Relationships**
- Controls `BackgroundIndexJob`, dependency closure indexing, and global query preparation.

## CacheEntry

**Fields**
- `uri`: normalized file URI.
- `version`: document/index version.
- `contentHash`: existing hash key for current content identity.
- `mtimeMs`: source file modification time used for unchanged validation.
- `sizeBytes`: source file size used for unchanged validation.
- `dependencies`: normalized dependency URI list.
- `symbolTable`: serialized symbol data, optional when entry is stored as a stub.
- `formatVersion`: cache schema version through `cacheIndex.json`.

**Validation**
- Entry URI and content hash are required.
- Metadata is valid only when both `mtimeMs` and `sizeBytes` match the source file stat.
- Old-format entries missing metadata are upgraded by statting their source file on first load; corrupt, missing-source, duplicate, and superseded entries are dropped.
- After save, on-disk cache JSON count equals live entry count.

**Relationships**
- Can hydrate `IndexEntry` and update `DependencyMap`.

## DependencyMap

**Fields**
- `forwardEdges`: map from source URI to dependency URI set.
- `reverseEdges`: map from dependency URI to dependent URI set.
- `metadataByUri`: source metadata used to validate map entries.
- `generation`: monotonic mutation counter.

**Validation**
- URIs are normalized at insertion.
- Reverse edges are rebuilt or updated whenever forward edges change.
- Stale metadata invalidates the affected URI and dependents.

**Relationships**
- Survives `IndexEntry` demotion.
- Drives dependency closure, changed-file invalidation, global candidate discovery, and cross-file diagnostics.

## IndexEntry

**Fields**
- `uri`, `version`, `contentHash`, `pikeVersion`, `dependencies`, `lastModSource`, `stale` from existing `FileEntry`.
- `lifecycle`: `full` | `stub` | `demoted` | `loading`.
- `symbolTable`: present for `full`; absent for `stub`/`demoted`.
- `lastAccessMonotonicMs`: used for demotion choices.

**Validation**
- Open documents and their active dependency closure must remain `full` unless the file is explicitly stale/reloading.
- Demoted entries retain enough identity and dependency data to rehydrate from cache or source.
- `getSymbolTable` must not return stale or demoted data as success.

**State transitions**
- `missing -> loading -> full` for open/on-demand indexing.
- `full -> demoted` under memory pressure when not open and not in open dependency closure.
- `demoted -> loading -> full` on demand, unless degraded mode blocks new expansion.
- `full|demoted -> stub` during hibernation state save.
- `any -> missing` on deletion/cache invalidation.

## ResourceState

**Fields**
- `state`: `normal` | `indexing` | `degraded` | `hibernating` | `hibernated` | `waking`.
- `reason`: short machine-readable reason.
- `message`: user-facing honest message.
- `startedAtMs`: timestamp for persistent states.
- `heapUsedBytes`, `heapLimitBytes`, `entriesDemoted`: optional event metrics.

**Validation**
- Persistent states emit a client notification and log line.
- Routine states use status-bar updates, not modal notifications.
- Global features invoked while `degraded` return a protocol error/unavailable signal, not partial results.

## PikeWorkerSession

**Fields**
- `pid`: active child process id if running.
- `status`: `stopped` | `starting` | `ready` | `requestInFlight` | `wedged` | `backoff`.
- `lastRequestAtMs`: real request activity timestamp.
- `lastHeartbeatAtMs`: heartbeat send timestamp.
- `failedHealthChecks`: consecutive failed health checks.
- `consecutiveCrashes`, `crashBackoffUntilMs`.
- `watchdogWindowMs`: default 30,000.

**Validation**
- Request timeout kills/restarts the worker and rejects pending requests.
- Missed health-check threshold kills/restarts with backoff.
- Heartbeats do not reset idle eviction or hibernation.
- A stopped worker receives no heartbeat.

## HibernationState

**Fields**
- `status`: `active` | `hibernating` | `hibernated` | `waking`.
- `idleTimeoutMs`: default 900,000; `0` disables.
- `saveDeadlineMs`: bounded save deadline.
- `lastRealActivityAtMs`: updated by requests and open-document activity.
- `openDocumentCount`: open document count.

**Validation**
- Watched-file events do not reset idle when no documents are open.
- Hibernation stops Pike, clears in-memory caches, and does not exit the Node process.
- First post-hibernation request rehydrates lazily through normal on-demand paths.
