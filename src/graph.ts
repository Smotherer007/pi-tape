/**
 * The recipe graph, PageRank and community detection.
 *
 * Nodes are recipes, steps and slots; edges are "contains" and "precedes". Two
 * questions come out of it:
 *
 *   PageRank over steps   which steps carry the most leverage across all recipes
 *                         ("god steps"): changing one of those changes everything
 *   Louvain over recipes  which recipes belong to the same family, which is what
 *                         makes the orthogonality measurement possible without a
 *                         human deciding what "the same kind of task" means
 *
 * The algorithms are hand-rolled on purpose: a dependency for 50 lines of
 * modularity optimisation is not worth the install. They follow the same approach
 * pi-mindplace uses (MIT, github.com/Smotherer007/pi-mindplace) — pure-JS power
 * iteration and greedy modularity, no numpy, no networkx.
 */

import type { Recipe, Step } from "./recipe-types.ts";
import { lcsLength } from "./recipe-intersect.ts";

export type NodeKind = "recipe" | "step" | "slot";

export interface GraphNode {
	id: string;
	kind: NodeKind;
	label: string;
	/** For step nodes: the normalized verb. */
	verb?: string;
	centrality?: number;
	community?: number;
}

export interface RecipeGraph {
	nodes: Map<string, GraphNode>;
	/** Undirected weighted adjacency. */
	adjacency: Map<string, Map<string, number>>;
}

export function stepNodeId(key: string): string {
	return `step:${key}`;
}

export function recipeNodeId(id: string, name: string): string {
	return `recipe:${id || name}`;
}

export function slotNodeId(recipeName: string, member: { stepIndex: number; slot: string }): string {
	return `slot:${recipeName}#${member.stepIndex}#${member.slot}`;
}

function connect(graph: RecipeGraph, a: string, b: string, weight = 1): void {
	if (!graph.nodes.has(a) || !graph.nodes.has(b)) return;
	const add = (from: string, to: string) => {
		const neighbours = graph.adjacency.get(from) ?? new Map<string, number>();
		neighbours.set(to, (neighbours.get(to) ?? 0) + weight);
		graph.adjacency.set(from, neighbours);
	};
	add(a, b);
	add(b, a);
}

/** Build the graph from loaded recipes. */
export function buildRecipeGraph(recipes: Recipe[]): RecipeGraph {
	const graph: RecipeGraph = { nodes: new Map(), adjacency: new Map() };

	for (const recipe of recipes) {
		const recipeId = recipeNodeId(recipe.id, recipe.name);
		graph.nodes.set(recipeId, { id: recipeId, kind: "recipe", label: recipe.name });

		let previousStepId: string | undefined;
		for (const step of recipe.steps) {
			const id = stepNodeId(step.key);
			if (!graph.nodes.has(id)) {
				graph.nodes.set(id, { id, kind: "step", label: step.verb, verb: step.verb });
			}
			connect(graph, recipeId, id);
			// Consecutive steps inside one recipe are connected, so PageRank rewards
			// steps that sit in the middle of real procedures rather than trivia.
			if (previousStepId && previousStepId !== id) connect(graph, previousStepId, id, 0.5);
			previousStepId = id;
		}

		for (const parameter of recipe.parameters) {
			const id = slotNodeId(recipe.name, parameter.members[0] ?? { stepIndex: 0, slot: parameter.name });
			if (!graph.nodes.has(id)) {
				graph.nodes.set(id, { id, kind: "slot", label: parameter.name });
			}
			connect(graph, recipeId, id, 2);
			for (const member of parameter.members) {
				connect(graph, id, stepNodeId(stepKeyAt(recipe, member.stepIndex)), 1);
			}
		}
	}

	// Recipes that share most of their steps are similar; weight that directly so
	// community detection works on the recipe layer rather than through the steps.
	for (let i = 0; i < recipes.length; i++) {
		for (let j = i + 1; j < recipes.length; j++) {
			const a = recipes[i] as Recipe;
			const b = recipes[j] as Recipe;
			const keysA = a.steps.map((step) => step.key);
			const keysB = b.steps.map((step) => step.key);
			if (!keysA.length || !keysB.length) continue;
			const overlap = lcsLength(keysA, keysB) / Math.min(keysA.length, keysB.length);
			if (overlap >= 0.3) {
				connect(graph, recipeNodeId(a.id, a.name), recipeNodeId(b.id, b.name), overlap * 4);
			}
		}
	}

	return graph;
}

