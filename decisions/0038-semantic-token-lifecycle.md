# 0038 — Semantic-Token Lifecycle Uses Protocol Errors For Unavailability

**Date:** 2026-06-12
**Status:** Accepted
**Supplements:** 0018 (incremental parsing), 0037 (syntax color responsibility split)

## Context

VS Code treats a successful `textDocument/semanticTokens/full` response with
`data: []` as a semantic statement: the document has zero semantic tokens. It is
not an availability signal. Returning empty data while the parser is initializing,
the open document version has advanced beyond the indexed symbol table, or a
same-file edit is still being upserted tells VS Code to erase its semantic-token
model. That creates visible color loss and flicker even when the previous token
model was still valid for the editor to retain until the next successful answer.

Earlier fixes tried to preserve color with same-version token caches and
workspace refreshes. Those were symptoms fixes. A cache guarded by
`cached.version === doc.version` cannot help after typing because the document
version has already advanced past the cached payload. Per-keystroke
`workspace/semanticTokens/refresh` also creates extra request rounds that race
normal document synchronization.

## Decision

Semantic-token lifecycle unavailability is reported with the LSP protocol
vocabulary:

- If the request cannot produce tokens for the current open document because the
  document is missing mid-flight, the parser is not ready, parsing failed, or the
  symbol table is stale after one bounded wait for an in-flight upsert, the
  server throws `ResponseError(LSPErrorCodes.ContentModified, "content modified")`.
- If the request is cancelled, the server throws
  `ResponseError(LSPErrorCodes.RequestCancelled, "request cancelled")`.
- The server returns `data: []` only when token production succeeded and the
  current document genuinely has no semantic tokens.
- Same-file `didOpen` and `didChange` no longer request
  `workspace/semanticTokens/refresh`. VS Code already re-requests tokens for the
  edited document. Workspace refresh remains reserved for global invalidation,
  such as index warm completion or cross-file dependency changes.

Before declaring content modified, the handler makes exactly one honest attempt
to converge by awaiting an existing URI-specific upsert and then re-checking the
current document/table versions. There is no retry loop.

## Consequences

**Positive:**

- VS Code keeps the previous semantic-token model across edit races instead of
  clearing color on successful empty responses.
- The server response contract now distinguishes zero tokens from unavailable
  tokens.
- Same-file typing no longer triggers a semantic-token workspace refresh storm.
- Reopened documents still get immediate tokens through the direct current-text
  path when the workspace index is cold.

**Negative:**

- Clients that expected empty successful responses for stale tables now receive
  protocol errors. This is intentional: stale content is not a successful token
  result.
- Delta semantic-token support remains future work. This change fixes lifecycle
  correctness, not repaint optimization.

## Acceptance criteria

1. A stale table relative to the current open document produces
   `ContentModified`, never `{ data: [] }`.
2. A cancelled semantic-token request produces `RequestCancelled`.
3. Cold reopen still converges to non-empty tokens for a token-bearing document,
   including multiline hash-string content.
4. Same-file edit bursts produce either non-empty token data or protocol errors;
   no response is destructive empty data.
5. Same-file edit bursts send zero `workspace/semanticTokens/refresh` requests.
