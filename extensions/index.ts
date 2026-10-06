/**
 * pi-tape extension.
 *
 * Two modes:
 *
 *   record   `/tape record [name]` writes a `.tape` save-state of this session.
 *   playback `/tape play <file>` arms deterministic replay: recorded assistant
 *            answers are served by a synthetic provider, and recorded tool results
 *            are served by overriding the recorded tools.
 *
 * While replay is armed nothing leaves the machine and no provider is called.
 *
 * Limitations, stated plainly
 * ---------------------------
 * - Tool overrides last for the life of the process, because pi cannot unregister
 *   a tool. `/tape stop` disarms replay so the overrides refuse to run; `/reload`
 *   is the documented way back to the real tools.
 * - A recording made before a context compaction replays correctly, but may fall
 *   back from hash matching to position matching after the compaction point.
 * - Replayed responses keep the recorded token counts but report zero cost, so
 *   pi's session totals never claim you spent money you did not spend.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import type { AssistantMessage, AssistantMessageEventStream, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { recordSession } from "../src/record.ts";
import { checkFreshness, formatFreshness } from "../src/freshness.ts";
import { buildRecipeGraph, computeCentrality, detectCommunities, godSteps, recipeCommunities } from "../src/graph.ts";
import { extractRecipe } from "../src/recipe-extract.ts";
import { familyOrthogonality, intersectRecipes } from "../src/recipe-intersect.ts";
import { composeRecipe, unfilledGaps, queryRecipes } from "../src/recipe-query.ts";
import { bindRecipe, dangerOf, probeCommands, verifyConditions } from "../src/run.ts";
import { segmentEvidence, segmentToRecipe, sliceRecipe, parseRange } from "../src/segment.ts";
import {
	compareAnswers,
	formatRegression,
	shapeOf,
	summarizeRegression,
	type RegressionReport,
	type RegressionSample,
} from "../src/regress.ts";
import { entriesFromMessages } from "../src/replay.ts";
import {
	globalStoreDir,
	indexIsStale,
	loadRecipes,
	projectStoreDir,
	recipeFileDigests,
	saveRecipe,
	writeIndex,
} from "../src/recipe-store.ts";
import type { Recipe, RecipeIndex } from "../src/recipe-types.ts";
import { ReplayEngine } from "../src/replay.ts";
import { parseSession } from "../src/session.ts";
import { packTape, readTape, writeTape } from "../src/tape.ts";
import type { SessionFile, TapeFile } from "../src/types.ts";

const PROVIDER = "tape";
const STATUS_KEY = "tape";

/**
 * A model to compare the recording against.
 *
 * The recording is still what gets served; the live model is asked the same
 * request in parallel. That is the only way to answer "does this upgrade change
 * my behaviour?" — replay alone proves the recording is intact, not that the new
 * model agrees with it.
 */
interface Shadow {
	provider: string;
	modelId: string;
	samples: RegressionSample[];
	liveTokens: number;
	pending: number;
}

interface Armed {
	path: string;
	tape: TapeFile;
	engine: ReplayEngine;
	modelId: string;
	registeredTools: string[];
	shadow?: Shadow;
}

/** Module state: undefined means capture/live mode. */
let armed: Armed | undefined;

/**
 * The model registry, captured when a shadow run is armed.
 *
 * A shadow run needs it to ask another model the recorded request; a plain replay
 * never touches it.
 */
let liveRegistry: LiveRegistry | undefined;

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

/**
 * Build the compact "recipes first" block injected into the system prompt.
 *
 * The ordering rule is the whole point: a lookup in the local recipe store costs
 * a few hundred tokens and no network, so it has to come *before* the agent goes
 * off to search the web or re-read files. Bounded, because a context injection
 * that grows without limit is the disease, not the cure.
 */
export function recipeContext(cwd: string, budgetChars = 1800): string {
	const { recipes } = loadRecipes(cwd);
	if (!recipes.length) return "";

	const lines: string[] = [];
	lines.push("");
	lines.push("## Recipe store (checked before searching)");
	lines.push("");
	lines.push(`${recipes.length} recipe(s) learned from past sessions live in the local store.`);
	lines.push("Before searching the web or reading files for how to do something, check whether a recipe covers it:");
	lines.push("1. `tape_search` for the task — local, offline, a few hundred tokens");
	lines.push("2. `tape_show` for the full procedure and its parameters");
	lines.push("3. only then search or read files for the parts no recipe covers");
	lines.push("");
	lines.push("Recipes compose: swapping one parameter (for example a different framework, which also");
	lines.push("swaps its router) reuses everything already learned instead of re-deriving it.");
	lines.push("");

	for (const { recipe, scope } of recipes.slice(0, 12)) {
		const parameters = recipe.parameters
			.map(
				(parameter) =>
					`${parameter.name}=${parameter.variants
						.map((variant) => variant.label)
						.slice(0, 4)
						.join("|")}`,
			)
			.join(", ");
		// A recipe learned partly from runs that failed is a hypothesis, and the agent
		// is the one who decides whether that matters here.
		const outcome = recipe.outcome.failures > 0 ? `, ⚠ ${recipe.outcome.failures} failed` : "";
		lines.push(
			`- **${recipe.name}** (${scope}, ${recipe.observations} obs, ${(recipe.orthogonality * 100).toFixed(0)}% orth${outcome})` +
				(parameters ? ` — ${parameters}` : ""),
		);
	}
	if (recipes.length > 12) lines.push(`- … and ${recipes.length - 12} more`);

	// Age is part of the recipe's meaning, so it belongs in the same block: an old
	// recipe is a hypothesis, not a fact.
	const newest = recipes.reduce(
		(latest, item) => (item.recipe.updatedAt > latest ? item.recipe.updatedAt : latest),
		"",
	);
	if (newest) {
		const ageDays = Math.round(((Date.now() - Date.parse(newest)) / 86_400_000) * 10) / 10;
		lines.push("");
		lines.push(
			ageDays > 30
				? `Newest recipe is ${ageDays} days old: treat recipes as a starting point and confirm with \`tape_check\`.`
				: `Newest recipe is ${ageDays} day(s) old.`,
		);
	}

	const text = lines.join("\n");
	return text.length > budgetChars ? `${text.slice(0, budgetChars)}\n[recipe context truncated]` : text;
}

