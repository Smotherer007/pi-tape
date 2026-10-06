# pi-tape

**Record pi agent sessions, play them back deterministically, splice them into composable recipes — and then run and check them.**

An agent run is not reproducible. There is no stack trace, no breakpoint, and a
failure often happens exactly once. `pi-tape` records what the model and the
tools actually answered, plays it back deterministically, and distils repeated runs
into recipes you can search, compose, run and hand to someone else.

Three layers, each derived from the one below:

```
tapes (.tape)        →   recipes (.recipe.json)   →   a run, or a script
what happened once       what the procedure is        something that happened again
```

A recipe is not just a list of steps. It carries what could not be learned — typed
**gaps** (`secret`, `path`, `env`, `choice`, `free`), a credential replaced by
`[redacted]` rather than stored — and what a step needs and delivers, as
**contracts**. Those two are what make composition checkable: `splice` finds what k
recordings share, `link` says whether two different recordings fit together, and
`run` binds the gaps, probes the machine, executes and checks the result.

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
which is why it is the declared floor. Node 24 and 26 are tested as well.

As a pi package:

```bash
pi install npm:@patimweb/pi-tape
```

The published package ships a compiled `dist/` next to the TypeScript sources, and
both entry points — the `pi-tape` binary and the extension — point at the compiled
files. That is not decoration: node refuses to strip types for anything under
`node_modules`, so a package whose `bin` is a `.ts` file dies on its first line for
everybody who installs it. The sources are still shipped, because they are worth
reading and because pi loads TypeScript extensions fine from a checkout.

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

### Ask a different model the same questions

Replay serves recorded answers, so it proves the recording is intact; it says nothing
about a model upgrade. A **shadow run** serves the recording *and* asks another model
the same requests:

```
/tape shadow auth-refactor.tape --model anthropic/claude-sonnet-4-5
/model tape/<the recorded model>
<send the original first prompt>
/tape regress
# auth-refactor: old-model → new-model
#   14 request(s) · 9 identical · 2 structurally different · 3 only reworded
#   the comparison itself cost 41200 tokens
```

