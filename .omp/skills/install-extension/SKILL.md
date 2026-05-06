---
name: install-extension
description: Build the Pike Language Server extension and install it into VSCode
category: workflow
tags: [build, extension, vscode, install, development]
version: 1.0.0
---

# Install Extension

Build and install the Pike Language Server extension into a local VSCode-compatible editor for testing.

## When to Use

Invoke this skill when:
- You need to test extension changes locally
- After making changes to client-side code (extension.ts, language config)
- After making changes to server-side code that affect the bundled output
- When asked to "install the extension" or "test in VSCode"

## Phase 1: Build and Install

Run the install script:

```bash
bash scripts/install-extension.sh
```

This runs typecheck → build → package VSIX → install into VSCode.

### Options

| Flag | Purpose |
|------|---------|
| `--skip-tests` | Skip typecheck (when you've already verified) |
| `--editor-cmd <path>` | Use a specific editor CLI instead of auto-detect |

### What the script does

1. **Typecheck** — `bun run typecheck` (catches type errors early)
2. **Build** — `bun run build:extension` (esbuild bundles client + server)
3. **Package** — `scripts/build-vsix.sh` (creates `.vsix` file)
4. **Detect** — finds `code`, `code-insiders`, or `codium` on PATH
5. **Install** — `code --install-extension pike-language-server-X.Y.Z.vsix`

## Phase 2: Verify

1. Open VSCode
2. Open any `.pike` file
3. Check status bar shows "Pike LSP" with zap icon
4. Open Output → "Pike Language Server" channel — should show activation logs

## Edge Cases

| Situation | Handling |
|-----------|----------|
| No editor CLI found | Exit code 2, print instructions to pass `--editor-cmd` |
| Build fails | Script exits with error — fix build before retrying |
| VSIX already installed | `--install-extension` force-reinstalls (idempotent) |
| Multiple editors installed | Uses first found: code → code-insiders → codium. Override with `--editor-cmd` |
| Server won't start after install | Check Output channel; verify `pike` is on PATH |

## What This Skill Does NOT Do

- Does not publish to the marketplace (see `cut-release` skill)
- Does not run the full test suite (see `cut-release/scripts/preflight.sh`)
- Does not modify source code