/** Rebuild the persisted index when it is out of date, so god steps stay meaningful. */
export function refreshIndexIfStale(cwd: string): { refreshed: boolean; path?: string } {
	if (!indexIsStale(cwd)) return { refreshed: false };
	const { recipes } = loadRecipes(cwd);
	if (!recipes.length) return { refreshed: false };

	const graph = buildRecipeGraph(recipes.map((item) => item.recipe));
	computeCentrality(graph);
	const communities = detectCommunities(graph);
	const families = recipeCommunities(graph, communities);
	const gods = godSteps(graph, 15);

	const index: RecipeIndex = {
		magic: "pi-tape-index",
		version: 1,
		builtAt: new Date().toISOString(),
		digests: recipeFileDigests(cwd),
		recipes: recipes.map((item) => ({
			id: item.recipe.id,
			name: item.recipe.name,
			description: item.recipe.description,
			scope: item.recipe.scope,
			path: item.path,
			observations: item.recipe.observations,
			orthogonality: item.recipe.orthogonality,
			steps: item.recipe.steps.length,
			slots: item.recipe.slots.length,
			learnedFrom: item.recipe.learnedFrom,
			cluster: communities.assignment.get(`recipe:${item.recipe.id}`),
		})),
		stepUsage: {},
		clusters: Object.fromEntries([...families].map(([id, names]) => [String(id), names])),
		godSteps: gods.map((god) => ({ key: god.key, verb: god.verb, recipes: god.recipes, centrality: god.centrality })),
		stats: {
			recipes: recipes.length,
			steps: recipes.reduce((sum, item) => sum + item.recipe.steps.length, 0),
			distinctSteps: [...graph.nodes.values()].filter((node) => node.kind === "step").length,
			clusters: families.size,
			meanOrthogonality:
				Math.round(
					(recipes.reduce((sum, item) => sum + item.recipe.orthogonality, 0) / recipes.length) * 10_000,
				) / 10_000,
		},
	};

	return { refreshed: true, path: writeIndex(globalStoreDir(), index) };
}

function findRecipeInStore(cwd: string, name: string): Recipe | undefined {
	const { recipes } = loadRecipes(cwd);
	return (
		recipes.find((item) => item.recipe.name === name)?.recipe ??
		recipes.find((item) => item.recipe.name.toLowerCase().includes(name.toLowerCase()))?.recipe
	);
}

interface RecipeToolContext {
	cwd: string;
}

