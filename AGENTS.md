# Project Context

This file is auto-discovered by AI coding agents. It provides project-level context that guides agent behavior.

## Project Overview

- **Name**: Pike Language Server
- **Description**: Tier-3 LSP implementation for Pike, using pike as oracle for semantic information and tree-sitter-pike as syntactic parser. VSCode as primary client.
- **Primary Language**: TypeScript 5.x, Node.js 22+

## Build & Run

```bash
# Install dependencies
bun install

# Build
bun run build

# Run tests
bun test

# Type check
bun run typecheck
```

## Code Style

Adapted from [TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md) — a style rooted in safety, performance, and developer experience, in that order.

Our design goals are safety, performance, and developer experience. In that order. All three are important. Good style advances these goals. Style is more than readability — readability is table stakes, a means to an end.

### Simplicity and Elegance

Simplicity is not a free pass. It is not a concession or a compromise. Simplicity is how we bring our design goals together, how we identify the "super idea" that solves the axes simultaneously.

Simplicity is not the first attempt but the hardest revision. It takes thought, multiple passes, many sketches. An hour or day of design is worth weeks or months in production.

### Technical Debt

What could go wrong? What's wrong? We prefer the former question, because code, like steel, is less expensive to change while it's hot. A problem solved in production is many times more expensive than a problem solved in implementation, or a problem solved in design.

We do not defer known defects. When we find showstoppers, we solve them. We may lack crucial features, but what we have meets our design goals. This is the only way to make steady incremental progress — knowing that the progress we have made is indeed progress.

### Safety

- Use **only very simple, explicit control flow**. Avoid deep nesting. Use **only a minimum of excellent abstractions** and only when they make the best sense of the domain. Every abstraction introduces the risk of a leaky abstraction.

- **Put a limit on everything.** All loops, queues, and buffers must have a fixed upper bound. Follow the fail-fast principle so violations are detected sooner rather than later.

- **Assertions detect programmer errors.** Unlike operating errors (which are expected and must be handled), assertion failures are unexpected. The only correct way to handle corrupt state is to crash. Assertions downgrade catastrophic correctness bugs into liveness bugs.
  - Assert function arguments, return values, preconditions, postconditions, and invariants. A function must not operate blindly on data it has not checked.
  - **Pair assertions.** For every property you enforce, find at least two code paths where an assertion can be added. For example, validate data right before writing it, and also immediately after reading it back.
  - Split compound assertions: prefer `assert(a); assert(b);` over `assert(a && b);`. The former is simpler to read and provides more precise failure information.
  - Use single-line `if` to assert an implication: `if (a) assert(b)`.
  - **Assert both the positive space** (what you expect) **and the negative space** (what you do not expect). Where data moves across the valid/invalid boundary is where interesting bugs are found.

- **Declare variables at the smallest possible scope** and minimize the number of variables in scope.

- **All errors must be handled.** An analysis of production failures in distributed systems found that 92% of catastrophic failures could have been prevented by correct handling of non-fatal errors. An unhandled error is a latent catastrophic failure.

- **Always motivate, always say why.** If you explain the rationale for a decision, it increases understanding, makes adherence more likely, and shares criteria for evaluating the decision.

- **Be explicit at call sites.** Pass options explicitly to library functions rather than relying on defaults. This avoids latent bugs if defaults change.

- Split compound conditions into simple conditions using nested `if/else`. Split complex `else if` chains into `else { if { } }` trees. Consider whether a single `if` needs a matching `else` branch to ensure both positive and negative spaces are handled.

- State invariants positively. Prefer `if (index < length)` over `if (index >= length)` — the positive form is easier to get right and understand.

### Performance

- Think about performance from the outset, in the design phase — precisely when you can't measure or profile. The best time to get 1000x wins is before code is written.
- Perform back-of-the-envelope sketches with respect to the resources involved (memory, CPU, I/O) and their characteristics (bandwidth, latency). Sketches are cheap. Use them to land within 90% of the global maximum.
- Amortize costs by batching. Give the runtime large enough chunks of work rather than forcing it to zig-zag.
- Be explicit. Minimize dependence on the runtime to do the right thing for you.

### Developer Experience

#### Naming

- **Get the nouns and verbs just right.** Great names capture what a thing is or does and provide a crisp mental model. Take time to find the right name.
- Do not abbreviate variable names. Use long form arguments in CLI: `--force`, not `-f`.
- Add units or qualifiers to variable names, and put them last, sorted by descending significance: `latencyMsMax` rather than `maxLatencyMs`. This groups related variables visually.
- Infuse names with meaning. `allocator: Allocator` is acceptable, but `gpa: Allocator` and `arena: Allocator` are excellent — they tell the reader whether `deinit` should be called.
- When choosing related names, try to find names with the same number of characters so related variables line up in the source.
- Think of how names will be used outside the code — in documentation, commit messages, and communication. A noun is often a better descriptor than a present participle because it composes more clearly for derived identifiers.
- Don't overload names with multiple context-dependent meanings.

#### Comments and Documentation

- Don't forget to say **why**. Code alone is not documentation. Use comments to explain why you wrote the code the way you did.
- Don't forget to say **how**. When writing a test, describe the goal and methodology at the top.
- Comments are sentences: capitalize, use punctuation. Inline comments after code can be phrases.
- Write descriptive commit messages that stand on their own in `git blame`. A PR description is not stored in git.

#### State and Scope

- Don't duplicate variables or take aliases to them. This reduces the probability that state gets out of sync.
- Calculate or check variables close to where they are used. Don't introduce variables before they are needed, don't leave them around where they are not. Most bugs come down to a semantic gap caused by distance in time or space.
- Use simpler function signatures and return types to reduce dimensionality at the call site. `void` trumps `boolean`, `boolean` trumps a complex object, a discriminated union trumps a nullable.

