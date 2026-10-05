# pi-tape

**Record pi agent sessions, play them back deterministically, and splice them into composable recipes.**

An agent run is not reproducible. There is no stack trace, no breakpoint, and a
failure often happens exactly once. `pi-tape` records what the model and the
tools actually answered, plays it back deterministically, and distils repeated runs
into recipes you can search, compose and hand to someone else.

Three layers, each derived from the one below:

```
tapes (.tape)        →   recipes (.recipe.json)   →   scripts / skills
what happened once       what the procedure is        the compiled artefact
```

```
╭─ tape "next big thing" sha256:825d832bed7b
│ format      pi-tape v1 (profile: normal)
│ size        145.6 KiB on disk · 140 pooled strings · 116 entries
╰─

Run
  messages    108 (4 user, 43 assistant, 60 tool results)
  tokens      3,179,678 (72,970 in / 50,196 out)
  cost        $0.1005

Context cost per tool (result characters)
  bash            28 calls  ████████████████████████ 58,357 chars (~14,589 tok)

Self-test
  ✓ tape is complete
```

## Why a tape plays back exactly

An LLM call is a pure function of its prefix. Hash the prefix (messages plus tool
declarations, minus timestamps and usage counters) and you have a cache key. Record
the answers, then serve them instead of calling a provider.

The useful property is **forking**. Because lookups are keyed by prefix, changing
one tool result at turn 7 invalidates only the requests after it. Everything before
comes from the cache; only the new branch costs real tokens.

## Why recipes compose

You cannot concatenate two tapes — the second fragment's answers depend on a context
the first fragment never produced. So composition is **intersection**, not
concatenation: take k tapes of the same kind of task and compute what they share.
The shared part is the skeleton; the part that varied is a parameter.

```bash
pi-tape dub frontend-setup --set template=vue@latest --set name=demo
# npm create vue@latest demo
# npm install vue-router
# npm run build

pi-tape dub frontend-setup --set template=react@latest --set name=demo
# npm create react@latest demo
# npm install react-router-dom      <- swapped with it, because they co-vary
# npm run build
```

One parameter swap, no re-learning. That is the point: knowledge that multiplies
instead of accumulating. Details in [docs/RECIPES.md](docs/RECIPES.md).

## Install

Requires Node **22.18.0+** — the first 22.x that runs TypeScript without a flag,
which is why it is the declared floor. Node 24 and 26 are tested as well. No build
step.

As a pi package:

```bash
pi install npm:@patimweb/pi-tape
```

From a checkout:

```bash
git clone https://github.com/Smotherer007/pi-tape.git ~/pi-tape
cd ~/pi-tape
npm install
npm test

# try it for one invocation without installing
pi -e ~/pi-tape/extensions/index.ts
```

## Quickstart

### Record

```bash
pi-tape sessions                            # list sessions, newest first
pi-tape record                              # newest session -> ./<id>.tape
pi-tape record 01a10cda --name "auth refactor"
pi-tape record --profile minimal --out small.tape
```

Recording is derived from pi's own session file, so **every session you have ever
run can be recorded retroactively** — no extension required.

### Inspect

```bash
pi-tape inspect run.tape --timeline   # run stats, context cost per tool, self-test
pi-tape verify run.tape               # replay the tape against itself
pi-tape diff before.tape after.tape   # where two runs diverged
```

### Play back

```
/tape record baseline        # record the current run to a tape
/tape play baseline.tape     # arm playback
/model tape/<model>          # switch to the playback provider
<send the original first prompt>
/tape status                 # progress, misses, recorded cost
/tape stop                   # disarm (then /reload to restore real tools)
```

While replay is armed, tool calls are served from the recording **by tool call
id**, so the original side effects never run again. Nothing leaves the machine.

### Splice tapes into a recipe

```bash
pi-tape splice a.tape b.tape c.tape --name frontend-setup --save
pi-tape library
pi-tape dub frontend-setup --set template=react@latest --set name=demo
pi-tape search "projekt aufsetzen" --budget 500
pi-tape index --write
pi-tape check frontend-setup
```

Inside pi, five tools are registered (`tape_search`, `tape_show`,
`tape_dub`, `tape_check`, `tape_splice`) and the system prompt tells the
agent to consult them **before** searching the web or re-reading files: a recipe
lookup costs a few hundred tokens and no network, a web search costs thousands.

## Commands

| Command | What it does |
|---|---|
| `sessions` | list pi session files, newest first |
| `record [session]` | session branch → `.tape` |
| `inspect <tape>` | run stats, per-tool context cost, biggest contributors, self-test |
| `verify <tape>` | walk the recording and report any gap |
| `diff <a> <b>` | first divergence between two runs |
| `splice <tape...>` | tapes → recipe (intersects when given several) |
| `library` / `show <name>` | list / show recipes with their parameters |
| `dub <name>` | render concrete steps with parameters applied |
| `search <query>` | TF-IDF search over the store within a token budget |
| `index` | build the graph: families (Louvain), god steps (PageRank) |
| `check <name>` | run the recipe's dependency validators |
| `extension` | print the path for `pi -e` |

## The `.tape` format

Gzipped JSON, optionally readable by hand (plain JSON also loads). Full
specification: [docs/FORMAT.md](docs/FORMAT.md).

Two things do the compression work: gzip, and a string pool that stores each
distinct long string once. On a real session that is ~73 % smaller than the source
JSONL (84 % at the `minimal` profile).

Because a tape contains the tool *declarations* as well as the results, a
replay is self-contained: it needs neither your `settings.json`, nor your MCP
servers, nor your tool versions.

## The recipe format

Plain JSON in a two-layer store, project shadowing global:

```
~/.pi/agent/tape/recipes/     global
<project>/.tape/recipes/      project
```

Specification and design rationale: [docs/RECIPES.md](docs/RECIPES.md).

## How replay decides

1. **Hash** — recorded events are indexed by prefix hash. A matching request is
   served from the recording.
2. **Position** — when the hash misses (a fork changed the context, or a compaction
   rewrote it), the next unconsumed event of the right kind is served instead. A
   straight replay therefore still works with imperfect hashes.

Every miss is recorded, never silent. `/tape status` and `inspect` show them, which
is how you find out *why* a replay diverged.

## Honest limits

A debugger that lies is worse than none, so:

- **Tool overrides last for the process.** pi cannot unregister a tool, so leaving
  replay needs `/reload`. `/tape stop` makes the overrides refuse to run rather than
  pretend.
- **Compaction breaks hash matching**, not replay. After a compaction point lookups
  fall back to position.
- **Replayed answers report zero cost.** Token counts are kept so the shape of the
  run is visible; the money is zeroed so session totals stay honest.
- **Recipe extraction is heuristic.** A shell command is a string, not an AST. Step
  boundaries and slot names are interpretations, not facts.
- **Parameter detection needs a family, not a set of one-offs.** Two Vue runs and
  two React runs tell you which slots belong together; three unrelated runs do not.
  Orthogonality is reported so you can see whether the model carries.
- **Recipes are not a replacement for scripts.** For a deterministic procedure a
  script is exact, atomic and reviewable. Compile the recipe; do not execute it
  step by step in place of the script it should have become.
- **Not yet implemented:** forking from the UI, a regression suite across model
  upgrades, image payload replay, recipe compatibility contracts beyond the
  enumerated/free distinction.

## Development

```bash
npm test                    # 96 tests, no build step
npm run typecheck           # tsc --noEmit, clean
node src/cli.ts inspect …   # the CLI is the fastest way to poke at the library
```

```
src/session.ts          session JSONL parsing, tree navigation, branch points
src/hash.ts             prefix hashing: what is part of a request and what is noise
src/tape.ts             the .tape format: packing, string pool, validation
src/record.ts           session branch -> tape, record profiles
src/replay.ts           the replay engine (pure logic, independently testable)
src/stats.ts            run statistics, context cost per tool
src/inspect.ts          human-readable reports
src/diff.ts             divergence between two recordings
src/normalize.ts        actions -> normalized shapes and templates   <- heuristic
src/recipe-types.ts     recipe schema
src/recipe-extract.ts   one tape -> recipe                           <- heuristic
src/recipe-intersect.ts LCS alignment, skeleton, slots, parameters
src/recipe-store.ts     two-layer store, content-addressed index staleness
src/graph.ts            PageRank and Louvain over recipes and steps
src/recipe-query.ts     TF-IDF search under a token budget, compose
src/freshness.ts        dependency validators: is this recipe still true
src/cli.ts              command line interface
extensions/             the pi extension: record, playback, five recipe tools
test/                   node:test, no framework
```

The library has exactly one runtime dependency: `typebox`, which the extension
uses to declare its tool schemas. Nothing in the library itself imports pi, so
everything above `extensions/` is testable without starting an agent.

Type checking is a separate gate from the tests on purpose: the code ran green
while carrying type errors, and only `tsc` found them.

## Releasing

Two workflows, and no manual version bumps.

`ci.yml` runs on every push and pull request: the test suite on Node 22.18, 24 and
26, plus a type check. 22.18 is in the matrix because it is the version the package
declares as its floor — a floor that is never tested is a guess.

`release.yml` runs on `main` (and on `next` as a prerelease) and hands the work to
[semantic-release](release.config.cjs): it derives the next version from the commit
messages, publishes to npm with provenance, writes the changelog, opens the GitHub
release, and commits the version bump back with `[skip ci]`.

So commit messages are the release mechanism. `fix:` is a patch, `feat:` is a minor,
`feat!:` or a `BREAKING CHANGE:` footer is a major.

One secret is needed, per repository — GitHub does not share secrets between repos:

| Secret | What it is |
|---|---|
| `NPM_TOKEN` | an npm automation token allowed to publish `@patimweb/*` |

Add it under Settings → Secrets and variables → Actions. `GITHUB_TOKEN` is provided
automatically.

What ships is small on purpose: `files` is an allowlist, so the tarball holds the
sources, the extension, the docs and the licence and nothing else — no tests, no
workflows, no dev tooling. `typebox` is the only runtime dependency, which means the
published package has no vulnerable transitive dependencies even though the dev tree
has some from semantic-release. `npm audit --omit=dev` reports zero.

## Credits

The index design follows [pi-mindplace](https://github.com/Smotherer007/pi-mindplace)
(MIT) by Patrick Weppelmann. See [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) for
exactly what was borrowed and what was not.

## Name

A tape records a performance. This one records a run: the same decisions, the same
tool calls, the same output. You can play it back, hand it to someone else, and
splice several tapes of the same job into a master recipe that anyone can dub a
new variant from.

The vocabulary follows the metaphor, because a tool whose names say what they do is
worth more than a clever one:

| Term | Meaning |
|---|---|
| **tape** | the recording — one `.tape` file |
| **record** | a session → a tape |
| **play** | re-run a tape deterministically |
| **splice** | several tapes → one master recipe |
| **dub** | a recipe + parameter values → concrete steps |
| **library** | the recipe store |
| **check** | has a recipe gone stale? |

Descriptive names are kept where the metaphor would obscure instead of clarify:
`inspect`, `verify`, `diff` and `search` say exactly what they do, and the internal
domain words — recipe, step, slot, parameter — stay literal on purpose. Theme where
it clarifies, plain where it does not.