function textResult(text: string, details: Record<string, unknown>, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function registerRecipeTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "tape_search",
		label: "Search Tape Library",
		description:
			"Search the local recipe store for a procedure learned from past sessions. " +
			"Local, offline and cheap: use this before searching the web or reading files.",
		parameters: Type.Object({
			query: Type.String({ description: "What you are trying to do, in natural language" }),
			budget: Type.Optional(Type.Number({ description: "Token budget for the result. Default 900." })),
		}),
		annotations: { readOnlyHint: true },
		async execute(
			_id: string,
			params: { query: string; budget?: number },
			_signal: unknown,
			_update: unknown,
			ctx: RecipeToolContext,
		) {
			const { recipes, errors } = loadRecipes(ctx.cwd);
			if (!recipes.length) {
				return textResult(
					"The recipe store is empty.\n" +
						`  global   ${globalStoreDir()}\n` +
						`  project  ${projectStoreDir(ctx.cwd)}\n` +
						"Learn one from a recording first: `pi-tape splice <tape...> --save`.",
					{ matched: 0, errors },
				);
			}

			const result = queryRecipes(
				recipes.map((item) => item.recipe),
				params.query,
				{ budget: params.budget ?? 900, limit: 6 },
			);
			return textResult(`${result.text}\n\n(~${result.estimatedTokens} tokens)`, {
				matched: result.hits.length,
				truncated: result.truncated,
			});
		},
	});

	pi.registerTool({
		name: "tape_show",
		label: "Show Recipe",
		description: "Show one recipe from the local store: its steps, parameters and variants.",
		parameters: Type.Object({ name: Type.String({ description: "Recipe name, or a distinctive part of it" }) }),
		annotations: { readOnlyHint: true },
		async execute(
			_id: string,
			params: { name: string },
			_signal: unknown,
			_update: unknown,
			ctx: RecipeToolContext,
		) {
			const recipe = findRecipeInStore(ctx.cwd, params.name);
			if (!recipe) return textResult(`No recipe matching "${params.name}".`, { found: false }, true);

			const lines: string[] = [];
			lines.push(`${recipe.name} (${recipe.scope}, ${recipe.observations} observation(s))`);
			if (recipe.description) lines.push(recipe.description);
			lines.push(`orthogonality ${(recipe.orthogonality * 100).toFixed(0)}%`);
			lines.push("");
			recipe.steps.forEach((step, index) => lines.push(`${index}. ${step.template}`));

			if (recipe.parameters.length) {
				lines.push("");
				lines.push("parameters:");
				for (const parameter of recipe.parameters) {
					lines.push(
						`  ${parameter.name}${parameter.enumerated ? " (choose one)" : " (free value)"}: ` +
							parameter.variants.map((variant) => variant.label).join(", "),
					);
				}
			}

			return textResult(lines.join("\n"), { name: recipe.name, parameters: recipe.parameters.length });
		},
	});

	pi.registerTool({
		name: "tape_dub",
		label: "Dub Recipe Variant",
		description:
			"Render a recipe as concrete steps with parameter values substituted. " +
			"An enumerated parameter swaps every slot in its group at once; a free parameter accepts any value.",
		parameters: Type.Object({
			name: Type.String({ description: "Recipe name" }),
			set: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description: 'Parameter assignments, e.g. { "template": "react@latest", "name": "my-app" }',
				}),
			),
		}),
		annotations: { readOnlyHint: true },
		async execute(
			_id: string,
			params: { name: string; set?: Record<string, string> },
			_signal: unknown,
			_update: unknown,
			ctx: RecipeToolContext,
		) {
			const recipe = findRecipeInStore(ctx.cwd, params.name);
			if (!recipe) return textResult(`No recipe matching "${params.name}".`, { found: false }, true);

			try {
				const steps = composeRecipe(recipe, params.set ?? {});
				// A placeholder is not just "something missing": a secret, a path and a
				// project name each need a different action from whoever fills them, and
				// the agent is the one who has to decide which it is looking at.
				const gaps = unfilledGaps(recipe, steps);
				const body = [`${recipe.name} — ${steps.length} step(s)`, "", ...steps.map((step, index) => `${index}. ${step}`)];
				if (gaps.length) {
					body.push("", "still unfilled:");
					for (const gap of gaps) body.push(`  [${gap.kind}] ${gap.name}: ${gap.hint}`);
					body.push(
						`available parameters: ${recipe.parameters.map((item) => item.name).join(", ") || "(none)"}`,
					);
				}
				return textResult(body.join("\n"), { steps: steps.length, gaps });
			} catch (error) {
				const options = recipe.parameters
					.map((item) => `${item.name}: ${item.variants.map((variant) => variant.label).join(", ")}`)
					.join("; ");
				return textResult(`${(error as Error).message}\n\n${options}`, { error: true }, true);
			}
		},
	});

	pi.registerTool({
		name: "tape_check",
		label: "Check Recipe Freshness",
		description:
			"Check whether a recipe is still valid by running its dependency validators. " +
			"Use it when about to rely on a recipe that may be old.",
		parameters: Type.Object({
			name: Type.String({ description: "Recipe name" }),
			dryRun: Type.Optional(Type.Boolean({ description: "List the checks without running them" })),
		}),
		annotations: { readOnlyHint: true, openWorldHint: true },
		async execute(
			_id: string,
			params: { name: string; dryRun?: boolean },
			_signal: unknown,
			_update: unknown,
			ctx: RecipeToolContext,
		) {
			const recipe = findRecipeInStore(ctx.cwd, params.name);
			if (!recipe) return textResult(`No recipe matching "${params.name}".`, { found: false }, true);

			const report = await checkFreshness(recipe, { dryRun: params.dryRun === true, timeoutMs: 20_000 });
			return textResult(formatFreshness(report), { status: report.status, ageDays: report.ageDays });
		},
	});

	pi.registerTool({
		name: "tape_splice",
		label: "Splice Tapes into Recipe",
		description:
			"Learn a recipe from one or more tape recordings. With several recordings of the " +
			"same kind of task it intersects them into a skeleton plus composable parameters.",
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { description: "Paths to .tape files" }),
			name: Type.Optional(Type.String({ description: "Recipe name" })),
			scope: Type.Optional(
				Type.Union([Type.Literal("global"), Type.Literal("project")], {
					description: "Where to store it. Default project.",
				}),
			),
			minSupport: Type.Optional(
				Type.Number({ description: "Fraction of recordings a step must appear in. Default 0.6." }),
			),
		}),
		async execute(
			_id: string,
			params: { paths: string[]; name?: string; scope?: "global" | "project"; minSupport?: number },
			_signal: unknown,
			_update: unknown,
			ctx: RecipeToolContext,
		) {
			if (!params.paths.length) return textResult("No recordings given.", { error: true }, true);

			const scope = params.scope ?? "project";
			const tapes: TapeFile[] = [];
			for (const path of params.paths) {
				try {
					tapes.push(readTape(path));
				} catch (error) {
					return textResult(`Could not read ${path}: ${(error as Error).message}`, { error: true }, true);
				}
			}

			const extracted = tapes.map((tape) => extractRecipe(tape, { name: params.name ?? tape.name, scope }).recipe);
			let recipe: Recipe;
			let summary: string;

			if (extracted.length === 1) {
				recipe = extracted[0] as Recipe;
				summary = `recorded "${recipe.name}" from 1 tape: ${recipe.steps.length} steps, ${recipe.slots.length} slots`;
			} else {
				const result = intersectRecipes(extracted, {
					...(params.name === undefined ? {} : { name: params.name }),
					scope,
					minSupport: params.minSupport ?? 0.6,
				});
				recipe = result.recipe;
				recipe.orthogonality = familyOrthogonality(extracted);
				summary = [
					`spliced "${recipe.name}" from ${extracted.length} tapes`,
					`  skeleton       ${result.sharedSteps} of max ${result.longestSteps} steps`,
					`  orthogonality  ${(recipe.orthogonality * 100).toFixed(1)}%`,
					`  parameters     ${recipe.parameters.map((parameter) => parameter.name).join(", ") || "(none)"}`,
					`  noise excluded ${result.noiseExcluded}`,
				].join("\n");
			}

			const storeDir = scope === "global" ? globalStoreDir() : projectStoreDir(ctx.cwd);
			const saved = saveRecipe(storeDir, recipe);
			// A new recipe makes the index stale; rebuild it here so later queries do not pay.
			const refreshed = refreshIndexIfStale(ctx.cwd);

			return textResult(
				`${summary}\n\nsaved → ${saved.path}${refreshed.refreshed ? `\nindex rebuilt → ${refreshed.path}` : ""}`,
				{
					name: recipe.name,
					steps: recipe.steps.length,
					parameters: recipe.parameters.length,
					path: saved.path,
				},
			);
		},
	});

	pi.registerTool({
		name: "tape_plan",
		label: "Plan a Recipe Run",
		description:
			"Work out what running a recipe would take: which gaps are still open and what kind each is, " +
			"which tools this machine has, and which steps are pi tool calls rather than shell commands. " +
			"Runs nothing. Use it before executing a learned procedure, and to decide what to fill in.",
		parameters: Type.Object({
			name: Type.String({ description: "Recipe name" }),
			set: Type.Optional(
				Type.Record(Type.String(), Type.String(), { description: "Values to fill in, e.g. { \"token\": \"…\" }" }),
			),
			cwd: Type.Optional(Type.String({ description: "Directory the procedure would run in. Defaults to the working directory." })),
		}),
		annotations: { readOnlyHint: true },
		async execute(
			_id: string,
			params: { name: string; set?: Record<string, string>; cwd?: string },
			_signal: unknown,
			_update: unknown,
			ctx: RecipeToolContext,
		) {
			const recipe = findRecipeInStore(ctx.cwd, params.name);
			if (!recipe) return textResult(`No recipe matching "${params.name}".`, { found: false }, true);

			const cwd = params.cwd ?? ctx.cwd;
			const bound = bindRecipe(recipe, { set: params.set ?? {} });
			const probe = await probeCommands(
				recipe.contracts.requires.filter((item) => item.kind === "command").map((item) => item.target),
				{ cwd },
			);

			const lines = [`${recipe.name} — ${bound.steps.length} step(s) in ${cwd}`, ""];
			if (bound.notes.length) {
				lines.push("bound:");
				for (const note of bound.notes) lines.push(`  · ${note}`);
			}
			if (bound.gaps.length) {
				lines.push("", "still open:");
				for (const gap of bound.gaps) lines.push(`  [${gap.kind}] ${gap.name}: ${gap.hint}`);
			}
			if (probe.length) {
				lines.push("", "this machine:");
				for (const item of probe) lines.push(`  ${item.status === "available" ? "✓" : item.status === "missing" ? "✗" : "?"} ${item.command}`);
			}
			lines.push("", "steps:");
			bound.steps.forEach((step, index) => {
				const source = recipe.steps[index];
				const danger = source && source.kind === "command" ? dangerOf(step) : undefined;
				const marks = [source && source.kind !== "command" ? `→ agent (${source.kind})` : "", danger ? `⚠ ${danger}` : ""]
					.filter(Boolean)
					.join(" · ");
				lines.push(`  ${index}. ${step}${marks ? `   ${marks}` : ""}`);
			});
			lines.push(
				"",
				"After running the steps, these are the conditions to check:",
				...recipe.contracts.provides.map((item) => `  ${item.kind} ${item.target}`),
			);

			return textResult(lines.join("\n"), {
				gaps: bound.gaps,
				probe,
				steps: bound.steps.length,
				provides: recipe.contracts.provides,
			});
		},
	});

	pi.registerTool({
		name: "tape_segment",
		label: "Segment a Recipe",
		description:
			"Cut a recipe into parts with an intent, so a part can be carried into another composition. " +
			"Call it without cuts first: it returns the numbered steps and their contracts, which is what " +
			"you need to decide where the boundaries are. Then call it again with cuts to store the parts.",
		parameters: Type.Object({
			name: Type.String({ description: "Recipe name" }),
			cuts: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Step ranges that must tile the recipe, e.g. ["0-1", "2-3"]. Omit to get the evidence.',
				}),
			),
			intents: Type.Optional(
				Type.Array(Type.String(), { description: "One line per cut, on what that part is for. Becomes its name." }),
			),
			save: Type.Optional(Type.Boolean({ description: "Store each part as its own recipe. Default false." })),
			requireCoverage: Type.Optional(
				Type.Boolean({ description: "Refuse if the cuts do not cover every step. Default false (extraction)." }),
			),
			scope: Type.Optional(Type.String({ description: "global or project (default project)" })),
		}),
		annotations: { readOnlyHint: true },
		async execute(
			_id: string,
			params: {
				name: string;
				cuts?: string[];
				intents?: string[];
				save?: boolean;
				scope?: string;
				requireCoverage?: boolean;
			},
			_ctx: unknown,
			_update: unknown,
			ctx: RecipeToolContext,
		) {
			const recipe = findRecipeInStore(ctx.cwd, params.name);
			if (!recipe) return textResult(`No recipe matching "${params.name}".`, { found: false }, true);

			if (!params.cuts?.length) {
				return textResult(`${segmentEvidence(recipe)}\n\nPropose boundaries as ranges that cover every step exactly once.`, {
					steps: recipe.steps.length,
					parameters: recipe.parameters.map((parameter) => parameter.name),
				});
			}

			let result;
			try {
				result = sliceRecipe(
					recipe,
					params.cuts.map((value, index) => {
						const range = parseRange(value);
						const intent = params.intents?.[index];
						return { ...range, name: `${recipe.name}-${range.from}-${range.to}`, ...(intent === undefined ? {} : { intent }) };
					}),
				);
			} catch (error) {
				return textResult(`${(error as Error).message}\n\n${segmentEvidence(recipe)}`, { error: true }, true);
			}

			const lines: string[] = [`segmented "${recipe.name}" into ${result.segments.length} part(s)`, ""];
			for (const segment of result.segments) {
				lines.push(`${segment.name} (steps ${segment.from}-${segment.to})${segment.intent ? ` — ${segment.intent}` : ""}`);
				for (const step of segment.steps) lines.push(`  · ${step.template}`);
				const needs = segment.contracts.requires.map((item) => `${item.kind} ${item.target}`);
				const gives = segment.contracts.provides.map((item) => `${item.kind} ${item.target}`);
				if (needs.length) lines.push(`  needs ${needs.join(", ")}`);
				if (gives.length) lines.push(`  gives ${gives.join(", ")}`);
			}
			if (result.uncovered.length) {
				lines.push("", `not in any segment: ${result.uncovered.map((range) => `${range.from}-${range.to}`).join(", ")}`);
			}
			if (result.droppedParameters.length) {
				lines.push("", "a cut split a parameter that has to move together:");
				for (const item of result.droppedParameters) lines.push(`  ! ${item.name}: ${item.reason}`);
			}

			if (params.save) {
				const scope = params.scope === "global" ? "global" : "project";
				const storeDir = scope === "global" ? globalStoreDir() : projectStoreDir(ctx.cwd);
				for (const segment of result.segments) {
					const saved = saveRecipe(storeDir, segmentToRecipe(segment, { scope }));
					lines.push(`saved ${segment.name} → ${saved.path}`);
				}
				const refreshed = refreshIndexIfStale(ctx.cwd);
				if (refreshed.refreshed) lines.push(`index rebuilt → ${refreshed.path}`);
			}

			return textResult(lines.join("\n"), {
				segments: result.segments.map((segment) => ({ name: segment.name, from: segment.from, to: segment.to })),
				droppedParameters: result.droppedParameters,
			});
		},
	});
}