#### Off-By-One Errors

- The usual suspects are casual interactions between an **index**, a **count**, or a **length**. Treat them as distinct types with clear conversion rules: index (0-based) to count (1-based) requires +1; count to length/size requires multiplication by the unit. Including units and qualifiers in variable names makes this explicit.

### Function Shape

- There is a sharp discontinuity between a function fitting on a screen and having to scroll. For this physical reason, observe a **hard limit of 50 lines per function**.
- Centralize control flow. When splitting a large function, keep branching in the parent and move non-branchy logic to helpers. [Push `if`s up and `for`s down](https://matklad.github.io/2023/11/15/push-ifs-up-and-fors-down.html).
- Centralize state manipulation. Let the parent keep all relevant state in locals, use helpers to compute what needs to change. Keep leaf functions pure.
- Good function shape is often the inverse of an hourglass: a few parameters, a simple return type, and meaty logic in between.

### Module and File Size Guidelines

| Metric | Guideline | Action if exceeded |
|--------|-----------|-------------------|
| File length | 500 lines | Split into focused modules |
| Function/method length | 50 lines | Extract helpers |
| Module exports | 20 public symbols | Re-evaluate module boundary |
| Nesting depth | 4 levels | Flatten with early returns or extract |


## Project Structure

```
server/           # LSP server (TypeScript, vscode-languageserver-node)
client/          # VSCode extension that hosts the LSP server
harness/          # Test harness — invokes pike, captures ground truth, compares LSP output
corpus/           # Pike files covering language features the LSP must handle
  files/          # Actual Pike source files
  manifest.md     # Inventory of files and what features each exercises
docs/             # Investigation results, interface documentation
  decisions/      # Architecture Decision Records
decisions/        # Root-level decision documents
```

## Testing

- All new features must include tests
- Bug fixes must include regression tests
- Run the full test suite before submitting a PR
- Tests must be deterministic: no reliance on external services, wall-clock time, or random state unless explicitly controlled
- Test expected output must come from `pike`, not from hand-written expectations (canary tests are the sole exception)
- Prefer integration tests over mocks — mocks invent behaviors that never happen in production

## Error Handling

- **Do not suppress errors.** Catching an exception and continuing silently is a bug.
- **Errors must be distinguishable from success.** A function that returns plausible-looking output when it has failed has broken its contract with every caller.
- **Fail at the boundary.** Validate inputs at system edges (user input, network responses, file I/O). Trust internal code.
- **Wrap, don't expose.** When wrapping an error from a dependency, add context.
- **No lying.** If an operation partially fails, do not return a success result with some fields silently missing. Return an error or a structured result that preserves the truth.

## CI/CD

CI uses separate workflow files, one concern per file. See [docs/ci.md](./docs/ci.md) for the full guide.

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Lint, typecheck, test — project-specific jobs |
| `commit-lint.yml` | Conventional commit enforcement |
| `changelog-check.yml` | Changelog update enforcement (PRs only) |
| `blob-size-policy.yml` | Rejects oversized files (PRs only) |

## Agent Behavior

When an AI agent is working in this repository:

1. **Always create PRs for changes.** Do not push directly to `main`.
2. **Run available validation before requesting review.** Execute lint, type-check, and test commands before declaring work complete.
3. **Read before editing.** Read the full file or section before making changes.
4. **Check references before renaming.** Use `grep` or language-server tools to find every consumer of a symbol before changing it.
5. **One concern per change.** A PR should address one issue or feature. Do not bundle unrelated refactors.
6. **Update documentation in the same change.** If code behavior changes, update comments, doc strings, and relevant docs in the same commit.
7. **Preserve invariants.** If the codebase has patterns, follow them. Do not introduce a new pattern without removing the old one.
8. **Clean up after yourself.** Remove unused imports, dead code, and temporary files.


## Operating Principles

1. **Tests are ground truth.** Pike is the oracle. pike-ai-kb is the interface to the oracle. Every test derives expected output from pike.
2. **No phase begins until the previous phase is 100% complete.** "Mostly working" is not done.
3. **Specific failures, not category labels.** Describe failures precisely: input X produces output Y at position Z, when it should produce W.
4. **The test harness can be wrong.** Audit it. Canary tests catch harness bugs.
5. **Decisions go in decisions/.** Write the decision document before committing.
6. **Check pike-ai-kb before generating Pike code.** The knowledge base is runtime-verified; agent priors on Pike are unreliable.
7. **Consult docs/lsp-references.md before designing an LSP architectural pattern.** Other LSPs have solved most hard problems; understand their solutions before inventing your own.
8. **File findings in dependency projects.** When work surfaces a bug or limitation in tree-sitter-pike or pike-ai-kb, don't work around it silently. File an issue against the dependency. The issue must include: (a) a minimal reproduction, (b) expected vs actual behavior, (c) a link back to the LSP test or finding that surfaced it. Add a TODO in the LSP code or an entry in docs/known-limitations.md referencing the upstream issue URL. When the upstream fix lands, remove the workaround.

## Conventions

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`

### Branches

Follow [Conventional Branch](https://github.com/nickshanks347/conventional-branch) naming:

```
<type>/<short-description>
```

### Changelog

Follow [Keep a Changelog](https://keepachangelog.com/). Update `CHANGELOG.md` under `[Unreleased]` for every user-facing change.

## Template Version

This project was generated from `ai-project-template` version **0.2.0**. See [`.template-version`](./.template-version) for the current release.