function stepKeyAt(recipe: Recipe, index: number): string {
	return (recipe.steps[index] as Step | undefined)?.key ?? "";
}

// ---------------------------------------------------------------------------
// PageRank
// ---------------------------------------------------------------------------

export interface PageRankOptions {
	alpha?: number;
	epsilon?: number;
	maxIterations?: number;
	/** Nodes matching this are down-weighted, so test/noise steps do not dominate. */
	penalize?: (node: GraphNode) => boolean;
}

export function pageRank(graph: RecipeGraph, options: PageRankOptions = {}): Map<string, number> {
	const alpha = options.alpha ?? 0.85;
	const epsilon = options.epsilon ?? 1e-6;
	const maxIterations = options.maxIterations ?? 100;

	const ids = [...graph.nodes.keys()];
	const n = ids.length;
	const scores = new Map<string, number>();
	if (n === 0) return scores;

	const index = new Map<string, number>();
	ids.forEach((id, i) => index.set(id, i));

	let current = new Float64Array(n).fill(1 / n);

	for (let iteration = 0; iteration < maxIterations; iteration++) {
		const next = new Float64Array(n).fill((1 - alpha) / n);
		for (let i = 0; i < n; i++) {
			const id = ids[i] as string;
			const neighbours = graph.adjacency.get(id);
			if (!neighbours || neighbours.size === 0) {
				// Dangling node: spread its mass evenly, otherwise the scores leak.
				const share = (alpha * (current[i] as number)) / n;
				for (let j = 0; j < n; j++) next[j] = (next[j] as number) + share;
				continue;
			}
			let total = 0;
			for (const weight of neighbours.values()) total += weight;
			if (total === 0) continue;
			for (const [neighbour, weight] of neighbours) {
				const j = index.get(neighbour);
				if (j === undefined) continue;
				next[j] = (next[j] as number) + (alpha * (current[i] as number) * weight) / total;
			}
		}

		let diff = 0;
		for (let i = 0; i < n; i++) diff += Math.abs((next[i] as number) - (current[i] as number));
		current = next;
		if (diff < n * epsilon) break;
	}

	ids.forEach((id, i) => {
		let value = current[i] as number;
		const node = graph.nodes.get(id);
		if (node && options.penalize?.(node)) value *= 0.1;
		scores.set(id, value);
	});
	return scores;
}

/** Attach PageRank values to the nodes. */
export function computeCentrality(graph: RecipeGraph, options: PageRankOptions = {}): Map<string, number> {
	const scores = pageRank(graph, options);
	for (const [id, score] of scores) {
		const node = graph.nodes.get(id);
		if (node) node.centrality = Math.round(score * 1_000_000) / 1_000_000;
	}
	return scores;
}