// ---------------------------------------------------------------------------
// Replay provider
// ---------------------------------------------------------------------------

function zeroCost(message: AssistantMessage): AssistantMessage {
	const copy = structuredClone(message);
	copy.usage = {
		...copy.usage,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return copy;
}

async function notifyObserver(
	options: { onProviderStreamEvent?: (event: unknown, model: unknown) => unknown } | undefined,
	event: unknown,
	model: unknown,
): Promise<void> {
	try {
		await options?.onProviderStreamEvent?.(event, model);
	} catch {
		// Observation must never break a replay.
	}
}

/**
 * Turn a recorded assistant message into a well-formed event stream.
 *
 * Content is emitted the way a real provider does: blocks start empty and grow
 * through their deltas, so progressive renderers stay correct.
 */
function createReplayStream(
	model: { api: string; provider: string; id: string },
	context: { messages: unknown[] },
	options: { onProviderStreamEvent?: (event: unknown, model: unknown) => unknown } | undefined,
	active: Armed,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	void (async () => {
		const outcome = active.engine.nextAssistantFromMessages(context.messages);

		if (outcome.kind === "miss") {
			const failure: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: `tape: ${outcome.reason}` }],
				api: model.api as AssistantMessage["api"],
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: `tape: ${outcome.reason}. The replay left the recording; replay a fork, or record a new tape.`,
				timestamp: Date.now(),
			};
			stream.push({ type: "error", reason: "error", error: failure });
			stream.end();
			return;
		}

		const recorded = (outcome.entry.message ?? {}) as AssistantMessage;
		const output = zeroCost(recorded);
		output.content = [];
		output.api = model.api as AssistantMessage["api"];
		output.stopReason = "pending";

		stream.push({ type: "start", partial: output });

		const recordedBlocks = (recorded.content ?? []) as unknown as Array<Record<string, unknown>>;

		for (const block of recordedBlocks) {
			const index = output.content.length;

			if (block.type === "text") {
				const text = String(block.text ?? "");
				output.content.push({ type: "text", text: "" });
				await notifyObserver(options, { type: "text_start", index }, model);
				(output.content[index] as { type: "text"; text: string }).text = text;
				stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
				stream.push({ type: "text_end", contentIndex: index, content: text, partial: output });
				continue;
			}

			if (block.type === "thinking") {
				const thinking = String(block.thinking ?? "");
				const signature = typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined;
				output.content.push({ type: "thinking", thinking: "", ...(signature ? { thinkingSignature: signature } : {}) });
				await notifyObserver(options, { type: "thinking_start", index }, model);
				(output.content[index] as { type: "thinking"; thinking: string }).thinking = thinking;
				stream.push({ type: "thinking_delta", contentIndex: index, delta: thinking, partial: output });
				stream.push({ type: "thinking_end", contentIndex: index, content: thinking, partial: output });
				continue;
			}

			if (block.type === "toolCall") {
				const call: ToolCall = {
					type: "toolCall",
					id: String(block.id ?? `call_${index}`),
					name: String(block.name ?? ""),
					arguments: {},
					...(typeof block.namespace === "string" ? { namespace: block.namespace } : {}),
				};
				output.content.push(call);
				await notifyObserver(options, { type: "toolcall_start", index }, model);
				const args = (block.arguments ?? {}) as Record<string, unknown>;
				call.arguments = args as ToolCall["arguments"];
				stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(args), partial: output });
				stream.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial: output });
				continue;
			}

			// Unknown block types are preserved verbatim rather than dropped.
			output.content.push(block as never);
		}

		const reason = recorded.stopReason;
		output.stopReason =
			reason === "stop" || reason === "length" || reason === "toolUse" || reason === "deferred" ? reason : "stop";

		stream.push({ type: "done", reason: output.stopReason, message: output });
		stream.end();
	})();

	return stream;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let cachedPiVersion: string | undefined;
