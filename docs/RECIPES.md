# Recipes

A recipe is the distilled, parameterized form of one or more tapes. It is the
intermediate representation between raw tapes and compiled scripts:

```
tapes  →  recipes  →  scripts / skills
(the ore)      (ingots)     (the built artefact)
```

Tapes are evidence of what happened once. Recipes are knowledge of what the
procedure *is*: the parts that stayed the same, and the parts that vary.

## Why not just splice tapes together

You cannot concatenate two tapes into a new one. Every recorded answer
depends on the whole preceding context, so putting fragment B after fragment A
creates a context that never existed — no cache hit, no deterministic replay.

So composition works differently. It is **intersection**, not concatenation: take
k tapes of the same kind of task and compute what they share. The shared part
is the skeleton; the part that varied is a parameter. Swapping the parameter
produces a new procedure without re-learning anything.

That covers variants of one procedure. For *different* procedures that hand work
to each other — set a service up here, build an image there, deploy it somewhere
else — composition is **linking**: each fragment declares what it needs and what
it leaves behind, and the seam between two fragments is either met or named as a
gap. See [contracts and linking](#composition-contracts-and-linking).

## The model

### Steps

A step's identity is its **normalized shape**, never its literal text:

| Recording | Normalized key |
|---|---|
| `npm create vue@latest my-app` | `npm create <*> <*>` |
| `npm create react@latest other-app` | `npm create <*> <*>` |
| `npm install vue-router` | `npm install <*>` |
| `npm install react-router-dom` | `npm install <*>` |
| `git checkout -b feat/login` | `git checkout -b <*>` |
| `read src/a.ts` | `read::source` |

Normalization strips versions, paths, quoted arguments, shell variables and
numbers. It also applies **command-position rules**: the third argument of
`npm install` is a package whatever it is called, so it becomes a wildcard even
though its text looks like an ordinary word. That rule is what makes the Vue and
React tapes align at all.

The same pass produces the **template**, with semantic placeholders:

```
npm create {{template}} {{name}}
npm install {{package}}
npm run build
```

Reconnaissance commands (`ls`, `echo`, `git status`, search tools) are marked as
noise and left out of the skeleton by default. They are how the agent oriented
itself, not part of the procedure. `--include-noise` keeps them.

### Slots

A slot is one placeholder inside one step. Slots are **scoped to their step** and
never aggregated by name across steps: `{{path}}` in a `read` step and `{{path}}`
in a `mkdir` step are different slots even though they are spelled the same.

A slot with only one observed value is not a slot. It is inlined as a constant, so
a recipe stays as concrete as the evidence allows — **unless the value is one that
must stay open**. Agreement between recordings is not evidence that a value is
knowledge: four recordings that used the same API key agree about the key, not
about the procedure.

### Gaps

Every placeholder carries a **kind**, because "fill in `{{token}}`" and "this was a
credential, supply it yourself" are different instructions and the second one is
the only safe reading of the first:

| Kind | What it is | What to do with it |
|---|---|---|
| `secret` | A credential. | Supply at run time. Never stored, never inlined. |
| `path` | A location on a machine. | Resolve it; a recorded location is not portable. |
| `env` | A version, port, host, OS. | Probe the environment instead of trusting the recording. |
| `choice` | Several slots that must move together. | Pick one observed variant. |
| `free` | Ordinary knowledge or a caller-chosen name. | Supply anything. |

Two rules follow from that, and both are load-bearing:

- **A machine-specific value is never inlined, however consistent the recordings
  were.** A `secret` or an `env` never is, and a `path` only when it is relative.
  `src/main.py` is part of the procedure; `/home/alice/src/main.py` is a fact about
  one machine. Inlining the second is how a recipe stops being portable.
- **A credential is replaced before it can reach a recipe file.** Tool arguments,
  examples and outcome evidence all pass through the same redaction, so the
  placeholder survives and the value does not. `write .env` keeps its path: the
  location is ordinary knowledge, the content never was in a step to begin with.

```bash
pi-tape dub publish
# npm publish --token {{token}}
# unfilled [secret] token: supply token at run time — it was redacted from the
# recordings and is deliberately not stored
```

`unfilledGaps()` reports each open placeholder with its kind, and the agent-facing
`tape_dub` tool returns the same, so a model filling the gap knows whether to ask,
probe or choose.

### Parameters

A parameter is one or more slots that **vary together**.

```
template  [0#template, 1#package]
    vue@latest (x2), react@latest (x2)
name      [0#name]
    app-one, app-two, app-three, app-four
```

The grouping test is a bijection: whenever slot A held `vue@latest`, slot B held
`vue-router`; whenever A held `react@latest`, B held `react-router-dom`. That is a
much stronger signal than "both changed", and it is what makes one swap carry the
whole variant:

```bash
pi-tape dub frontend-setup --set template=react@latest --set name=demo
# npm create react@latest demo
# npm install react-router-dom      <- came along with the framework
# npm run build
```

Two kinds, and the difference matters:

- **enumerated** (`choose one`) — more than one member. The caller must pick an
  observed variant, because the slots have to move together consistently. Picking
  a React template without the React router would be wrong.
- **free** (`free value`) — a single member. A project name, path or branch is
  whatever the caller says it is; the observed values are examples.

### Orthogonality

```
orthogonality = steps in every tape / steps in the longest tape
```

This is the load-bearing number. High means the family shares a skeleton and a
filler swap really does transfer knowledge. Low means the tapes merely look
similar and each is its own procedure — in which case stop and do not trust the
recipe.

Where that number decides anything is up to you, but the honest reading is: above
roughly 60 % the composition model carries, below it you are better off learning
the procedure directly.

**The data requirement.** Parameter detection needs *combinatorial* variation. Two
Vue runs and two React runs, with different project names, tell you which slots
belong together. Three tapes with three different frameworks and three
different names, one sample each, do not — you cannot distinguish "these move
together" from "these happened to differ in the same run". Record a family, not a
set of one-offs.

### Validators and freshness

A tape is a snapshot. A recipe derived from it names tools and packages the
world can move. So a recipe carries validators, derived automatically from the
dependencies it references:

```json
{ "command": "npm view vue-router version", "describes": "the \"vue-router\" package still exists and is fetchable" }
```

```bash
pi-tape check frontend-setup
```

A check that fails because a tool is missing or the network is down is reported as
**unknown**, not stale. Silence is never freshness: a recipe with no validators is
`unknown`, never `fresh`.

## Composition: contracts and linking

Intersection answers "what do these k runs share". It does not answer "does this
part fit that part", which is the question when the parts come from different
recordings that never ran in one session.

For that, each fragment carries **contracts**: what it needs before it runs and
what it leaves behind, derived from its steps.

```
write Dockerfile                →  provides file Dockerfile
docker build -t api:latest .    →  requires file Dockerfile
                                   provides image api:latest
docker run -p 8080:8080 api:…   →  requires image api:latest
```

`pi-tape link` chains fragments and reports the seam:

```bash
pi-tape link dockerfile containerise deploy
# met
#   ✓ file Dockerfile  ← dockerfile
#   ✓ image api:latest  ← containerise
# probe before running: docker
```

```bash
pi-tape link containerise
# gaps — nothing in the chain provides these
#   ✗ file Dockerfile  (needed by containerise)
# probe before running: docker
# left behind: image api:latest
```

Three things come out of that:

- `gaps` — requirements nothing provides. This is the job description for a model
  or a human, and the reason composition is not just concatenation.
- `environment` — commands to probe before running. Not gaps: the host is expected
  to supply `docker`, and one fragment cannot provide it for another.
- `left behind` — provisions no later fragment consumed. If something a fragment
  produced is missing here, the chain did not use its own results.

Order counts, inside a fragment as well as between fragments: writing a Dockerfile
and then building it in the same recording satisfies that recording's own
requirement, and calling it unfulfillable would be wrong.

Contracts are derived from the **rendered** steps, not from the templates, so a
placeholder still holding `{{port}}` is reported as `unresolved` instead of being
silently matched. The condition vocabulary is deliberately small — file, dir,
command, dependency, image — because a contract nobody can check is a comment.

### Where the reading comes from: rule packs

The engine that turns a step into conditions knows three things and no more:

- a tool-shaped step (`write <path>`, `read <path>`) says what it does;
- `sudo X` is a privilege request wrapped around `X`, so `X` is the real step;
- a shell line is a sequence of `&&`-separated segments, judged one at a time.

Everything else — that a `docker build` wants a `Dockerfile` and produces an image,
that `npm create` scaffolds a directory — lives in a **rule pack**, one per
ecosystem: `filesystem`, `node`, `python`, `docker`, `orchestration`, and a
`generic` catch-all that says an unknown command is a command and nothing more.

```bash
pi-tape rules      # what pi-tape assumes, exactly
```

The distinction that matters:

> A rule pack is **knowledge about a tool**, not a dependency on it.

Nothing is installed, started, imported or required. `docker` appearing in a rule
pack means pi-tape can *read* a `docker build` line; it does not mean Docker is
anywhere on the machine, and the Docker examples in this document are examples.
Dropping the pack removes the reading and changes nothing else — the same line then
falls through to "an unknown command", still probed, claiming nothing:

```ts
contractsOfSteps(["docker build -t api:latest ."])
// → requires file Dockerfile, command docker; provides image api:latest

contractsOfSteps(["docker build -t api:latest ."], { packs: BUILTIN_PACKS.filter((p) => p.name !== "docker") })
// → requires command docker   (an unknown command is still a command)
```

A pack is also the extension point. A shop that uses `uv`, `podman` or an internal
deploy CLI brings a pack instead of editing the engine, and a pack that is wrong is
one object to remove. `test/rules.test.ts` holds that line: it reads the engine's own
source and fails if an ecosystem name appears in it.

## Segments

A step is one tool call, which is the right unit for aligning recordings and the
wrong unit for reuse. Nobody wants "step 4 of the frontend recipe"; they want "the
part that adds the router", so it can be carried into another composition.

A **segment** is a range of steps plus an intent. The intent is the only judgement
in it, which is why it is supplied rather than guessed, and why
`segmentEvidence()` exists: it prints the numbered steps, their gap kinds, their
parameters and their contracts, which is exactly what a model needs to propose
boundaries. Deciding *where* to cut is the model's job; the bookkeeping is not.

```bash
pi-tape segment service --cut 0-1 --cut 2-3 \
  --intent "set the service up" --intent "start it" --save
```

Two checks run on the ranges, and both exist because the failure would be silent:

- **Overlap is refused.** A step in two segments would be run twice.
- **A gap is reported** as `not in any segment`, because extraction is allowed to
  leave the rest behind — that is the point of it — but a chain that quietly drops a
  step is not. `--require-coverage` turns the report into an error for the case
  where the parts are meant to be the whole procedure again.

A parameter whose members straddle a cut is dropped from both halves and reported:
its slots have to move together, and half a group is worse than none.

## Running a recipe

This is the loop a JVM performs on a distribution:

```
bind      fill what the recipe left open (gaps)
probe     find out what this machine actually has
execute   run the command steps in order, in a working directory
verify    check the postconditions the steps claimed they would deliver
```

```bash
pi-tape run service --set package=fastapi --set port=8000
```

An explicit `--set` for a slot name beats the variant a parameter would have chosen,
and that order is deliberate in the other direction too: a parameter is a *guess*
that its members move together, and with a thin family that guess can swallow a slot
the caller named. Silently ignoring what the caller asked for is the one outcome
that is always wrong.

Printing the plan is the default and executing is `--yes`, because a recipe is a
recorded command line and running one runs whatever it says. A chain is refused
before anything happens when it has unfilled gaps, unmet requirements from `link`,
missing tools, or steps the safety gate flagged.

What it will not pretend:

- **A tool call is not a command.** `write src/main.ts` is a pi tool call; pi-tape is
  not an agent and has no `write` tool. Such a step stops the run and is named as the
  agent's job. `--commands-only` steps over it, and then the postconditions will say
  what is missing.
- **A failing step stops the run.** The later steps were recorded in a world where
  that one worked. `--continue` exists for the case where the caller knows better.
- **Only what is checkable is checked.** A `file` or `dir` condition is verified
  against the filesystem; a `dependency`, an `image` or a `command` is
  `unverifiable`, never a pass.

Binding fills a gap from an explicit `--set`, then from the environment — but only
for a `secret` or an `env` gap, and never from a variable the shell owns. A gap
called `path` is a coincidence, not a request for `$PATH`.

**It provides no environment, and that is deliberate.** No container, no version
manager, no install step — each of those would be a dependency of its own, and a
recipe whose reproducibility depends on pi-tape shipping an opinion about
containers is not reproducible, it is just relocating the problem. So the
environment is *described* (contracts), *checked* (the probe, read-only), and
*refused* when it is missing, with the list of what is absent. What supplies it is
the machine, the agent, or a setup step that is itself part of the recording —
which is the honest division: pi-tape is the procedure and the verifier, not the
runtime.

## Model regression

Replay serves recorded answers, so it proves a recording is intact; it says nothing
about a different model. `/tape shadow` closes that: the recording is still served,
and the named model is asked the same requests in parallel.

```
/tape shadow auth-refactor.tape --model anthropic/claude-sonnet-4-5
/model tape/<recorded-model>
<send the original first prompt>
/tape regress
```

The comparison (`src/regress.ts`) is strict about structure and lenient about
wording, because a different tool call is a different procedure and a rephrased
sentence is not:

```
auth-refactor: old-model → new-model
  14 request(s) · 9 identical · 2 structurally different · 3 only reworded
  the comparison itself cost 41200 tokens
```

It costs real tokens, and it says so. Anything finer than "the action changed" — is
the new answer *better*? — is a judgement no diff can make, and this does not
pretend otherwise.

## Forking

Shadow asks a model the *same* requests and keeps serving the recording. A fork does
the opposite: it keeps serving the recording while the request still matches, and
asks the model the moment it does not. That is what a prefix-keyed cache is for — a
change at turn 7 re-asks turn 7 and after, and turns 1–6 stay free.

```
/tape fork auth-refactor.tape --model anthropic/claude-sonnet-4-5
/tape fork auth-refactor.tape --model anthropic/claude-sonnet-4-5 --max-live-tokens 20000
/model tape/<recorded-model>
<send a prompt that diverges from the recording, or edit a tool result>
/tape status
```

A plain replay falls back to the *next recorded event* on a hash miss, which is what
keeps a straight replay working with an imperfect hash. A fork switches that fallback
off (`onMiss: "miss"`), so a miss is reported rather than answered with a stale
answer, and the live model answers it. Every miss stays visible in `/tape status`.

## Asking "what if the tool had said something else"

A different *prompt* is one way to fork. The more interesting one is a different *tool
result*: replay the recording up to one tool call, put something else in its place,
and let a real model continue from there.

```
/tape fork deploy.tape --model anthropic/claude-sonnet-4-5 \
  --at 3 --result 'error: registry unreachable'
/model tape/<recorded-model>
<send the recorded first prompt>
```

The turns before the intervention are served from the tape and cost nothing. The
replaced result changes the next request's prefix, so from that point the model is
asked for real — which is the point of the experiment, not a side effect of it.

`--at` accepts either a turn number or a tool call id, and the two mean different
things on purpose: `--at 3` is readable, `--at call_00_ET_…` is exact. `pi-tape inspect
<file> --timeline` lists both, together with each call's arguments:

```
Intervention points (`/tape fork … --at <turn|toolCallId> --result …`)
  turn  1  read       {"path":"probe-input.txt"}   call_00_ET_Sn3cEgBRcfeii7e5hSUx7937
```

`--result` takes the rest of the line, so a multi-line value is supplied as
`--result @notes.txt` rather than inline.

### Continuing after the divergence

A live branch usually asks for something the recording already did — the same file,
again. Matching is on the call itself (tool and normalized arguments, so pi's empty
optionals do not break it), and such a call is served from the recording. That is what
lets a fork run past its divergence instead of stopping one thought later.

A call the recording does not contain still stops the run, with an explanation.
`--live-tools read,grep` is the escape hatch: those tools are left un-overridden, so
pi's real implementation runs them. It has to be decided when the fork is armed,
because `registerTool` wins over the built-in and cannot be undone in place.

### Two guards on the spend

A miss on the very first request is flagged as a suspected hash mismatch *when the
fork is aimed at a later turn* — nothing has diverged yet at that point, so it is a
bug in the key rather than a counterfactual. Sending a different first prompt on
purpose is not warned about; it is recorded as "diverged at the first request".

The run stops once it has spent `--max-live-tokens` (50000 by default), with a message
that says how much was spent instead of silently continuing.

### Comparing the two runs

Recording a session that ran as a fork writes the link back into the tape
(`parent`), and `diff` reads it:

```
$ pi-tape diff deploy.tape forked-run.tape
left  sha256:8349206c3d6e  4 turns  $0.0006
right sha256:618879570f87  4 turns  $0.0001

right was forked from left, so the divergence below is the experiment, not a regression
  fork point  read turn 1 (call_00_ET_Sn3cEgBRcfeii7e5hSUx7937)
  replaced    "PAYLOAD: 42 golden widgets"
  live        1 request(s) asked of a provider · 0 live call(s) answered from the recording

shared prefix: 2 turns
first divergence at turn 2 (content)

  left  #2  toolResult: hello probe
  right #2  toolResult: PAYLOAD: 42 golden widgets
```

Without that line a fork reads as a regression, which is the opposite of what it is.

### What makes the key correct

The prefix hash covers the messages, the model and the thinking level, and nothing
else. In particular it excludes the fields that name *who wrote* an earlier turn:
`api`, `model` and `provider`. Those live on the recorded assistant message, but no
provider ever sees them in a request — and a replayed turn is served through
pi-tape's synthetic provider, so they read `tape-replay` where the recording says
`openai-completions`. Including them made every replay of a real run miss on the
second request; `test/fixtures/real-session.json` is a capture from a real pi run
that fails if they are ever hashed again.

The limit is structural and worth knowing before you rely on it: pi cannot unregister
a tool, so when the live branch calls a tool the recording does not cover, the run
stops there with an explanation instead of running the real tool. A fork is "replay,
then one live reasoning step". Executing a procedure is `pi-tape run`.

## The store

```
~/.pi/agent/tape/          global    learned once, useful anywhere
  recipes/*.recipe.json
  index.json
<project>/.tape/           project   shadows global by name
  recipes/*.recipe.json
```

Recipes are plain JSON, so they live in git and travel with a repository fork.
A project recipe shadows a global one with the same name, so a project can
override a procedure locally without renaming it.

`index.json` is a graph over recipes, steps and slots:

- **PageRank** over steps gives the *god steps* — the ones with the highest
  leverage across all recipes. Changing one of those changes everything.
- **Louvain** community detection over recipes gives the *families*. This is what
  makes "the same kind of task" measurable instead of a human judgement: the
  clustering decides, and the orthogonality number is then computed per family.
- `stepUsage` maps a step to the recipes that contain it.

The index is refreshed when the **content** of a recipe file changes. Content, not
mtime: a rebuild that produced identical content is not a change, and a write in
the same millisecond is one even though no timestamp can show it.

## Using recipes from inside pi

Five tools are registered, and the system prompt tells the agent to use them
before searching:

1. `tape_search` — local, offline, a few hundred tokens
2. `tape_show` — the full procedure and its parameters
3. `tape_dub` — concrete steps with a parameter applied
4. `tape_check` — run the validators
5. `tape_splice` — learn a recipe from tapes

The ordering is the point. A recipe lookup costs a few hundred tokens and no
network; a web search costs thousands and can be wrong. So the lookup comes first,
and only the parts no recipe covers are searched or read.

The injection is capped (~1800 characters) and lists at most 12 recipes. A context
injection that grows without limit is the disease, not the cure.

## Recipe file format

Version 1. Plain JSON at `<store>/recipes/<slug>.recipe.json`.

```jsonc
{
  "magic": "pi-tape-recipe",
  "version": 1,
  "id": "recipe:…",              // content address
  "name": "frontend-setup",
  "description": "Spliced from 4 tapes",
  "scope": "project",
  "createdAt": "…", "updatedAt": "…",
  "learnedFrom": ["sha256:…"],   // tape ids
  "observations": 4,             // tapes behind this recipe
  "orthogonality": 1,
  "steps": [
    { "key": "bash::npm create <*> <*>", "verb": "npm create", "kind": "command",
      "template": "npm create {{template}} {{name}}", "example": "npm create vue@latest my-app",
      "usesSlots": ["template", "name"], "slotValues": {}, "slotKinds": {},
      "noise": false }
  ],
  "slots": [
    { "name": "template", "stepIndex": 0, "stepKey": "…", "kind": "free",
      "variance": 0.5, "fillers": [{ "value": "vue@latest", "observedIn": 2, "…": "…" }] }
  ],
  "parameters": [
    { "name": "template", "kind": "choice", "enumerated": true,
      "members": [{ "stepIndex": 0, "slot": "template" }, { "stepIndex": 1, "slot": "package" }],
      "variants": [{ "label": "vue@latest", "observedIn": 2,
                     "values": { "0#template": "vue@latest", "1#package": "vue-router" } }] }
  ],
  "compatibility": { "constraints": [] },
  "contracts": {
    "requires": [{ "kind": "command", "target": "npm", "note": "npm run build" }],
    "provides": [{ "kind": "dir", "target": "{{name}}", "note": "npm create vue@latest my-app" }]
  },
  "outcome": { "status": "success", "successes": 2, "failures": 0, "evidence": [] },
  "validators": [{ "command": "npm view vue version", "describes": "…" }]
}
```

Readers must tolerate unknown fields, backfill `enumerated` (a parameter with
more than one member is enumerated) when it is absent, and backfill `kind` as
`choice` for an enumerated parameter and `free` for anything else. A recipe
written before gap kinds existed did not record them, and inventing more than
that would be inventing information the file never carried.

## Honest limits

- **Extraction is heuristic.** A shell command is a string, not an AST. Step
  boundaries and slot names are interpretations, not facts. Everything derived is
  marked with how much support it had.
- **Orthogonality needs a family.** See the data requirement above.
- **Composition is checked, not proven.** `link` shows that the artifacts line up —
  the file, the image, the dependency. It cannot show that the result is correct,
  and a step with no contract (a `curl` to a service) is invisible to it. Two
  *different* parameters can still produce a combination that has never been run;
  the contract narrows that space without closing it.
- **`run` executes the template.** Redirections and quoting survive rendering, but a
  shell variable becomes a slot and anything the recorder could not express is
  absent from what runs. That is why a gap blocks a run instead of being
  approximated.
- **Verification stops at the filesystem.** Files and directories are checked;
  dependencies, images and services are reported as unverifiable.
- **The environment is the caller's, not pi-tape's.** Nothing is installed and no
  container is started. A missing tool is a refusal with a name in it, not an
  attempt to arrange the world. That keeps pi-tape free of system dependencies — and
  means reproducibility is the recipe's job, not the tool's promise.
- **The safety gate is a floor, not a sandbox.** A small, legible list of obviously
  destructive commands is refused. It is not a security boundary.
- **Freshness is only as good as the validators.** A recipe with none is reported
  as unknown, and nothing more.
- **Recipes are not a replacement for scripts.** For a deterministic procedure, a
  script is exact, atomic, reviewable and diffable. Compile the recipe; do not
  execute it step by step in place of the script it should have become.

## CLI

```bash
pi-tape splice <tape...> --name frontend-setup --scope project --save
pi-tape link frontend-setup deploy-aws [--set name=demo]
pi-tape library
pi-tape show frontend-setup
pi-tape dub frontend-setup --set template=react@latest --set name=demo
pi-tape search "projekt aufsetzen" --budget 500
pi-tape index --write
pi-tape check frontend-setup
```
