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
a recipe stays as concrete as the evidence allows.

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
      "usesSlots": ["template", "name"], "slotValues": {}, "noise": false }
  ],
  "slots": [
    { "name": "template", "stepIndex": 0, "stepKey": "…",
      "variance": 0.5, "fillers": [{ "value": "vue@latest", "observedIn": 2, "…": "…" }] }
  ],
  "parameters": [
    { "name": "template", "enumerated": true,
      "members": [{ "stepIndex": 0, "slot": "template" }, { "stepIndex": 1, "slot": "package" }],
      "variants": [{ "label": "vue@latest", "observedIn": 2,
                     "values": { "0#template": "vue@latest", "1#package": "vue-router" } }] }
  ],
  "compatibility": { "constraints": [] },
  "validators": [{ "command": "npm view vue version", "describes": "…" }]
}
```

Readers must tolerate unknown fields and backfill `enumerated` (a parameter with
more than one member is enumerated) when it is absent.

## Honest limits

- **Extraction is heuristic.** A shell command is a string, not an AST. Step
  boundaries and slot names are interpretations, not facts. Everything derived is
  marked with how much support it had.
- **Orthogonality needs a family.** See the data requirement above.
- **Composition is not validated by construction.** Two valid fillers can still be
  incompatible — a React template with a Vue router is rejected because they are
  one parameter, but two *different* parameters can produce a combination that has
  never been run. Recipes need a compatibility contract and a validation run.
- **Freshness is only as good as the validators.** A recipe with none is reported
  as unknown, and nothing more.
- **Recipes are not a replacement for scripts.** For a deterministic procedure, a
  script is exact, atomic, reviewable and diffable. Compile the recipe; do not
  execute it step by step in place of the script it should have become.

## CLI

```bash
pi-tape splice <tape...> --name frontend-setup --scope project --save
pi-tape library
pi-tape show frontend-setup
pi-tape dub frontend-setup --set template=react@latest --set name=demo
pi-tape search "projekt aufsetzen" --budget 500
pi-tape index --write
pi-tape check frontend-setup
```
