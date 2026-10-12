# bench

Checks that run pi-tape against a **real pi with a real model**, as opposed to the unit
tests in `test/`, which never start an agent. Each script drives pi in RPC mode in a
throwaway folder, checks results in the world (files on disk, a tool's own log), and
writes a report to `.tape/check/` — ignored by git.

They load pi-tape from **this checkout** (`extensions/index.ts`) with `--no-extensions`,
so the working tree is what gets tested and none of your other tools are declared.
`--approve` applies to the one process; an empty `PI_TAPE_DIR` keeps your own recipes
out. Nothing is written to your pi settings.

| Script | Question | Time · cost (DeepSeek Flash) |
|---|---|---|
| `replay-check.mjs` | does record → replay → fork work in my pi? | 1 min · cents |
| `prove.mjs` | long runs, parallel calls, compaction, thinking, a debugging case — per model | 3–5 min · cents |
| `knowledge-regression.mjs` | does shadowing catch a broken `AGENTS.md`, and stay quiet on a reworded one? | 3–5 min · cents |
| `recipe-experiment.mjs` | do recipes beat nothing, and the agent's own notes, on unseen tasks? | 15–30 min · under $1 |

Common environment: `PI_BIN` (which pi), `PI_MODEL` / `PI_MODELS` (which model),
`REPEATS`. Every script says at the top what it does and what it costs.

```bash
node bench/replay-check.mjs
```
