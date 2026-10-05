# Attribution

## pi-mindplace

The recipe index borrows its approach from **[pi-mindplace](https://github.com/Smotherer007/pi-mindplace)**
by Patrick Weppelmann (`@patimweb`), MIT licensed.

pi-mindplace builds a knowledge graph from source code. `pi-tape` builds one
from agent recordings. The problems are the same shape — a local deterministic
index, retrieval under a token budget, freshness, and telling the agent to consult
the index before searching — so the following mechanisms were deliberately
modelled on it:

| Mechanism in pi-mindplace | Used here for |
|---|---|
| Hand-rolled TF-IDF with smoothed IDF, camelCase/snake_case tokenization, substring bonus | `src/recipe-query.ts` ranking |
| Token-budget-aware BFS traversal | result-set growth until the budget is spent |
| PageRank by pure-JS power iteration, no numpy | `src/graph.ts`, "god steps" over procedures |
| Greedy Louvain modularity optimisation | `src/graph.ts`, recipe families |
| SHA256 content hashing for incremental rebuilds | `src/recipe-store.ts`, `recipeFileDigests` |
| `before_agent_start` prompt injection of a query-first rule | `extension/index.ts`, `recipeContext` |
| Zero-dependency, no Python, no native binaries | entire project |

What is **not** borrowed: the extraction layer. pi-mindplace gets exact ground truth
from tree-sitter — a function node is a function, provable, with no model involved.
There is no grammar for "what was one meaningful step in an agent run", so
`src/recipe-extract.ts` and `src/normalize.ts` are heuristic and original, and they
are the weak point of this pipeline. That difference is stated in
[docs/RECIPES.md](RECIPES.md#honest-limits) rather than papered over.

The code is an independent implementation, not a copy. The attribution exists
because the design came from reading that codebase, and because the licence and
plain honesty both ask for it.

## Everything else

Node built-ins only. No runtime dependencies. TypeScript runs directly, with no
build step, on Node 22.6+.