function piVersion(): string | undefined {
	if (cachedPiVersion !== undefined) return cachedPiVersion;
	try {
		const require = createRequire(import.meta.url);
		const entry = require.resolve("@earendil-works/pi-coding-agent/package.json");
		const pkg = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version?: string };
		cachedPiVersion = pkg.version;
	} catch {
		cachedPiVersion = undefined;
	}
	return cachedPiVersion;
}

function headerOf(ctx: ExtensionCommandContext): Record<string, unknown> {
	return { id: ctx.sessionManager.getSessionId(), timestamp: new Date().toISOString(), cwd: ctx.cwd };
}

function sessionFromManager(entries: unknown[], header: Record<string, unknown>): SessionFile {
	const lines = [
		JSON.stringify({ type: "session", version: 3, ...header }),
		...entries.map((entry) => JSON.stringify(entry)),
	];
	return parseSession(lines.join("\n"), "<in-memory>");
}

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48) || "tape"
	);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function recordCommand(args: string, ctx: ExtensionCommandContext): void {
	const branch = ctx.sessionManager.getBranch();
	if (!branch.length) {
		ctx.ui.notify("Nothing to record: this session has no entries yet.", "warning");
		return;
	}

	// Prefer the session file: it carries the other branches too, which is what
	// lets you capture a different arm later.
	const file = ctx.sessionManager.getSessionFile();
	let session: SessionFile;
	if (file) {
		try {
			session = parseSession(readFileSync(file, "utf8"), file);
		} catch (error) {
			session = sessionFromManager(branch, headerOf(ctx));
			ctx.ui.notify(
				`Could not read the session file, capturing the in-memory branch instead: ${(error as Error).message}`,
				"warning",
			);
		}
	} else {
		session = sessionFromManager(branch, headerOf(ctx));
	}

	const redact = /(^|\s)--redact(\s|$)/.test(args);
	const name = args.replace(/(^|\s)--redact(\s|$)/, " ").trim() || undefined;
	const result = recordSession(session, { name, piVersion: piVersion(), redact });
	const out = join(ctx.cwd, `${slugify(result.tape.name ?? result.tape.id.slice(7, 19))}.tape`);

	try {
		writeTape(out, result.tape);
	} catch (error) {
		ctx.ui.notify(`Could not write ${out}: ${(error as Error).message}`, "error");
		return;
	}

	const packed = packTape(result.tape);
	ctx.ui.notify(
		[
			`tape recorded → ${out}`,
			`  ${result.path.length} entries · ${(packed.length / 1024).toFixed(1)} KiB · profile ${result.tape.profile}${result.tape.lossy ? " (lossy)" : ""}`,
			`  ${result.tape.stats.assistantMessages} assistant / ${result.tape.stats.toolResults} tool results · $${result.tape.stats.costUsd.toFixed(4)}`,
			`  outcome ${result.tape.outcome?.status ?? "unknown"}${result.tape.outcome?.evidence[0] ? ` — ${result.tape.outcome.evidence[0]}` : ""}`,
			redact ? "  credentials replaced by [redacted]; the tape is lossy but safe to share" : "",
			result.branchPoints > 0 ? `  ${result.branchPoints} branch point(s) on this path` : "",
		]
			.filter(Boolean)
			.join("\n"),
		"info",
	);
}

