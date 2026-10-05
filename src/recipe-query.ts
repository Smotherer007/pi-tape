/**
 * Recipe retrieval: TF-IDF scoring plus a budget-aware graph expansion.
 *
 * The budget matters more than the ranking. A search that returns everything the
 * matcher liked is how a recipe lookup becomes a context problem instead of a
 * context solution; the whole point is to spend a few hundred tokens, not a few
 * thousand. So the result set is grown in score order until the caller's budget
 * is exhausted, then it stops.
 *
 * Scoring follows the approach pi-mindplace uses for code (MIT,
 * github.com/Smotherer007/pi-mindplace): hand-rolled TF-IDF with smoothed IDF,
 * camelCase/snake_case tokenization and a substring bonus, no scikit-learn.
 */

import type { Parameter, Recipe, Step } from "./recipe-types.ts";
import type { RecipeGraph } from "./graph.ts";
import { recipeNodeId, stepNodeId } from "./graph.ts";

/** Approximate tokens per character, the usual conservative estimate. */
export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Split camelCase, snake_case and kebab-case into lowercase terms. */
export function tokenize(text: string): string[] {
	const words = text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/);

	const out: string[] = [];
	for (const word of words) {
		const lower = word.toLowerCase();
		if (lower.length > 1) out.push(lower);
	}
	return out;
}

/** Everything about a recipe that a search should be able to match on. */
function documentOf(recipe: Recipe): string {
	const parts: string[] = [recipe.name, recipe.description, recipe.scope];

	for (const step of recipe.steps) {
		parts.push(step.verb, step.kind, step.template, step.key);
		parts.push(...step.usesSlots);
	}
	for (const slot of recipe.slots) {
		parts.push(slot.name, slot.description);
		parts.push(...slot.fillers.map((filler) => filler.value));
	}
	for (const parameter of recipe.parameters) {
		parts.push(parameter.name, parameter.description);
		parts.push(...parameter.variants.map((variant) => variant.label));
	}
	parts.push(...recipe.validators.map((validator) => validator.command));
	parts.push(...recipe.compatibility.constraints);

	return parts.join(" ");
}

class TfIdf {
	private readonly idf = new Map<string, number>();
	private readonly docs = new Map<string, string[]>();
	private readonly labels = new Map<string, string>();

	constructor(recipes: Recipe[]) {
		let count = 0;
		for (const recipe of recipes) {
			const tokens = tokenize(documentOf(recipe));
			if (!tokens.length) continue;
			const id = recipeNodeId(recipe.id, recipe.name);
			this.docs.set(id, tokens);
			this.labels.set(id, recipe.name);
			count++;
		}

		const df = new Map<string, number>();
		for (const tokens of this.docs.values()) {
			for (const term of new Set(tokens)) df.set(term, (df.get(term) ?? 0) + 1);
		}
		// Smoothed IDF, the scikit-learn convention.
		for (const [term, freq] of df) this.idf.set(term, Math.log((count + 1) / (freq + 1)) + 1);
	}

	/** Cosine similarity between the query and one document, in 0..1. */
	score(id: string, queryTokens: string[]): number {
		const docTokens = this.docs.get(id);
		if (!docTokens?.length || !queryTokens.length) return 0;

		const tf = new Map<string, number>();
		for (const term of docTokens) tf.set(term, (tf.get(term) ?? 0) + 1);

		let queryNorm = 0;
		const queryWeights = new Map<string, number>();
		for (const term of queryTokens) {
			const idf = this.idf.get(term) ?? 0.5;
			queryWeights.set(term, idf);
			queryNorm += idf * idf;
		}
		queryNorm = Math.sqrt(queryNorm);
		if (queryNorm === 0) return 0;

		const haystack = docTokens.join(" ");
		let dot = 0;
		let docNorm = 0;
		for (const [term, freq] of tf) {
			const idf = this.idf.get(term) ?? 0.5;
			const weight = freq * idf;
			docNorm += weight * weight;
			const queryWeight = queryWeights.get(term);
			if (queryWeight !== undefined) dot += queryWeight * weight;
		}
		if (docNorm === 0) return 0;

		// Substring bonus, for queries that name a compound the tokenizer split apart.
		let bonus = 0;
		for (const term of queryTokens) if (term.length > 3 && haystack.includes(term)) bonus += 0.3;

		return Math.min(1, dot / (queryNorm * Math.sqrt(docNorm)) + bonus / (1 + bonus));
	}

