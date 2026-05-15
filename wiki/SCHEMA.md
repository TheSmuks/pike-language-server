# Wiki Schema

## Domain

Pike Language Server -- architecture, design decisions, operational constraints, and known limitations for the tier-3 LSP implementation for the Pike programming language.

## Conventions

- File names: lowercase, hyphens, no spaces (e.g., `tier-3-lsp.md`)
- Every wiki page starts with YAML frontmatter (see below)
- Use `[[wikilinks]]` to link between pages (minimum 2 outbound links per page)
- When updating a page, always bump the `updated` date
- Every new page must be added to `index.md` under the correct section
- Every action must be appended to `log.md`
- Provenance markers: On pages that synthesize 3+ sources, append `^[raw/articles/source-file.md]` at the end of paragraphs whose claims come from a specific source.

## Frontmatter

```yaml
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query
tags: [from taxonomy below]
sources: [raw/articles/source-name.md]
confidence: high | medium | low
---
```

## raw/ Frontmatter

```yaml
---
source_url: <original path in docs/>
ingested: YYYY-MM-DD
sha256: <hex digest of the raw content below the frontmatter>
---
```

## Tag Taxonomy

- Architecture: architecture, design, component, module
- Decisions: adr, scope, decision
- Features: diagnostics, completion, hover, navigation, signature-help, semantic-tokens, inlay-hints, rename, type-inference, background-indexing
- Dependencies: pike, tree-sitter, pike-ai-kb, vscode
- Operations: ci, deployment, performance, caching
- Quality: audit, limitations, known-issue, upstream-issue
- Tooling: tooling, editor, neovim, helix

## Page Thresholds

- Create a page when an entity/concept appears in 2+ sources OR is central to one source
- Add to existing page when a source mentions something already covered
- Don't create a page for passing mentions
- Split a page when it exceeds ~200 lines

## Entity Pages

One page per notable entity (Pike, tree-sitter-pike, pike-ai-kb, VSCode). Include:

- Overview / what it is
- Key facts and relationship to the LSP
- Links to related concepts and decisions

## Concept Pages

One page per concept (tier-3-lsp, two-speed-diagnostics, etc.). Include:

- Definition / explanation
- Design rationale and decisions
- Open questions or known limitations
- Related concepts via wikilinks

## Comparison Pages

Side-by-side analyses. Include:

- What is being compared and why
- Dimensions of comparison (table format preferred)
- Verdict or synthesis

## Update Policy

When new information conflicts with existing content:

1. Check the dates -- newer sources generally supersede older ones
2. If genuinely contradictory, note both positions with dates and sources
3. Mark the contradiction in frontmatter: `contradictions: [page-name]`
4. Flag for user review
