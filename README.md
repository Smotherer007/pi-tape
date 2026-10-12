# pi-tape

![A pixel robot holding a data cassette](screenshot.png)

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

What that is good for, in one screen:

- **The second run costs less than the first.** The agent checks the store before it
  checks the web — a few hundred tokens, offline, and no answer from a blog post that
  may not be true any more.
- **A failure that happened once can be looked at twice.** Replay serves the recorded
  answers and replaces the recorded tool calls, so nothing leaves the machine, no
  provider is called, the original side effects do not run again, and the cost is zero.
- **A branch costs only what is new.** Requests are keyed by prefix, so
  `/tape fork <file> --model <p>/<m>` serves the recording while the context still
  matches and asks that model the moment it does not. A miss is logged, never
  answered silently with the old recording.
- **Knowledge multiplies instead of accumulating — in principle.** Take k recordings
  of one task: what they share is the procedure, what varied is a parameter. A
  framework swap then carries its router with it, because the two varied together.
  This layer is the youngest part of the project and is not yet backed by a
  measurement on real sessions; see [Honest limits](#honest-limits).
- **Composition is checkable, not hoped for.** Every step says what it needs and what
  it leaves behind, so "take part A and part B" has an answer: what is met, and what
  is a gap — with the gap named.
- **A tape can be handed to someone else.** Credentials are typed as gaps and
  redacted before the file is written, and a recording states how it ended, so nobody
  learns a procedure from a run that failed.

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
# pi-tape

**A debugger and experiment bench for pi agent runs: record a run, play it back
deterministically, fork it at any tool result, and test whether a change to the model
or to what the agent is told changes what it does.**

An agent run is not reproducible. There is no stack trace, no breakpoint, and a
failure often happens exactly once. `pi-tape` records what the model and the tools
actually answered, so a run can be looked at again, changed in one place, and compared
— without calling a provider for the parts that did not change, and without running
the original side effects a second time.

What it is for, in the order it has been shown to work:

- **A failure that happened once can be looked at twice.** Replay serves the recorded
  answers and replaces the recorded tool calls, so nothing leaves the machine, no
  provider is called, the original side effects do not run again, and the cost is zero.
  This holds across a compaction, at a different thinking level, and with parallel
  tool calls — checked against a real pi with a real model (see
  [What has been shown](#what-has-been-shown)).
- **"What if the tool had said something else?" has an answer.** `/tape fork … --at
  <turn> --result <text>` replaces one tool result and lets the model continue live
  from there. Everything before the intervention comes from the recording, so only the
  branch costs tokens. That is how a cause is confirmed instead of guessed: in the
  checked case, a wrong answer was traced to a stale note with one live request.
- **A change can be tested before it ships.** A model upgrade, or an edit to
  `AGENTS.md`, a skill or a prompt: `/tape shadow` replays a recorded run and asks the
  model at every recorded step what it would do *now*. `/tape regress` reports which
  decisions changed — strict about actions, lenient about wording and about what was
  merely looked at. Nothing is executed, so a deploy in the recording is not deployed
  again to find out.
- **A tape can be handed to someone else.** Credentials are typed as gaps and
  redacted before the file is written, and a recording states how it ended.

And one layer that is still an experiment:

- **Recipes — procedures distilled from several runs.** k recordings of one task are
  aligned; what they share becomes the procedure, what varied a parameter, and a step
  only some runs needed is kept with the condition under which it appeared. The first
  measurement did not show a saving; see [Recipes: an experiment](#recipes-an-experiment).

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

## Where this sits

Two lines of work are close to this one, and the differences are the point.

**Learning procedures from agent runs.** [Voyager](https://arxiv.org/abs/2305.16291)
(2023) let an agent keep a library of skills as code and reuse them.
[Agent Workflow Memory](https://arxiv.org/abs/2409.07429) (ICML 2025) induces reusable
workflows from past trajectories and gives them to later runs, with clear gains on web
benchmarks. [Agent Skill Induction](https://arxiv.org/abs/2504.06821) (2025) keeps skills
as programs and admits one only after it has been executed and shown to work. In all
three, a language model does the abstraction — flexible, and not inspectable. pi-tape's
recipe layer does it deterministically: alignment over the recorded calls, parameters
from what varied, conditions from what separated the runs. That is checkable, and it is
also brittle where a model would simply have understood; four bugs of exactly that kind
were found by measuring it (see below). The research measures its gains on long tasks
where exploring is expensive. The experiment here measured a short one, and found what
that predicts: when a capable model can find the way in four requests, memory has
nothing to save.

**Replaying and branching agent runs.** Agent frameworks with checkpoints offer
something similar — replaying a graph from a saved state and forking it with an edited
state (LangGraph calls it time travel). That works for agents built in that framework
from the start. pi-tape works on any pi session, after the fact, from pi's own session
file; it replaces tool results instead of re-running them; and it can change exactly
one tool result and let the model take it from there.

**What is new here** is less either half than the combination: recorded runs as
*fixtures* for testing agent knowledge. The research admits a skill after it has been
executed again; pi-tape can check a change to a skill, a note or a model against every
recorded run without executing anything, and point at the step where the behaviour
moved.

## What has been shown

Everything below was run against a real pi (1.x) with a real model (DeepSeek Flash),
by the scripts in [`bench/`](bench), which drive pi in RPC mode and check results in the
world — files on disk, a tool's own log — rather than taking the model's word for it.
Reports land in `.tape/check/` (ignored by git). Re-run them after any change:

| Script | What it checks | Result |
|---|---|---|
| `bench/replay-check.mjs` | record, change the files on disk, replay (also at another thinking level), fork with an intervention | 9/9 — with the full personal setup of ~200 tools from other extensions |
| `bench/prove.mjs` | a longer run with parallel tool calls and a compaction; replay compacting at the same point; fork *after* the compaction with thinking on; a debugging case | 14/14 |
| `bench/knowledge-regression.mjs` | shadow a recorded run with unchanged, reworded and broken `AGENTS.md` | mechanics shown with a scripted model; real-model run pending |
| `bench/recipe-experiment.mjs` | recipes vs. the agent's own notes vs. nothing, on unseen tasks | first run: no saving (below); second run pending |

The debugging case, as it ran: an agent read a stale note (`port 3000`) and answered
`3000`, while the config said `8080`. A fork that replaced only that one read with the
corrected note answered `8080` — one live request, nothing else re-run — and
`pi-tape diff` names the fork point and the replaced value.

The checks earned their keep by failing first. Each of these was invisible to the unit
tests and found only by running real pi: replay missed every request after the first
because `durationMs` and `thinkingLevel` were part of the key; a fixed live-token budget
stopped forks after one step in a setup with many tools; a compaction during a replay
was answered with a recorded tool call and shifted the rest of the run; recipe
extraction learned the failed attempts of a run and dropped the step that worked.

## Recipes: an experiment

The question is whether a recipe makes the next run cheaper or better than nothing — and
than the agent's own notes, which cost nothing to build. `bench/recipe-experiment.mjs`
uses a small in-house deploy tool whose help text is incomplete: three training runs
are recorded, the agent writes notes after each, pi-tape splices the recordings, and
three unseen deployments are run under each condition.

First run, DeepSeek Flash, 6 test runs per condition:

| condition | success | requests | tokens | cost |
|---|---|---|---|---|
| nothing | 6/6 | 4.5 | 32,900 | $0.0021 |
| the agent's notes | 6/6 | 4.5 | 38,800 | $0.0031 |
| recipes | 6/6 | 6.2 | 50,000 | $0.0030 |

No saving, and an overhead. Three reasons, all addressed since: the model simply read
the tool's source, so exploring cost four requests and there was nothing to save; the
recipe itself was wrong (pi-tape's own lookup tool had become a step, chained commands
were not split); and finding a recipe took two or three extra tool calls. Recipes now
leave pi-tape's own tools out, split `a && b`, keep conditional steps (`bump — before
step 3, when env=prod`), and a recipe that clearly matches the task is written into the
prompt instead of being looked up. The notes did not help either: the model checked for
itself anyway.

The second run adds a *sealed* variant of the tool, whose source cannot be read, so the
procedure can only be found by trying — the situation the research measures. If recipes
help anywhere, it is there; if they do not, that is the answer, and this section will
say so.

## Why a tape plays back exactly

An LLM call is a pure function of its prefix. Hash the prefix (messages, model and
thinking level — and, with `bindToolContext`, the tool declarations; system messages
are folded into that context rather than hashed as a message) and you have a cache
key. Record the answers, then serve them instead of calling a provider.

Keying by prefix is what makes **forking** pay: change one tool result at turn 7 and
only the requests after it differ. A plain replay (`/tape play`) serves a hash hit from
the recording and, on a miss, the next unconsumed event — an old answer to a new
context, which it records as a miss rather than hiding. A fork (`/tape fork … --model`)
is the same engine with that fallback switched off: a miss is asked of a real model, so
a new context gets a new answer instead of a stale one. See [Honest limits](#honest-limits).

## Why recipes compose (experimental)

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

One parameter swap, no re-learning — that is the idea. Whether it pays off in practice
is what [Recipes: an experiment](#recipes-an-experiment) measures. Details in
[docs/RECIPES.md](docs/RECIPES.md).

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
#   14 request(s) · 9 identical · 2 structurally different · 3 only reworded or inspected differently
#   the comparison itself cost 41200 tokens
```

The comparison is strict about actions and lenient about the rest: a different tool
call that *does* something is a different procedure; a rephrased sentence, an unset
optional parameter, or a different way of looking around (`ls -la` against `ls`, one
`read` more) is not. It costs real tokens, and it says so.

### Test a change to what the agent knows

The same mechanism checks a change to `AGENTS.md`, a skill or a system prompt. Keep a
recording of a run that worked; after the change, shadow it with the same model. The
recording fixes the trajectory, the model sees the *new* knowledge, and every recorded
step is asked again:

```
# AGENTS.md lost the line "prod only: run ./shipit bump <service> before the deploy"
/tape shadow golden.tape --model deepseek/deepseek-flash
/model tape/deepseek-flash
<the original first prompt>
/tape regress
# golden: deepseek-flash → deepseek/deepseek-flash
#   4 request(s) · 3 identical · 1 structurally different · 0 only reworded or inspected differently
#   structurally different requests:
#     turn 2
#       recorded: bash({"command":"./shipit bump billing"})
#       new:      bash({"command":"./shipit deploy billing --env prod"})
```

Nothing is executed — the deploy in the recording is not deployed again — and the
report names the step where behaviour moved. Run it with the unchanged file first: what
differs then is the model's own noise, and that is the baseline a real regression has
to stand out from. `bench/knowledge-regression.mjs` does all of this, including the
control.

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
# probe before running: docker
# left behind: image api:latest
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

## The extension

One command, seven tools, one hook — and a synthetic provider while a replay is
armed. The command is for you; the tools are for the agent.

### The command

| | |
|---|---|
| `/tape record [name] [--redact]` | write this session to a `.tape` file; `--redact` replaces credentials first |
| `/tape play <file>` | arm deterministic replay from a recording |
| `/tape shadow <file> --model <provider>/<model>` | replay, and ask another model the same requests |
| `/tape fork <file> --model <provider>/<model> [--at <turn|id> --result <text|@file>] [--live-tools a,b] [--max-live-tokens N]` | serve the recording, ask that model where the recording ends |
| `/tape regress` | what the shadow model answered differently |
| `/tape status` | replay progress, misses, shadow and fork progress |
| `/tape stop` | disarm (then `/reload` to restore the real tools) |
| `/tape library` | list the recipe store |
| `/tape index` | rebuild the recipe graph index |

### The tools, and when the agent should reach for them

| Tool | The question it answers | Why not the alternative |
|---|---|---|
| `tape_search` | "do I already know how to do this?" | a recipe lookup measured at ~90 tokens, local and offline; a web search costs thousands and can be wrong |
| `tape_show` | "what exactly is the procedure?" | the steps, the parameters and the open gaps, without reading the tape |
| `tape_dub` | "what would it look like with these values?" | concrete steps, and every unfilled placeholder *typed*: secret, path, env, choice or free |
| `tape_plan` | "what would running it take?" | the gaps to fill, what this machine has, which steps are the agent's own — and it runs nothing |
| `tape_segment` | "where would I cut this?" | the numbered steps and their contracts, then stores the parts when asked |
| `tape_splice` | "learn this family" | k tapes of one task → one parameterized recipe, with the failed runs kept out |
| `tape_check` | "is this recipe still true?" | runs the dependency validators, so an old recipe is not mistaken for a fact |

### The hook

`before_agent_start` appends a bounded block — about 1800 characters, at most 12
recipes — that says what is in the store and tells the agent to consult it **before**
searching the web or re-reading files. The budget is the point: a context injection
that grows with the store is the disease, not the cure.

While replay is armed the hook stays out of the way, because a replayed run should
follow its recording rather than be told about new knowledge.

### What that buys you

- **A second run is cheaper than the first.** The agent looks in the store before it
  looks at the web: a few hundred tokens, no network, no wrong answer from a blog
  post. The lookup cost is bounded by design, so it does not become the problem it
  solves.
- **Replay costs nothing and calls no provider.** Everything is served from the
  recording, tool calls included, so the recorded side effects never run again.
- **The prefix key is what makes forking cheap.** Answers are keyed by request prefix,
  so changing one tool result at turn 7 re-asks only the requests after it. `/tape fork`
  turns that into behaviour: served from the recording while the prefix matches, asked
  of the model where it does not.
- **A tape can be handed over.** `--redact` replaces what looks like a credential
  before the file is written, and the recipes derived from it never carried one.
- **The model-upgrade question gets an answer.** A shadow run serves the recording and
  asks a different model the same requests, then reports where they differ — and
  separates "changed what it would do" from "said it differently".
- **What is learned is inspectable.** Recipes are plain JSON with typed gaps and
  contracts, and they live in git next to the code they describe.

### What it does not do

The tools are all read-only: the agent still edits and runs things with its normal
tools, and nothing happens behind your back. Nothing is installed or supplied — no
container, no version manager — so a procedure's requirements are described, probed
and refused rather than arranged.

`/tape play` serves recorded answers and *replaces* recorded tool calls, so the
original side effects do not run again; `pi-tape run --yes` is the one that executes a
procedure, so read it before you run it. And the regression suite is the least proven
part of the project; see [Honest limits](#honest-limits).

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

Every flag is in `pi-tape help`, which is the authoritative list; the table above is
the shape of the thing.

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
2. **Position** — when the hash misses (a fork changed the context, or something in
   the request differs from the recording), the next unconsumed event of the right
   kind is served instead. A straight replay therefore still works with imperfect
   hashes.
3. **Fork** — `/tape fork` switches that fallback off. Step 1 still applies, but a
   miss is reported instead of served, and the named model is asked — the one honest
   answer for a context the recording never contained. A live branch that repeats a
   recorded call gets the recorded result, so the run continues instead of stopping.
   `--at <turn> --result <text>` replaces one tool result first, which is the actual
   "what if the tool had said something else" experiment. A request that misses the
   recording *before* the intervention has been served stops the fork unsent: nothing
   has diverged yet, so it is a hash mismatch, not the experiment. Past the
   intervention a fork is an ordinary session with no spend limit, unless one is set
   with `--max-live-tokens N`.

Every miss is recorded, never silent. `/tape status` and `inspect` show them, which
is how you find out *why* a replay diverged.

## Honest limits

A debugger that lies is worse than none, so:

- **Tool overrides last for the process.** pi cannot unregister a tool, so leaving
  replay needs `/reload`. `/tape stop` makes the overrides refuse to run rather than
  pretend.
- **Compaction is replayed, not redone.** A request after a recorded compaction is
  indexed twice — by the full history and by what the model actually saw (the
  summary plus the kept messages) — so it matches whether or not the replay compacts.
  When pi compacts during a replay, pi-tape answers with the recorded summary if the
  recording compacted at that point (after the same number of answers), and skips the
  compaction otherwise, so no recorded answer is spent on a summary. Past a fork's
  divergence the branch is its own run, and a live model summarises it. A replay that
  compacts at a *different* point than the recording sends a context the recording
  never saw, and falls back to position (or, in a fork, stops before the intervention).
- **Replayed answers report zero cost.** Token counts are kept so the shape of the
  run is visible; the money is zeroed so session totals stay honest.
- **Recipe extraction is heuristic.** A shell command is a string, not an AST. Step
  boundaries and slot names are interpretations, not facts.
- **Contracts are checked, not proven.** `link` shows that the artifacts line up —
  the file, the image, the dependency. It cannot show the result is correct, and a
  step with no contract is invisible to it.
- **`run` quotes the values it binds.** A placeholder standing alone becomes one
  single-quoted argument, and one already inside quotes is escaped in place, so a value
  with a space, a `;` or a `"` cannot split the command or start a second one. What the
  recorder could not express is still missing from what runs, and the plan shows a gap
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
- **The replay half is verified against a real session.** The hash key is checked
  against a capture from a real pi run — the messages pi sent while replaying it,
  next to the session file it recorded (`test/fixtures/real-session.json`). That
  fixture exists because the hand-built tests hid a real defect: an assistant
  message carries the name of the provider that wrote it (`api`, `model`,
  `provider`), a provider never sees those fields, and including them made every
  replay of a real run miss on the second request. They are excluded from the key
  now, and the fixture fails if they come back.
- **The regression suite is experimental.** `/tape shadow <file> --model <p>/<m>`
  replays a recording and asks another model the same requests, then
  `/tape regress` reports where they differ structurally. The comparison is tested;
  the provider glue around it is the least proven part of the project. The
  conservative pass also misses a credential written as bare prose, which is why
  `record --redact` is a layer and not a guarantee: read a tape before sharing it.
- **The recipe layer is experimental.** It has been measured once against real runs,
  and that run showed no saving (see [Recipes: an experiment](#recipes-an-experiment)).
  `link`, `segment`, `run`, the PageRank and Louvain graph passes and the TF-IDF search
  are tested against hand-built fixtures only. The replay, fork and shadow half of the
  project is the one that has been shown to work.
- **A recipe has no conditionals.** A step only some runs needed is kept with the
  parameter values that separated those runs (`when env=prod`) and where it came
  (`before step 3`). That is a pattern seen in k recordings, not a rule, and with three
  recordings it can be a coincidence.
- **The checks in `bench/` ran against one provider.** DeepSeek Flash, with thinking on.
  Providers that sign their reasoning (Anthropic) are the open case for a fork: the
  replayed turns are sent back to them. `bench/prove.mjs` checks exactly that when
  such a model is configured.
- **A fork reconnects narrowly.** A live branch that repeats a recorded call gets the
  recorded result only for read-only tools, only up to the recording's next change,
  and never after a live tool has changed something — otherwise it would be served an
  answer about a world it never produced. Anything else stops the run unless the tool
  is named in `--live-tools`.
- **Live tools run in today's directory.** `--live-tools` runs pi's real
  implementation only for what the recording cannot answer: recorded calls are served
  from the tape, and a live read the recording already answered (before its next
  change) is reconnected first. What does reach the real tool sees the directory as it
  is now, not as it was at the fork point, so a live branch of an old recording is not
  a faithful counterfactual. Only
  pi's built-in tools can be run this way; any other tool in `--live-tools` is left
  un-overridden, and its recorded calls run again too. Executing a procedure is
  `pi-tape run`.
- **Not yet implemented:** forking from the UI, image payload replay, and rule packs
  loaded from the store so a repository can describe its own tools.

## Development

```bash
npm test                    # the full suite (212 tests at this revision)
npm run typecheck           # tsc --noEmit, clean
npm run build               # tsc -p tsconfig.build.json -> dist/ (needed only to publish)
node src/cli.ts inspect …   # the CLI is the fastest way to poke at the library
node bench/prove.mjs        # against a real pi and model; reports in .tape/check/
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
bench/                  checks against a real pi and model, driven over RPC (not shipped)
test/                   node:test, no framework
                        cli.test.ts guards the published artefact, not the code
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
compiled `dist/`, the sources, the extension, the docs, the licence, the citation file
and the screenshot the README shows, and nothing else — no tests, no workflows, no dev
tooling. `dist/` is built by
`prepublishOnly`, so publishing without compiling is not possible. `pi` is the only thing
that supplies a dependency at runtime, which means the published package installs
nothing of its own, even though the dev tree carries semantic-release and its
transitive dependencies.

## Credits

The index design follows [pi-mindplace](https://github.com/Smotherer007/pi-mindplace)
(MIT) by Patrick Weppelmann. See [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md) for
exactly what was borrowed and what was not.

## Licence and citation

Apache License 2.0 — see [LICENSE](LICENSE). It is a permissive licence with one
condition that matters here: attribution is not optional. A redistribution or a
derivative has to keep the `LICENSE` and [NOTICE](NOTICE) files and state what was
changed, so the work cannot quietly become somebody else's.

The parts of this project that are ideas rather than code are the parts worth
arguing with, so if you build on it, please say what you built on. A machine-readable
[CITATION.cff](CITATION.cff) is in the repository, and GitHub renders a "Cite this
repository" button from it.

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
