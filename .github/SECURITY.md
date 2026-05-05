# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

- **Do not** open a public issue.
- Contact [@TheSmuks](https://github.com/TheSmuks) directly or use GitHub's private vulnerability reporting feature.
- Include enough detail to reproduce and assess the issue.

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation within a reasonable timeframe.

## Scope

This policy applies to the Pike Language Server LSP implementation:

- The LSP server implementation (`server/`)
- The VSCode extension (`client/`)
- The test harness and corpus files (`harness/`, `corpus/`)

Third-party dependencies should be reported to their respective maintainers.

## Supported Versions

Security updates apply to the current stable release line. When a new major version is released, only the latest minor version of the previous major receives security patches.