	labelOf(id: string): string {
		return this.labels.get(id) ?? id;
	}
}

export interface QueryOptions {
	/** Token budget for the returned text. Default 1200 — deliberately small. */
	budget?: number;
	limit?: number;
	/** Include the recipe steps in the output. Default true. */
	includeSteps?: boolean;
	scope?: "global" | "project" | "any";
}

export interface QueryHit {
	recipe: Recipe;
	score: number;
	/** Terms from the query that the recipe actually matched on. */
	matchedTerms: string[];
	/** Steps in this recipe whose text mentions a matched term, for the budget pass. */
	matchingSteps: Step[];
	/** Parameters this recipe exposes, i.e. what the caller may choose. */
	parameters: Parameter[];
	estimatedTokens: number;
}

export interface QueryResult {
	query: string;
	hits: QueryHit[];
	/** True when the budget cut the result set short. */
	truncated: boolean;
	estimatedTokens: number;
	text: string;
}

/** Score recipes against a natural-language query. */
export function rankRecipes(recipes: Recipe[], query: string): QueryHit[] {
	const tfidf = new TfIdf(recipes);
	const queryTokens = tokenize(query);
	const hits: QueryHit[] = [];

	for (const recipe of recipes) {
		const id = recipeNodeId(recipe.id, recipe.name);
		const score = tfidf.score(id, queryTokens);
		if (score <= 0) continue;

		const haystack = documentOf(recipe).toLowerCase();
		const matchedTerms = [...new Set(queryTokens)].filter((term) => haystack.includes(term));
		const matchingSteps = recipe.steps.filter((step) => {
			const text = `${step.verb} ${step.template} ${step.key}`.toLowerCase();
			return matchedTerms.some((term) => text.includes(term));
		});

		hits.push({
			recipe,
			score: Math.round(score * 10_000) / 10_000,
			matchedTerms,
			matchingSteps,
			parameters: recipe.parameters,
			estimatedTokens: estimateTokens(renderHit({ recipe, score, matchedTerms, matchingSteps, parameters: recipe.parameters, estimatedTokens: 0 })),
		});
	}

	return hits.sort((a, b) => b.score - a.score);
}

function renderHit(hit: QueryHit, graph?: RecipeGraph): string {
	const lines: string[] = [];
	const recipe = hit.recipe;
	lines.push(`### ${recipe.name} (${recipe.scope}, ${recipe.observations} observation${recipe.observations === 1 ? "" : "s"}, score ${hit.score})`);
	if (recipe.description) lines.push(recipe.description);
	lines.push(`orthogonality: ${(recipe.orthogonality * 100).toFixed(0)}% · steps: ${recipe.steps.length} · slots: ${recipe.slots.length}`);

	if (recipe.parameters.length) {
		lines.push("parameters:");
		for (const parameter of recipe.parameters) {
			const variants = parameter.variants.map((variant) => `${variant.label} (x${variant.observedIn})`).join(", ");
			lines.push(`  ${parameter.name}: ${variants}`);
		}
	}

	for (const step of recipe.steps) {
		const marker = hit.matchingSteps.includes(step) ? "*" : " ";
		lines.push(`${marker} ${step.template}`);
	}

	if (recipe.validators.length && graph === undefined) {
		lines.push(`validators: ${recipe.validators.length} (run \`pi-tape check ${recipe.name}\` to test freshness)`);
	}

	return lines.join("\n");
}

/**
 * Query the store. Ranking happens over every recipe; the result set is then
 * grown in score order until the token budget is exhausted.
 */
