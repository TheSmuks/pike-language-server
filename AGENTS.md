     1|# Project Context
     2|
     3|This file is auto-discovered by AI coding agents. It provides project-level context that guides agent behavior.
     4|
     5|## Project Overview
     6|
     7|- **Name**: Pike Language Server
     8|- **Description**: Tier-3 LSP implementation for Pike, using pike as oracle for semantic information and tree-sitter-pike as syntactic parser. VSCode as primary client.
     9|- **Primary Language**: TypeScript 5.x, Node.js 22+
    10|
    11|## Build & Run
    12|
    13|```bash
    14|# Install dependencies
    15|bun install
    16|
    17|# Build
    18|bun run build
    19|
    20|# Run tests
    21|bun test
    22|
    23|# Type check
    24|bun run typecheck
    25|```
    26|
    27|## Code Style
    28|
    29|Adapted from [TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md) — a style rooted in safety, performance, and developer experience, in that order.
    30|
    31|Our design goals are safety, performance, and developer experience. In that order. All three are important. Good style advances these goals. Style is more than readability — readability is table stakes, a means to an end.
    32|
    33|### Simplicity and Elegance
    34|
    35|Simplicity is not a free pass. It is not a concession or a compromise. Simplicity is how we bring our design goals together, how we identify the "super idea" that solves the axes simultaneously.
    36|
    37|Simplicity is not the first attempt but the hardest revision. It takes thought, multiple passes, many sketches. An hour or day of design is worth weeks or months in production.
    38|
    39|### Technical Debt
    40|
    41|What could go wrong? What's wrong? We prefer the former question, because code, like steel, is less expensive to change while it's hot. A problem solved in production is many times more expensive than a problem solved in implementation, or a problem solved in design.
    42|
    43|We do not defer known defects. When we find showstoppers, we solve them. We may lack crucial features, but what we have meets our design goals. This is the only way to make steady incremental progress — knowing that the progress we have made is indeed progress.
    44|
    45|### Safety
    46|
    47|- Use **only very simple, explicit control flow**. Avoid deep nesting. Use **only a minimum of excellent abstractions** and only when they make the best sense of the domain. Every abstraction introduces the risk of a leaky abstraction.
    48|
    49|- **Put a limit on everything.** All loops, queues, and buffers must have a fixed upper bound. Follow the fail-fast principle so violations are detected sooner rather than later.
    50|
    51|- **Assertions detect programmer errors.** Unlike operating errors (which are expected and must be handled), assertion failures are unexpected. The only correct way to handle corrupt state is to crash. Assertions downgrade catastrophic correctness bugs into liveness bugs.
    52|  - Assert function arguments, return values, preconditions, postconditions, and invariants. A function must not operate blindly on data it has not checked.
    53|  - **Pair assertions.** For every property you enforce, find at least two code paths where an assertion can be added. For example, validate data right before writing it, and also immediately after reading it back.
    54|  - Split compound assertions: prefer `assert(a); assert(b);` over `assert(a && b);`. The former is simpler to read and provides more precise failure information.
    55|  - Use single-line `if` to assert an implication: `if (a) assert(b)`.
    56|  - **Assert both the positive space** (what you expect) **and the negative space** (what you do not expect). Where data moves across the valid/invalid boundary is where interesting bugs are found.
    57|
    58|- **Declare variables at the smallest possible scope** and minimize the number of variables in scope.
    59|
    60|- **All errors must be handled.** An analysis of production failures in distributed systems found that 92% of catastrophic failures could have been prevented by correct handling of non-fatal errors. An unhandled error is a latent catastrophic failure.
    61|
    62|- **Always motivate, always say why.** If you explain the rationale for a decision, it increases understanding, makes adherence more likely, and shares criteria for evaluating the decision.
    63|
    64|- **Be explicit at call sites.** Pass options explicitly to library functions rather than relying on defaults. This avoids latent bugs if defaults change.
    65|
    66|- Split compound conditions into simple conditions using nested `if/else`. Split complex `else if` chains into `else { if { } }` trees. Consider whether a single `if` needs a matching `else` branch to ensure both positive and negative spaces are handled.
    67|
    68|- State invariants positively. Prefer `if (index < length)` over `if (index >= length)` — the positive form is easier to get right and understand.
    69|
    70|### Performance
    71|
    72|- Think about performance from the outset, in the design phase — precisely when you can't measure or profile. The best time to get 1000x wins is before code is written.
    73|- Perform back-of-the-envelope sketches with respect to the resources involved (memory, CPU, I/O) and their characteristics (bandwidth, latency). Sketches are cheap. Use them to land within 90% of the global maximum.
    74|- Amortize costs by batching. Give the runtime large enough chunks of work rather than forcing it to zig-zag.
    75|- Be explicit. Minimize dependence on the runtime to do the right thing for you.
    76|
    77|### Developer Experience
    78|
    79|#### Naming
    80|
    81|- **Get the nouns and verbs just right.** Great names capture what a thing is or does and provide a crisp mental model. Take time to find the right name.
    82|- Do not abbreviate variable names. Use long form arguments in CLI: `--force`, not `-f`.
    83|- Add units or qualifiers to variable names, and put them last, sorted by descending significance: `latencyMsMax` rather than `maxLatencyMs`. This groups related variables visually.
    84|- Infuse names with meaning. `allocator: Allocator` is acceptable, but `gpa: Allocator` and `arena: Allocator` are excellent — they tell the reader whether `deinit` should be called.
    85|- When choosing related names, try to find names with the same number of characters so related variables line up in the source.
    86|- Think of how names will be used outside the code — in documentation, commit messages, and communication. A noun is often a better descriptor than a present participle because it composes more clearly for derived identifiers.
    87|- Don't overload names with multiple context-dependent meanings.
    88|
    89|#### Comments and Documentation
    90|
    91|- Don't forget to say **why**. Code alone is not documentation. Use comments to explain why you wrote the code the way you did.
    92|- Don't forget to say **how**. When writing a test, describe the goal and methodology at the top.
    93|- Comments are sentences: capitalize, use punctuation. Inline comments after code can be phrases.
    94|- Write descriptive commit messages that stand on their own in `git blame`. A PR description is not stored in git.
    95|
    96|#### State and Scope
    97|
    98|- Don't duplicate variables or take aliases to them. This reduces the probability that state gets out of sync.
    99|- Calculate or check variables close to where they are used. Don't introduce variables before they are needed, don't leave them around where they are not. Most bugs come down to a semantic gap caused by distance in time or space.
   100|- Use simpler function signatures and return types to reduce dimensionality at the call site. `void` trumps `boolean`, `boolean` trumps a complex object, a discriminated union trumps a nullable.
   101|
   102|#### Off-By-One Errors
   103|
   104|- The usual suspects are casual interactions between an **index**, a **count**, or a **length**. Treat them as distinct types with clear conversion rules: index (0-based) to count (1-based) requires +1; count to length/size requires multiplication by the unit. Including units and qualifiers in variable names makes this explicit.
   105|
   106|### Function Shape
   107|
   108|- There is a sharp discontinuity between a function fitting on a screen and having to scroll. For this physical reason, observe a **hard limit of 50 lines per function**.
   109|- Centralize control flow. When splitting a large function, keep branching in the parent and move non-branchy logic to helpers. [Push `if`s up and `for`s down](https://matklad.github.io/2023/11/15/push-ifs-up-and-fors-down.html).
   110|- Centralize state manipulation. Let the parent keep all relevant state in locals, use helpers to compute what needs to change. Keep leaf functions pure.
   111|- Good function shape is often the inverse of an hourglass: a few parameters, a simple return type, and meaty logic in between.
   112|
   113|### Module and File Size Guidelines
   114|
   115|| Metric | Guideline | Action if exceeded |
   116||--------|-----------|-------------------|
   117|| File length | 500 lines | Split into focused modules |
   118|| Function/method length | 50 lines | Extract helpers |
   119|| Module exports | 20 public symbols | Re-evaluate module boundary |
   120|| Nesting depth | 4 levels | Flatten with early returns or extract |
   121|
   122|
   123|## Project Structure
   124|
   125|```
   126|server/           # LSP server (TypeScript, vscode-languageserver-node)
   127|client/          # VSCode extension that hosts the LSP server
   128|harness/          # Test harness — invokes pike, captures ground truth, compares LSP output
   129|corpus/           # Pike files covering language features the LSP must handle
   130|  files/          # Actual Pike source files
   131|  manifest.md     # Inventory of files and what features each exercises
   132|docs/             # Investigation results, interface documentation
   133|  decisions/      # Architecture Decision Records
   134|decisions/        # Root-level decision documents
   135|```
   136|
   137|## Testing
   138|
   139|- All new features must include tests
   140|- Bug fixes must include regression tests
   141|- Run the full test suite before submitting a PR
   142|- Tests must be deterministic: no reliance on external services, wall-clock time, or random state unless explicitly controlled
   143|- Test expected output must come from `pike`, not from hand-written expectations (canary tests are the sole exception)
   144|- Prefer integration tests over mocks — mocks invent behaviors that never happen in production
   145|
   146|## Error Handling
   147|
   148|- **Do not suppress errors.** Catching an exception and continuing silently is a bug.
   149|- **Errors must be distinguishable from success.** A function that returns plausible-looking output when it has failed has broken its contract with every caller.
   150|- **Fail at the boundary.** Validate inputs at system edges (user input, network responses, file I/O). Trust internal code.
   151|- **Wrap, don't expose.** When wrapping an error from a dependency, add context.
   152|- **No lying.** If an operation partially fails, do not return a success result with some fields silently missing. Return an error or a structured result that preserves the truth.
   153|
   154|## CI/CD
   155|
   156|CI uses separate workflow files, one concern per file. See [docs/ci.md](./docs/ci.md) for the full guide.
   157|
   158|| Workflow | Purpose |
   159||----------|---------|
   160|| `ci.yml` | Lint, typecheck, test — project-specific jobs |
   161|| `commit-lint.yml` | Conventional commit enforcement |
   162|| `changelog-check.yml` | Changelog update enforcement (PRs only) |
   163|| `blob-size-policy.yml` | Rejects oversized files (PRs only) |
   164|| `branch-cleanup.yml` | Deletes merged feature branches |
   165|
   166|## Agent Behavior
   167|
   168|Agents can invoke the `template-guide` skill (`.omp/skills/template-guide/SKILL.md` or Hermes skill `pike-template-guide`) to look up conventions, audit compliance, or get upgrade guidance. Agents can also invoke the `merge-to-main` skill (`.omp/skills/merge-to-main/SKILL.md` or Hermes skill `pike-merge-to-main`) to automate the PR lifecycle after completing feature work, and the `cut-release` skill (`.omp/skills/cut-release/SKILL.md` or Hermes skill `pike-cut-release`) to cut a new release with proper version bumping and GitHub release creation.
   169|
   170|When an AI agent is working in this repository:
   171|
   172|1. **Always create PRs for changes.** Do not push directly to `main`.
   173|2. **Run available validation before requesting review.** Execute lint, type-check, and test commands before declaring work complete.
   174|3. **Read before editing.** Read the full file or section before making changes.
   175|4. **Check references before renaming.** Use `grep` or language-server tools to find every consumer of a symbol before changing it.
   176|5. **One concern per change.** A PR should address one issue or feature. Do not bundle unrelated refactors.
   177|6. **Update documentation in the same change.** If code behavior changes, update comments, doc strings, and relevant docs in the same commit.
   178|7. **Preserve invariants.** If the codebase has patterns, follow them. Do not introduce a new pattern without removing the old one.
   179|8. **Clean up after yourself.** Remove unused imports, dead code, and temporary files.
   180|
   181|
   182|## Operating Principles
   183|
   184|1. **Tests are ground truth.** Pike is the oracle. pike-ai-kb is the interface to the oracle. Every test derives expected output from pike.
   185|2. **No phase begins until the previous phase is 100% complete.** "Mostly working" is not done.
   186|3. **Specific failures, not category labels.** Describe failures precisely: input X produces output Y at position Z, when it should produce W.
   187|4. **The test harness can be wrong.** Audit it. Canary tests catch harness bugs.
   188|5. **Decisions go in decisions/.** Write the decision document before committing.
   189|6. **Check pike-ai-kb before generating Pike code.** The knowledge base is runtime-verified; agent priors on Pike are unreliable.
   190|7. **Consult docs/lsp-references.md before designing an LSP architectural pattern.** Other LSPs have solved most hard problems; understand their solutions before inventing your own.
   191|8. **File findings in dependency projects.** When work surfaces a bug or limitation in tree-sitter-pike or pike-ai-kb, don't work around it silently. File an issue against the dependency. The issue must include: (a) a minimal reproduction, (b) expected vs actual behavior, (c) a link back to the LSP test or finding that surfaced it. Add a TODO in the LSP code or an entry in docs/known-limitations.md referencing the upstream issue URL. When the upstream fix lands, remove the workaround.
   192|9. **No silently ignored pre-existing defects.** When a pre-existing issue is discovered during work, you MUST either (a) file it as a GitHub issue with context, (b) fix it if within scope of the current task, or (c) document it explicitly in `docs/known-limitations.md` with a reason for deferral. Never pass silently. Triggers include: `test.skip`/`test.skipIf` without documented reason, commented-out tests, workarounds missing upstream issue links, bare `// TODO`/`// FIXME` comments without linked issues. The `pike-no-ignored-defects` skill has detailed examples.
   193|
   194|## Conventions
   195|
   196|### Commits
   197|
   198|Follow [Conventional Commits](https://www.conventionalcommits.org/):
   199|
   200|```
   201|<type>[optional scope]: <description>
   202|```
   203|
   204|Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`
   205|
   206|### Branches
   207|
   208|Follow [Conventional Branch](https://github.com/nickshanks347/conventional-branch) naming:
   209|
   210|```
   211|<type>/<short-description>
   212|```
   213|
   214|### Changelog
   215|
   216|Follow [Keep a Changelog](https://keepachangelog.com/). Update `CHANGELOG.md` under `[Unreleased]` for every user-facing change.
   217|
   218|## Template Version
   219|
   220|
   221|This project was generated from `ai-project-template` version **0.4.2**. See [`.template-version`](./.template-version) for the current release. Agents can read this file to determine which conventions and files to expect.
   222|