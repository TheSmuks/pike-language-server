# Roxen 6.1 lab

A reproducible Roxen environment, used for two things:

- **A parse oracle.** When the tree-sitter grammar reports an error on Roxen
  source, this decides whether the defect is in the grammar or in the source.
  Pike's compiler is the authority on what valid Pike is; the grammar is not.
- **A real install layout.** Roxen detection is tested against an actual
  installation at `/usr/local/roxen6`, not against a fixture we invented.

It is deliberately **not** a CI dependency. The Pike build costs 10–20 minutes,
which would trade a large, recurring cost for very little signal.

## Pinned revisions

| Component | Pin | Why |
|---|---|---|
| Roxen | `4f1d04f82b3ea95f680cddab552d4912990c9c2f` (`rxnpatch/6.1`) | The branch moves. Every measured corpus number, and `scripts/build-roxen-index.ts`, refer to this tree. |
| Pike | `v8.0.1116` release tarball, sha256 `5020063c…5891` | The version the development host runs, so the lab reproduces a known-working pairing rather than a speculative one. |

The Pike tarball is used rather than a git checkout because it ships a
generated `configure` (and the pre-generated `.cmod` output), so the build
depends on neither the host's autoconf version nor an existing Pike.

## Building and running

```sh
cd tools/roxen-lab
docker build -t pike-lsp/roxen-lab:6.1 .        # 10-20 min, mostly compiling Pike
```

Three modes:

```sh
# Compile files and report a verdict per file
docker run --rm -v /path/to/roxen:/corpus:ro pike-lsp/roxen-lab:6.1 \
  oracle --json /corpus/server/modules/tags/rxmltags.pike

# Start the Roxen server in the foreground
docker run --rm pike-lsp/roxen-lab:6.1 serve

# Poke around
docker run --rm -it pike-lsp/roxen-lab:6.1 shell
docker run --rm pike-lsp/roxen-lab:6.1 versions
```

## The oracle

`oracle.pike` compiles a file with Pike and reports one of four verdicts:

| Verdict | Meaning | What a tree-sitter ERROR on that file means |
|---|---|---|
| `ok` | Pike compiles it. | Grammar gap. |
| `semantic` | Parsed; failed on meaning (undefined identifier, bad type). | Grammar gap — it is syntactically valid. A Roxen module compiled outside the Roxen runtime lands here as a matter of course. |
| `cpp_error` | The preprocessor failed. | Macro-expansion gap: raw source is not what the compiler ever sees. |
| `syntax` | Pike's parser rejects it too. | The source is invalid. Not our defect. |

The verdict, not the error count, is what the triage reads.

## Two build details worth knowing

Both were found the hard way and are commented at the point of use in the
`Dockerfile`; repeated here because both look like arbitrary choices.

**Ubuntu, not Debian.** Pike 8.0's Mysql module refuses to build unless
`mysql.h`'s `MYSQL_VERSION_ID` and the client library's
`mysql_get_client_version()` agree. Debian ships only MariaDB Connector/C, where
they never do — measured here as header `101118` against runtime `30319`, after
which Pike silently installs a stub and Roxen hard-exits at startup. Ubuntu's
`libmysqlclient-dev` is Oracle MySQL, where both report `80046`.

**`pike_cv_working_z=yes`.** Pike's Gz module decides whether zlib works by
compiling and *running* a 1998 copy of zlib's `example.c`. Its `test_sync()`
asserts that `inflate()` returns `Z_DATA_ERROR` after `inflateSync()` skips a
damaged block; zlib 1.3 recovers from that block instead. The test exits 1, and
Pike installs a stub `Gz` — which `Roxen.pmod` uses unconditionally. Nothing is
wrong with zlib; the probe encodes behaviour zlib stopped having. This also
explains why a stock Pike built on any modern distribution has no `Gz`.

## Known defect: Roxen does not finish starting

`serve` gets Roxen through its own MySQL bootstrap, brings up the configuration
database, installs `roxen_master`, and then fails compiling
`base_server/roxen.pike`:

```
etc/modules/Variable.pmod/Schedule.pike:3: Cannot inherit program in pass 2
  which is not fully compiled yet.
  (You probably have a cyclic symbol dependency that the compiler cannot handle.)
```

Roughly a dozen files under `etc/modules/Variable.pmod/` inherit
`Variable.Variable` from inside `Variable.pmod` itself, and Pike's two-pass
compiler will not resolve the cycle.

This is **not** a lab build defect, and the following were each tried and ruled
out:

- Pike `v8.0.1116` (release) and Pike `rxnpatch/8.0` at
  `b4ffaf995fbf17eb10f69fa42213589665f8b39b` (8.0.2029, the branch Roxen's own
  maintainers develop against) fail identically.
- It is not caused by `--remove-dumped`: a second start with precompiled code
  already present fails the same way.
- Every Pike module Roxen checks for at startup is present: `Mysql.mysql`,
  `Regexp.PCRE`, `Gz`, `Image.JPEG`, `Image.GIF`, `Crypto`, `Yabu`, `Search`.

Recorded as an open defect rather than an accepted limitation. It does not
affect either of the lab's two jobs: the oracle compiles individual files, and
the installed tree is what detection is tested against. What it does block is
the introspection route for extracting the Roxen API surface — see the open
question in `openspec/changes/roxen-support/design.md`, which assumed the source
route for exactly this reason.

## The corpus

`corpus-baseline.json` records which files the shipped grammar currently fails
to parse, and `corpus-triage.md` records the oracle's verdict on each.

```sh
bun run scripts/roxen-corpus-parse.ts                  # report failures
bun run scripts/roxen-corpus-parse.ts --check          # compare to the baseline
bun run scripts/roxen-corpus-parse.ts --write-baseline # re-record it
```

The corpus is a Roxen checkout, defaulting to `$ROXEN_CORPUS` and then
`/tank/projects/roxen-6.1`:

```sh
git clone --depth 1 --branch rxnpatch/6.1 \
  https://github.com/pikelang/Roxen.git roxen-6.1
```

Every tool that reads this tree must decode by detected encoding — 243 of its
442 Pike files are not UTF-8. Do not reach for `grep` either: it classifies
those files as binary and reports no matches rather than an error, which is how
an early survey undercounted `#include <module.h>` by a factor of six. Use
`grep -a`.