/**
 * Resolve a tape reference against the session's working directory, not the
 * process working directory: the user typed the name while sitting in their
 * project, and that is where `/tape record` put the file.
 */
function resolveTapePath(reference: string, baseDir: string): string {
	if (reference.startsWith("/")) return resolve(reference);
	if (reference.includes("/")) return resolve(baseDir, reference);
	return resolve(baseDir, reference.endsWith(".tape") ? reference : `${reference}.tape`);
}

function playCommand(
	pi: ExtensionAPI,
	reference: string,
	ctx: ExtensionCommandContext,
	shadowTarget?: { provider: string; modelId: string },
): void {
	if (!reference.trim()) {
		ctx.ui.notify("Usage: /tape play <file.tape>", "warning");
		return;
	}
	if (armed) {
		ctx.ui.notify(`Replay is already armed from ${armed.path}. Run /tape stop and /reload to start over.`, "warning");
		return;
	}

	const path = resolveTapePath(reference.trim(), ctx.cwd);
	let tape: TapeFile;
	try {
		tape = readTape(path);
	} catch (error) {
		ctx.ui.notify(`Could not load ${path}: ${(error as Error).message}`, "error");
		return;
	}

	const engine = new ReplayEngine(tape);
	const recordedModels = tape.stats.models;
	const modelId = recordedModels[0] ?? "replay";
	const active: Armed = { path, tape, engine, modelId, registeredTools: [] };
	if (shadowTarget) {
		active.shadow = { ...shadowTarget, samples: [], liveTokens: 0, pending: 0 };
		liveRegistry = ctx.modelRegistry as unknown as LiveRegistry;
	}
	armed = active;

	pi.registerProvider(PROVIDER, {
		baseUrl: "tape://local",
		apiKey: "not-needed-replay-is-offline",
		api: "tape-replay",
		models: (recordedModels.length ? recordedModels : [modelId]).map((id) => ({
			id,
			name: `${id} (tape replay)`,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		})),
		streamSimple: (model, context, options) => {
			const current = armed;
			if (!current) throw new Error("tape: replay is not armed");
			// The recorded answer is served either way; the shadow call only observes.
			if (current.shadow && liveRegistry) {
				void observeWithLiveModel(current, liveRegistry, context as { messages: unknown[] }, options);
			}
			return createReplayStream(
				model as unknown as { api: string; provider: string; id: string },
				context as unknown as { messages: unknown[] },
				options as never,
				current,
			);
		},
	});

	// Override every tool the recording used with a cache-backed stand-in.
	for (const name of engine.toolNames()) {
		const declaration = engine.toolDeclaration(name);
		const parameters =
			declaration && typeof declaration.parameters === "object" && declaration.parameters !== null
				? Type.Unsafe(declaration.parameters as never)
				: Type.Object({}, { additionalProperties: true });

		pi.registerTool({
			name,
			label: `${name} (replay)`,
			description:
				typeof declaration?.description === "string" ? declaration.description : `Recorded stand-in for ${name}`,
			parameters,
			async execute(toolCallId: string) {
				const current = armed;
				if (!current) {
					return {
						content: [{ type: "text", text: "tape: replay is disarmed; run /reload to restore the real tools." }],
						details: { tape: "disarmed" },
						isError: true,
					};
				}

				const outcome = current.engine.nextToolResultById(toolCallId);
				if (outcome.kind === "miss") {
					return {
						content: [{ type: "text", text: `tape: ${outcome.reason}` }],
						details: { tape: "miss" },
						isError: true,
					};
				}

				const message = (outcome.entry.message ?? {}) as Record<string, unknown>;
				return {
					content: (Array.isArray(message.content) ? message.content : []) as never,
					details: (message.details ?? { tape: "replayed" }) as never,
					...(message.isError === true ? { isError: true } : {}),
				};
			},
		});
		active.registeredTools.push(name);
	}

	ctx.ui.setStatus(STATUS_KEY, `replay: ${tape.name ?? tape.id.slice(7, 15)}`);
	ctx.ui.notify(
		[
			`tape armed → ${path}`,
			`  recorded      ${tape.stats.assistantMessages} assistant / ${tape.stats.toolResults} tool results · $${tape.stats.costUsd.toFixed(4)}`,
			`  tools replaced ${active.registeredTools.join(", ") || "(none)"}`,
			"",
			`Next: run  /model ${PROVIDER}/${modelId}`,
			"then send the original first prompt. Every answer comes from the recording.",
			"Leaving replay requires /reload — pi cannot unregister a tool.",
		].join("\n"),
		"info",
	);
}


