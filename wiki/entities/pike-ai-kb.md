---
title: pike-ai-kb
created: 2026-05-15
updated: 2026-05-15
type: entity
tags:
  - pike-ai-kb
  - mcp
  - oracle
sources:
  - raw/articles/pike-interface.md
  - raw/articles/decisions-0002-tier-3-scope.md
---

# pike-ai-kb

pike-ai-kb is an MCP (Model Context Protocol) server that acts as the oracle interface for the Pike Language Server, providing runtime introspection into a live Pike environment.

## Overview

pike-ai-kb exposes **7 tools** for querying Pike at runtime, including:

- `describe_symbol` -- Retrieve detailed information about a named symbol.
- `list_modules` -- Enumerate available Pike modules.
- *(and 5 additional tools for various introspection queries)*

These tools allow the LSP to answer semantic questions that cannot be resolved from static analysis alone.

## Role in the LSP

pike-ai-kb serves as the **oracle interface**: the LSP delegates runtime queries to it when syntactic analysis (via [[tree-sitter-pike]]) and static heuristics are insufficient.

## Gaps and Limitations

- **No predef resolution at C level**: Symbols defined in Pike's C-level predef cannot be introspected; only Pike-level definitions are visible.
- **Limited cross-file analysis**: Queries are scoped to the current Pike process state; cross-file references may be incomplete if the relevant files have not been loaded.

## Relationships

- [[pike]] -- The Pike programming language being introspected.
- [[pike-worker]] -- The worker process that may interface with pike-ai-kb for background queries.
- [[tier-3-lsp]] -- The tier-3 LSP scope that defines pike-ai-kb's role in the architecture.
- [[known-limitations]] -- Known gaps in what pike-ai-kb can introspect.