export function queryRecipes(
	recipes: Recipe[],
	query: string,
	options: QueryOptions = {},
): QueryResult {
	const budget = options.budget ?? 1200;
	const limit = options.limit ?? 10;
	const scope = options.scope ?? "any";

	const candidates = recipes.filter((recipe) => scope === "any" || recipe.scope === scope);
	const ranked = rankRecipes(candidates, query);

	const hits: QueryHit[] = [];
	const blocks: string[] = [];
	let spent = 0;
	let truncated = false;

	for (const hit of ranked.slice(0, limit)) {
		const block = renderHit(hit);
		const cost = estimateTokens(block);
		if (spent + cost > budget && hits.length > 0) {
			truncated = true;
			break;
		}
		hits.push(hit);
		blocks.push(block);
		spent += cost;
	}

	const header = ranked.length
		? `${ranked.length} recipe(s) matched "${query}"${truncated ? `, ${ranked.length - hits.length} left out by the token budget` : ""}`
		: `no recipe matched "${query}"`;

	return {
		query,
		hits,
		truncated,
		estimatedTokens: estimateTokens(`${header}\n${blocks.join("\n\n")}`),
		text: `${header}\n\n${blocks.join("\n\n")}`,
	};
}

/**
 * Render a recipe as concrete steps, with parameter variants substituted.
 * Unfilled slots stay as `{{name}}` so it is obvious what still needs a value.
 */
export function composeRecipe(recipe: Recipe, assignments: Record<string, string> = {}): string[] {
	const parameterValues = new Map<string, string>();
	const unmatched: string[] = [];

	for (const parameter of recipe.parameters) {
		const requested = assignments[parameter.name];
		if (requested === undefined) continue;

		const variant =
			parameter.variants.find((item) => item.label === requested) ??
			parameter.variants.find((item) => item.label.toLowerCase() === requested.toLowerCase());

		if (variant) {
			// A known variant fills every member at once, which is what makes a
			// framework swap carry its router along.
			for (const [memberKey, value] of Object.entries(variant.values)) {
				const [stepIndex, slot] = memberKey.split("#");
				parameterValues.set(`${stepIndex}#${slot}`, value);
			}
			continue;
		}

		if (!parameter.enumerated && parameter.members.length === 1) {
			// A free parameter takes whatever the caller supplies; the observed values
			// were only examples. Failing here would make `--set name=my-project`
			// impossible, which is absurd for a project name.
			const member = parameter.members[0] as { stepIndex: number; slot: string };
			parameterValues.set(`${member.stepIndex}#${member.slot}`, requested);
			continue;
		}

		unmatched.push(parameter.name);
	}

	if (unmatched.length) {
		const details = unmatched.map((name) => {
			const parameter = recipe.parameters.find((item) => item.name === name) as Parameter;
			return `${name}: one of ${parameter.variants.map((variant) => variant.label).join(", ")}`;
		});
		throw new Error(`enumerated parameter value not recognised — ${details.join("; ")}`);
	}

	const out: string[] = [];
	recipe.steps.forEach((step, stepIndex) => {
		let text = step.template;
		for (const slot of step.usesSlots) {
			const fromParameter = parameterValues.get(`${stepIndex}#${slot}`);
			if (fromParameter !== undefined) {
				text = text.replaceAll(`{{${slot}}}`, fromParameter);
				continue;
			}
			const direct = assignments[slot];
			if (direct !== undefined) text = text.replaceAll(`{{${slot}}}`, direct);
		}
		out.push(text);
	});

	return out;
}

/** Unfilled placeholders in a composed recipe, i.e. what the caller must still supply. */
export function missingInputs(steps: string[]): string[] {
	const missing = new Set<string>();
	for (const step of steps) {
		for (const match of step.matchAll(/\{\{(\w+)\}\}/g)) missing.add(match[1] as string);
	}
	return [...missing];
}

export { recipeNodeId, stepNodeId };