// ---------------------------------------------------------------------------
// Shadow: asking a different model the same request
// ---------------------------------------------------------------------------

/**
 * The part of the model registry this file needs.
 *
 * Typed structurally so the file does not depend on pi's internal declarations,
 * and so a missing method is a compile error here instead of a runtime surprise
 * in the middle of a replay.
 */
interface LiveRegistry {
	find(provider: string, modelId: string): unknown;
	streamSimple(model: unknown, context: unknown, options?: unknown): AsyncIterable<unknown>;
}

/** Consume a provider stream, keeping the last whole message it produced. */
async function collectLiveAnswer(
	stream: AsyncIterable<unknown>,
): Promise<{ message: unknown; tokens: number }> {
	let last: unknown;
	for await (const event of stream) {
		const item = event as { type?: string; message?: unknown; error?: unknown; partial?: unknown };
		if (item.type === "done") last = item.message;
		else if (item.type === "error") last = item.error;
		else if (item.partial !== undefined) last = item.partial;
	}
	const usage = (last as { usage?: { input?: number; output?: number; totalTokens?: number } } | undefined)?.usage;
	const tokens = usage ? (usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0)) : 0;
	return { message: last, tokens };
}

/** A short label for a turn, so a report can be navigated. */
function labelOfTurn(recorded: unknown, index: number): string {
	const shape = shapeOf(recorded as never);
	const first = shape.text.split("\n")[0] ?? "";
	const calls = shape.toolCalls.map((call) => call.name).join(", ");
	return `#${index}${calls ? ` [${calls}]` : ""}${first ? ` ${first.slice(0, 70)}` : ""}`;
}

/**
 * Ask the shadow model the same request the recording answers.
 *
 * Runs in the background: the recorded answer is served immediately, so the run
 * follows the recorded trajectory, and the comparison is collected for later. It
 * costs real tokens, which the report says out loud.
 */
async function observeWithLiveModel(
	active: Armed,
	registry: LiveRegistry,
	context: { messages: unknown[] },
	options: unknown,
): Promise<void> {
	const shadow = active.shadow;
	if (!shadow) return;

	const target = registry.find(shadow.provider, shadow.modelId);
	if (!target) {
		shadow.pending = -1;
		return;
	}

	// The answer the replay is about to serve, looked up without consuming it.
	const prefix = entriesFromMessages(context.messages);
	const recorded = active.engine.peekAssistant(prefix);
	if (!recorded) return;

	shadow.pending++;
	try {
		const stream = registry.streamSimple(target, context, options);
		const live = await collectLiveAnswer(stream);
		shadow.liveTokens += live.tokens;
		shadow.samples.push({
			label: labelOfTurn(recorded, shadow.samples.length + 1),
			divergences: compareAnswers(shapeOf(recorded), shapeOf(live.message as never)),
		});
	} catch (error) {
		shadow.samples.push({
			label: labelOfTurn(recorded, shadow.samples.length + 1),
			divergences: [
				{ kind: "error", detail: "the shadow call failed", recorded: "(answered)", live: (error as Error).message },
			],
		});
	} finally {
		shadow.pending--;
	}
}

function shadowReport(active: Armed): RegressionReport {
	const report: RegressionReport = {
		tape: active.tape.name ?? active.tape.id.slice(7, 19),
		recordedModel: active.tape.stats.models[0] ?? "(unknown)",
		liveModel: active.shadow ? `${active.shadow.provider}/${active.shadow.modelId}` : "(none)",
		samples: active.shadow?.samples ?? [],
		structuralDivergences: 0,
		wordingDivergences: 0,
		identical: 0,
		liveTokens: active.shadow?.liveTokens ?? 0,
	};
	return summarizeRegression(report);
}

