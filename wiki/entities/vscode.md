---
title: VSCode
created: 2026-05-15
updated: 2026-05-15
type: entity
tags:
  - vscode
  - editor
  - client
sources:
  - raw/articles/architecture.md
  - raw/articles/deployment-context.md
  - raw/articles/other-editors.md
---

# VSCode

Visual Studio Code is the primary LSP client for the Pike Language Server.

## Overview

The Pike LSP is delivered as a VSCode extension, which hosts and manages the language server process.

## Key Integration Points

- **Extension hosts the server**: The VSCode extension is responsible for spawning, communicating with, and managing the lifecycle of the Pike language server.
- **Remote-SSH on shared server**: Development commonly occurs over VSCode's Remote-SSH extension, connecting to a shared server environment. The LSP must operate correctly in this remote context.
- **OutputChannel for logging**: Server logs and diagnostics are surfaced through a dedicated VSCode OutputChannel, providing a debug surface accessible to the user.

## Relationships

- [[pike]] -- The Pike programming language being edited and analyzed in VSCode.
- [[deployment-context]] -- The deployment environment details relevant to how the extension and server are distributed and run.