The comparison is strict about structure and lenient about wording, because a
different tool call is a different procedure and a rephrased sentence is not. It
costs real tokens, and it says so. Experimental: see
[Honest limits](#honest-limits).

### Splice tapes into a recipe

```bash
pi-tape splice a.tape b.tape c.tape --name frontend-setup --save
pi-tape library
pi-tape dub frontend-setup --set template=react@latest --set name=demo
pi-tape search "projekt aufsetzen" --budget 500
pi-tape index --write
pi-tape check frontend-setup
```

### Stitch parts of different tapes together

Parts that come from different recordings never ran in one session, so they are not
concatenated — they are **linked**, and the seam is either met or named:

```bash
pi-tape link dockerfile containerise deploy
# met
#   ✓ file Dockerfile  ← dockerfile
#   ✓ image api:latest  ← containerise
# probe before running: docker

pi-tape link containerise
# gaps — nothing in the chain provides these
#   ✗ file Dockerfile  (needed by containerise)
```

Every placeholder also says what kind of thing is missing, so a model filling it
knows whether to ask, probe or choose — and a credential never reaches the file:

```bash
pi-tape dub publish
# npm publish --token {{token}}
# unfilled [secret] token: supply token at run time — it was redacted from the
# recordings and is deliberately not stored
```

And a run has to say whether it worked, or it is not learned from:

```bash
pi-tape record --status success          # declare it
pi-tape record --redact                  # or hand the tape to someone else safely
pi-tape splice a.tape b.tape --save      # failed recordings stay out of the skeleton
```

### Carry a part into another composition

A step is one tool call, which is the right unit for aligning recordings and the
wrong unit for reuse. A **segment** is a range of steps plus an intent, so the part
that "adds the router" can travel into a different chain. Without cuts, `segment`
prints the numbered steps and their contracts — the material a model needs to
propose boundaries:

```bash
pi-tape segment service --cut 0-1 --intent "set the service up" --save
# segmenting "service" into 1 part(s)
#   service-aufsetzen  (steps 0-1)
#       needs command python, command pip
#       gives dir .venv, dependency {{package}}
# not in any segment: 2-3
```

### Run and verify

`run` binds the open gaps, probes the machine, executes and then checks what the
steps said they would deliver. Printing the plan is the default; executing is opt-in:

```bash
pi-tape run dockerfile containerise deploy
# 3 fragment(s): dockerfile → containerise → deploy
# probe
#   ✓ docker
# steps
#    0  write Dockerfile   → agent (write)
#    1  docker build -t api:latest .
#    2  docker run -p 8080:8080 api:latest
# this was a plan, nothing ran. pass --yes to execute it.

pi-tape run service --set package=fastapi --set port=8000 --yes
```

Four boundaries are stated rather than papered over: a **pi tool call** (`write`,
`read`) is not a shell command, so it stops the run and is named as the agent's job;
a **destructive step** is refused unless `--allow-dangerous`; a failing step stops the
run, because the rest was recorded in a world where it worked; and a condition that
cannot be checked here (`dependency`, `image`) is reported as **unverifiable**, never
as met.

And it provides **no environment**: no container, no version manager, no install.
Requirements are described, probed and refused when missing. Every one of those
alternatives would be a system dependency of its own, and a tool that promises
reproducibility by shipping opinions about containers has not removed the
dependency, it has moved it. The only thing pi-tape assumes is a POSIX shell — and
only when you ask it to execute something.

Inside pi, seven tools are registered — `tape_search`, `tape_show`, `tape_dub`,
`tape_check`, `tape_splice`, plus `tape_plan` (what a run would need, typed gaps
included) and `tape_segment` (cut a recipe into parts that can travel). The system
prompt tells the agent to consult them **before** searching the web or re-reading
files: a recipe lookup costs a few hundred tokens and no network, a web search costs
thousands.

## Commands

| Command | What it does |
|---|---|
| `sessions` | list pi session files, newest first |
| `record [session]` | session branch → `.tape` (infers the outcome, `--status` overrides) |
| `inspect <tape>` | run stats, per-tool context cost, biggest contributors, self-test |
| `verify <tape>` | walk the recording and report any gap |
| `diff <a> <b>` | first divergence between two runs |
| `splice <tape...>` | tapes → recipe (intersects when given several) |
| `link <recipe...>` | chain recipes and report the seam: met, gaps, what to probe |
| `rules` | list the rule packs — everything pi-tape assumes about command lines |
| `segment <name>` | cut a recipe into parts with an intent, so a part can travel |
| `run <recipe...>` | plan a chain, then execute and verify it with `--yes` |
| `library` / `show <name>` | list / show recipes with their parameters |
| `dub <name>` | render concrete steps with parameters applied, gaps typed |
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
- **Contracts are checked, not proven.** `link` shows that the artifacts line up —
  the file, the image, the dependency. It cannot show the result is correct, and a
  step with no contract is invisible to it.
- **`run` executes the template, not the original command line.** Redirections and
  quoting are preserved now, but a shell variable still becomes a slot, and anything
  the recorder could not express is missing from what runs. The plan shows a gap
  rather than an approximation, which is why gaps block a run.
- **Verification is only as strong as the contracts.** `run` checks files and
  directories. A dependency, an image or a running service needs a registry or a
  daemon, and is reported as unverifiable instead of assumed.
- **The safety gate is a floor, not a sandbox.** It refuses a small list of
  obviously destructive commands. A recorded command line is still a command line,
  and running one runs whatever was recorded.
- **No system dependencies, on purpose.** Recording, replay, splicing, linking,
  segmenting and planning need nothing but Node. The rule packs name tools; they do
  not need them. Running a procedure needs whatever that procedure needs — and says
  so before it starts.
- **Parameter detection needs a family, not a set of one-offs.** Two Vue runs and
  two React runs tell you which slots belong together; three unrelated runs do not.
  Orthogonality is reported so you can see whether the model carries.
- **Recipes are not a replacement for scripts.** For a deterministic procedure a
  script is exact, atomic and reviewable. Compile the recipe; do not execute it
  step by step in place of the script it should have become.
- **The regression suite is experimental.** `/tape shadow <file> --model <p>/<m>`
  replays a recording and asks another model the same requests, then
  `/tape regress` reports where they differ structurally. The comparison is tested;
  the provider glue around it is the least proven part of the project. The
  conservative pass also misses a credential written as bare prose, which is why
  `record --redact` is a layer and not a guarantee: read a tape before sharing it.
- **Not yet implemented:** forking from the UI, image payload replay, rule packs
  loaded from the store so a repository can describe its own tools.

## Development

```bash
npm test                    # 146 tests
npm run typecheck           # tsc --noEmit, clean
npm run build               # tsc -p tsconfig.build.json -> dist/ (needed only to publish)
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
src/redact.ts           gap kinds, credential detection, redaction
src/recipe-types.ts     recipe schema: steps, slots, parameters, contracts, outcome
src/recipe-extract.ts   one tape -> recipe                           <- heuristic
src/recipe-intersect.ts LCS alignment, skeleton, slots, parameters
src/outcome.ts          how a run ended, and why it may say so
src/rules.ts            rule packs: what an ecosystem knows about its commands
src/contract.ts         the engine: step -> conditions, and linking fragments
src/segment.ts          a range of steps + an intent
src/run.ts              bind, probe, execute, verify
src/recipe-store.ts     two-layer store, content-addressed index staleness
src/graph.ts            PageRank and Louvain over recipes and steps
src/recipe-query.ts     TF-IDF search under a token budget, compose, typed gaps
src/regress.ts          two answers compared: structure strict, wording lenient
src/freshness.ts        dependency validators: is this recipe still true
src/cli.ts              command line interface
extensions/             the pi extension: record, playback, shadow runs, seven tools
test/                   node:test, no framework
```

The package has **no runtime dependencies**. The extension declares its tool schemas
with `typebox`, which pi supplies to extensions, so it is a `peerDependencies` entry
with a `"*"` range rather than a dependency: a second physical copy could bypass pi's
extension module mapping and create duplicate registries. Nothing in the library
imports pi, so everything outside `extensions/` is testable without starting an
agent — and `npm audit --omit=dev` has nothing to report because there is nothing
installed.

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

A published version takes a few minutes to become visible: npm serves the package
document from a cache, so `npm view` can report the previous version for several
minutes after a successful release. That is propagation, not a failed publish — worth
knowing before concluding that the pipeline broke.

So commit messages are the release mechanism. `fix:` is a patch, `feat:` is a minor,
`feat!:` or a `BREAKING CHANGE:` footer is a major, and a push whose commits are
only `docs:`/`chore:`/`test:` publishes nothing at all — which is why a change
worth shipping has to say what it is.

One secret is needed, per repository — GitHub does not share secrets between repos:

| Secret | What it is |
|---|---|
| `NPM_TOKEN` | an npm automation token allowed to publish `@patimweb/*` |

Add it under Settings → Secrets and variables → Actions. `GITHUB_TOKEN` is provided
automatically.

What ships is small on purpose: `files` is an allowlist, so the tarball holds the
compiled `dist/`, the sources, the extension, the docs and the licence and nothing
else — no tests, no workflows, no dev tooling. `dist/` is built by
`prepublishOnly`, so publishing without compiling is not possible. `pi` is the only thing
that supplies a dependency at runtime, which means the published package installs
nothing of its own, even though the dev tree carries semantic-release and its
transitive dependencies.

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
| **segment** | a part of a recipe, with what it is for |
| **link** | do these parts fit? and where is the seam |
| **run** | bind the gaps, probe, execute, verify |
| **library** | the recipe store |
| **check** | has a recipe gone stale? |

A **rule pack** is the odd one out and is named for what it is: knowledge about a
tool, not a dependency on it. `pi-tape rules` shows the whole set.

Descriptive names are kept where the metaphor would obscure instead of clarify:
`inspect`, `verify`, `diff` and `search` say exactly what they do, and the internal
domain words — recipe, step, slot, parameter — stay literal on purpose. Theme where
it clarifies, plain where it does not.