function statusCommand(ctx: ExtensionCommandContext): void {
	if (!armed) {
		ctx.ui.notify("tape: record mode. Use /tape record [name], or /tape play <file.tape>.", "info");
		return;
	}

	const status = armed.engine.status();
	const misses = armed.engine.diagnostics;
	ctx.ui.notify(
		[
			`tape replay ← ${armed.path}`,
			`  assistant  ${status.assistantConsumed}/${status.assistantTotal} served`,
			`  tools      ${status.toolConsumed}/${status.toolTotal} served`,
			`  misses     ${misses.length}`,
			...misses.slice(-3).map((miss) => `    · [${miss.kind}] ${miss.detail}`),
			`  recorded   $${armed.tape.stats.costUsd.toFixed(4)} (this replay cost $0)`,
			armed.shadow
				? `  shadow     ${armed.shadow.samples.length}/${armed.engine.assistantCount} compared against ` +
					`${armed.shadow.provider}/${armed.shadow.modelId} · ${armed.shadow.liveTokens} tokens spent`
				: "",
		]
			.filter(Boolean)
			.join("\n"),
		misses.length ? "warning" : "info",
	);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	registerRecipeTools(pi);

	// The ordering rule from the README, enforced where it can actually take effect:
	// recipes are consulted before the agent reaches for the web or the filesystem.
	pi.on("before_agent_start", (event, ctx) => {
		if (armed) return;
		const block = recipeContext(ctx.cwd);
		if (!block) return;
		const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
		return { systemPrompt: `${systemPrompt}${block}` };
	});

	pi.registerCommand("tape", {
		description: "Tape: capture this session, or replay a recorded one",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const space = trimmed.indexOf(" ");
			const sub = space === -1 ? trimmed : trimmed.slice(0, space);
			const rest = space === -1 ? "" : trimmed.slice(space + 1);

			switch (sub) {
				case "record":
					recordCommand(rest, ctx);
					return;
				case "play":
					playCommand(pi, rest, ctx);
					return;
				case "shadow": {
					// `--model provider/id` names the model to compare against; the
					// recording is still what gets served.
					const parts = rest.trim().split(/\s+/).filter(Boolean);
					const modelArgument = parts.find((part) => part === "--model" || part.startsWith("--model="));
					const modelValue =
						modelArgument === "--model"
							? parts[parts.indexOf("--model") + 1]
							: modelArgument?.slice("--model=".length);
					const file = parts.filter((part) => part !== "--model" && part !== modelValue).join(" ");
					if (!modelValue || !modelValue.includes("/")) {
						ctx.ui.notify(
							"Usage: /tape shadow <file.tape> --model <provider>/<model>\n" +
								"The recording is served as usual; the named model is asked the same requests.",
							"warning",
						);
						return;
					}
					const [provider, ...idParts] = modelValue.split("/");
					playCommand(pi, file, ctx, { provider: provider as string, modelId: idParts.join("/") });
					return;
				}
				case "regress": {
					if (!armed) {
						ctx.ui.notify("Nothing armed. Start one with /tape shadow <file.tape> --model <provider>/<model>.", "warning");
						return;
					}
					if (!armed.shadow) {
						ctx.ui.notify("This run is not in shadow mode, so there is nothing to compare.", "warning");
						return;
					}
					if (armed.shadow.pending !== 0) {
						ctx.ui.notify(`${armed.shadow.pending} comparison(s) still running; try again in a moment.`, "info");
						return;
					}
					ctx.ui.notify(formatRegression(shadowReport(armed)), "info");
					return;
				}
				case "status":
					statusCommand(ctx);
					return;
				case "stop":
					if (!armed) {
						ctx.ui.notify("tape: nothing to disarm.", "info");
						return;
					}
					pi.unregisterProvider(PROVIDER);
					armed = undefined;
					liveRegistry = undefined;
					ctx.ui.setStatus(STATUS_KEY, undefined);
					ctx.ui.notify(
						"Replay disarmed. Tool overrides stay registered until /reload, and will refuse to run.",
						"info",
					);
					return;
				case "library": {
					const { recipes, errors } = loadRecipes(ctx.cwd);
					if (!recipes.length) {
						ctx.ui.notify(`No recipes yet.\n  global   ${globalStoreDir()}\n  project  ${projectStoreDir(ctx.cwd)}`, "info");
						return;
					}
					ctx.ui.notify(
						[
							`${recipes.length} recipe(s)`,
							...recipes.map(
								({ recipe, scope }) =>
									`  ${recipe.name} (${scope}, ${recipe.observations} obs, ${recipe.steps.length} steps, ${recipe.parameters.length} params)`,
							),
							...errors.map((error) => `  ! ${error.path}: ${error.message}`),
						].join("\n"),
						errors.length ? "warning" : "info",
					);
					return;
				}
				case "index": {
					const result = refreshIndexIfStale(ctx.cwd);
					if (!result.refreshed) {
						const { recipes } = loadRecipes(ctx.cwd);
						ctx.ui.notify(
							recipes.length ? "Recipe index is already up to date." : "No recipes to index yet.",
							"info",
						);
						return;
					}
					ctx.ui.notify(`Recipe index rebuilt → ${result.path}`, "info");
					return;
				}
				default:
					ctx.ui.notify(
						[
							"tape — recordings, replay and recipes for pi sessions",
							"",
							"  /tape record [--redact]  save this session as a .tape file",
							"  /tape play <file>        arm deterministic replay from a recording",
							"  /tape shadow <file> --model <provider>/<model>",
							"                           replay, and ask another model the same requests",
							"  /tape regress            what the shadow model answered differently",,
							"  /tape status             replay progress, misses, shadow progress",
							"  /tape stop               disarm (then /reload to restore real tools)",
							"  /tape library            list the recipe store",
							"  /tape index              rebuild the recipe graph index",
							"",
							"Tools: tape_search, tape_show, tape_dub, tape_check, tape_splice,",
							"       tape_plan, tape_segment",,
							"CLI:   pi-tape sessions | record | inspect | verify | diff",
							"       pi-tape splice | link | segment | run | library | show | dub",
							"       pi-tape search | index | check",,
							].join("\n"),
						"info",
					);
			}
		},
	});

	pi.on("session_shutdown", () => {
		armed = undefined;
		liveRegistry = undefined;
	});
}
