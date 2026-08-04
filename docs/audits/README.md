# Architecture Audit History

Each iteration is a separate markdown file. Append new iterations rather than editing old ones.

| Iteration | Date | Scope | Status |
|-----------|------|-------|--------|
| [1](iteration-1.md) | 2026-05-15 | Full codebase | Complete — 26 findings fixed |
| [2](iteration-2.md) | 2026-05-16 | Full codebase | Complete — 41 findings fixed |
| [3](iteration-3.md) | 2026-05-16 | Full codebase | Complete — 32 findings fixed (1C/5H/13M/13L) |
| [4](iteration-4.md) | 2026-05-27 | Full codebase | Complete — 20 findings fixed (2C/3H/7M/8L) |
| [5](iteration-5.md) | 2026-05-27 | Full codebase | Complete — 34 findings fixed (1C/7H/14M/12L) |
| [6](iteration-6.md) | 2026-05-29 | Highlighting, formatting, code move, completion | Complete — 16 findings (4H/7M/5L) |
| [7](iteration-7.md) | 2026-07-30 | Behavioural sweep, all four surfaces | Superseded by iterations 8–9 — 14 distinct defects found (0C/7H/2M/5L) across 208,816 requests; their follow-up results are recorded in the later iterations |
| [8](iteration-8.md) | 2026-07-31 | Behavioural sweep, corpus + Roxen tiers | Corpus tier **complete — 0 findings** from 7,874 requests; Roxen 1,751 → 1,608; the freed-tree crash was closed in the documented amendment and iteration 9, with the remainder characterised |
| [9](iteration-9.md) | 2026-08-02 | v0.8.55/56 validation against real Roxen 6.1 | Corpus **held at 0 findings**, declined 125 → 33; Roxen survived 201,207 requests with 0 crashes and flat memory; Roxen's graph proved acyclic (repair phase two stays synthetic-only), closure max 14 → **17**, cap 64 confirmed safe; dependency refresh costs ~117 ms at the maximum; 2 defects fixed |