/** Steps ranked by centrality, restricted to step nodes. */
export function godSteps(graph: RecipeGraph, limit = 15): Array<{ key: string; verb: string; centrality: number; recipes: number }> {
	const scores = pageRank(graph);
	const out: Array<{ key: string; verb: string; centrality: number; recipes: number }> = [];

	for (const [id, node] of graph.nodes) {
		if (node.kind !== "step") continue;
		const recipes = [...(graph.adjacency.get(id)?.keys() ?? [])].filter((neighbour) =>
			neighbour.startsWith("recipe:"),
		).length;
		out.push({
			key: id.slice("step:".length),
			verb: node.label,
			centrality: Math.round((scores.get(id) ?? 0) * 1_000_000) / 1_000_000,
			recipes,
		});
	}

	return out.sort((a, b) => b.centrality - a.centrality).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Louvain (single-level greedy modularity)
// ---------------------------------------------------------------------------

export interface CommunityResult {
	assignment: Map<string, number>;
	modularity: number;
	communities: Map<number, string[]>;
}

/**
 * Greedy modularity optimisation, one level.
 *
 * Each node starts in its own community, then repeatedly moves to whichever
 * neighbouring community gives the largest modularity gain, until no move helps.
 * One level is enough here: the graph is small, and a full hierarchical Louvain
 * would add code without changing which recipes end up together.
 */
export function detectCommunities(graph: RecipeGraph, maxPasses = 40): CommunityResult {
	const ids = [...graph.nodes.keys()];
	const assignment = new Map<string, number>();
	ids.forEach((id, i) => assignment.set(id, i));

	if (ids.length === 0) return { assignment, modularity: 0, communities: new Map() };

	// Weighted degree per node and total edge weight.
	const degree = new Map<string, number>();
	let totalWeight = 0;
	for (const [id, neighbours] of graph.adjacency) {
		let sum = 0;
		for (const weight of neighbours.values()) sum += weight;
		degree.set(id, sum);
		totalWeight += sum;
	}
	const m = totalWeight / 2;
	if (m === 0) {
		return { assignment, modularity: 0, communities: groupByCommunity(assignment) };
	}

	for (let pass = 0; pass < maxPasses; pass++) {
		let moved = false;

		for (const id of ids) {
			const ownCommunity = assignment.get(id) as number;
			const neighbours = graph.adjacency.get(id) ?? new Map<string, number>();
			if (neighbours.size === 0) continue;

			// Weight from this node into each candidate community.
			const weightInto = new Map<number, number>();
			for (const [neighbour, weight] of neighbours) {
				const community = assignment.get(neighbour) as number;
				weightInto.set(community, (weightInto.get(community) ?? 0) + weight);
			}

			const totals = communityTotals(assignment, degree);
			const kI = degree.get(id) ?? 0;

			// Standard modularity gain: ΔQ = k_i,C/(2m) - (Σ_tot,C · k_i)/(2m²).
			// The current community competes through the same formula, so no separate
			// baseline subtraction is needed.
			const gainFor = (community: number): number =>
				(weightInto.get(community) ?? 0) / (2 * m) - ((totals.get(community) ?? 0) * kI) / (2 * m * m);

			let bestCommunity = ownCommunity;
			let bestGain = gainFor(ownCommunity);

			for (const community of weightInto.keys()) {
				if (community === ownCommunity) continue;
				const gain = gainFor(community);
				if (gain > bestGain) {
					bestGain = gain;
					bestCommunity = community;
				}
			}

			if (bestCommunity !== ownCommunity) {
				assignment.set(id, bestCommunity);
				moved = true;
			}
		}

		if (!moved) break;
	}

	// Renumber communities to a dense range, in order of first appearance.
	const dense = new Map<number, number>();
	let next = 0;
	for (const id of ids) {
		const raw = assignment.get(id) as number;
		if (!dense.has(raw)) dense.set(raw, next++);
		assignment.set(id, dense.get(raw) as number);
	}

	return {
		assignment,
		modularity: round(modularity(graph, assignment, m)),
		communities: groupByCommunity(assignment),
	};
}

function communityTotals(assignment: Map<string, number>, degree: Map<string, number>): Map<number, number> {
	const totals = new Map<number, number>();
	for (const [id, community] of assignment) {
		totals.set(community, (totals.get(community) ?? 0) + (degree.get(id) ?? 0));
	}
	return totals;
}

function groupByCommunity(assignment: Map<string, number>): Map<number, string[]> {
	const out = new Map<number, string[]>();
	for (const [id, community] of assignment) {
		const list = out.get(community) ?? [];
		list.push(id);
		out.set(community, list);
	}
	return out;
}

/** Modularity of an assignment, using the standard weighted formula. */
export function modularity(graph: RecipeGraph, assignment: Map<string, number>, m: number): number {
	if (m === 0) return 0;
	const totals = communityTotals(assignment, degreeOf(graph));
	let sum = 0;

	for (const [id, neighbours] of graph.adjacency) {
		const own = assignment.get(id);
		for (const [neighbour, weight] of neighbours) {
			if (assignment.get(neighbour) !== own) continue;
			sum += weight;
		}
	}

	let penalty = 0;
	for (const total of totals.values()) penalty += (total / (2 * m)) ** 2;

	return sum / (2 * m) - penalty;
}

function degreeOf(graph: RecipeGraph): Map<string, number> {
	const degree = new Map<string, number>();
	for (const [id, neighbours] of graph.adjacency) {
		let sum = 0;
		for (const weight of neighbours.values()) sum += weight;
		degree.set(id, sum);
	}
	return degree;
}

function round(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}

/** Recipe ids per community, for reporting. */
export function recipeCommunities(graph: RecipeGraph, result: CommunityResult): Map<number, string[]> {
	const out = new Map<number, string[]>();
	for (const [id, community] of result.assignment) {
		if (!id.startsWith("recipe:")) continue;
		const node = graph.nodes.get(id);
		const list = out.get(community) ?? [];
		list.push(node?.label ?? id);
		out.set(community, list);
	}
	return out;
}
