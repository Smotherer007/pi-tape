/**
 * pi-tape extension.
 *
 * Three modes, one command (`/tape`), seven tools and one hook.
 *
 *   record   `/tape record [name] [--redact]` writes a `.tape` save-state of this
 *            session. `--redact` replaces credentials before the file is written,
 *            which makes the tape shareable and marks it lossy.
 *   playback `/tape play <file>` arms deterministic replay: recorded assistant
 *            answers are served by a synthetic provider, and recorded tool results
 *            are served by overriding the recorded tools. While replay is armed
 *            nothing leaves the machine and no provider is called.
 *   shadow   `/tape shadow <file> --model <provider>/<model>` serves the recording
 *            as usual *and* asks the named model the same requests through
 *            ctx.modelRegistry. `/tape regress` reports where the two diverge,
 *            separating "changed what it would do" from "said it differently". The
 *            comparison is tested; this wiring is the least proven part of the
 *            project, and it costs real tokens.
 *
 * The tools are for the agent, and they are all read-only:
 *
 *   tape_search   is this in the store?        tape_splice   learn a family
 *   tape_show     what is the procedure?       tape_check    is it still true?
 *   tape_dub      what with these values?      tape_plan     what would it take?
 *   tape_segment  where would I cut it?
 *
 * The hook is the reason they get used: `before_agent_start` appends a bounded block
 * (~1800 characters, at most 12 recipes) telling the agent to consult the store
 * *before* searching the web or re-reading files. A recipe lookup measured at ~90
 * tokens against a web search that costs thousands is the whole argument. While
 * replay is armed the hook stays out of the way, so a replayed run follows its
 * recording instead of being handed new knowledge.
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
 * - `tape_plan` and `tape_segment` describe and cut; they run nothing. The agent
 *   still executes with its own tools, which is where the safety question lives.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import type { AssistantMessage, AssistantMessageEventStream, ToolCall } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
import { entriesFromMessages, isReadOnlyTool } from "../src/replay.ts";
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
import type { SessionEntry, SessionFile, TapeFile, TapeParent } from "../src/types.ts";

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

/** A fork run.
 *
 * Recorded prefix answers are still served from the tape, but a request the
 * recording does not contain is asked of the named model instead of being
 * answered with the next recorded event. That is what makes the prefix key worth
 * having: only the branch after the first divergence costs tokens.
 *
 * Past the divergence a tool call is answered in one of three ways: a read-only call
 * that repeats a recorded one before the recording's next change is served from the
 * tape; a tool named in `--live-tools` runs pi's real implementation; anything else
 * stops the fork with an explanation. Recorded calls are always served from the tape,
 * live tools included, so the replayed prefix never runs its side effects again.
 *
 * Past its divergence a fork is an ordinary pi session, and like one it has no spend
 * limit unless asked for (`--max-live-tokens`). The failure a limit used to stand in
 * for is caught directly instead: a request that misses the recording *before* the
 * intervention has been served cannot be the experiment — nothing has diverged yet —
 * so it is a hash mismatch, and the fork stops without sending it.
 */
interface Fork {
	provider: string;
	modelId: string;
	/** Optional cap on live tokens. Undefined means no cap, like any pi session. */
	maxLiveTokens?: number;
	/** Set once the intervened tool call has been answered with its replacement. */
	interventionServed?: boolean;
	/** Set when a request missed before the intervention, and the fork stopped. */
	stoppedBeforeIntervention?: boolean;
	liveTokens: number;
	forks: number;
	/** Live branches served from the recording because they repeated a recorded call. */
	reconnected: number;
	/**
	 * Tools that run for real once the fork has left the recording. A recorded call is
	 * still served from the tape, so the prefix never repeats its side effects.
	 */
	liveTools: string[];
	/**
	 * Live tools pi-tape cannot reach the implementation of (not pi built-ins). They are
	 * left un-overridden, which means their recorded calls run again too — said so at arm time.
	 */
	unreachableLiveTools: string[];
	/** Where live tools run. */
	cwd: string;
	/** Live tool calls actually executed. */
	liveRuns: number;
	/**
	 * Set once a live tool that can change things has run. From then on the world is
	 * this branch's, not the recording's, so nothing reconnects to the recording any more.
	 */
	liveMutated: boolean;
	/** The armed intervention, if the fork was pointed at a tool result. */
	intervention?: { toolCallId: string; turn: number; toolName: string; result: string };
	/** Set when the very first request missed, which is usually a hash mismatch. */
	firstMissed?: boolean;
}

interface Armed {
	path: string;
	tape: TapeFile;
	engine: ReplayEngine;
	modelId: string;
	registeredTools: string[];
	shadow?: Shadow;
	fork?: Fork;
	/** Recorded compaction summaries served instead of asking a model to write one. */
	compactionsServed?: number;
	/** Compactions refused because the recording has none at that point. */
	compactionsRefused?: number;
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

/** A stream-level failure the agent can read, in the shape pi expects. */
function failureMessage(
	model: { api: string; provider: string; id: string },
	details: { text: string; errorMessage: string },
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: details.text }],
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
		errorMessage: details.errorMessage,
		timestamp: Date.now(),
	};
}

/** A stream that ends at once with an error the agent and the user can read. */
function createStopStream(
	model: { api: string; provider: string; id: string },
	details: { text: string; errorMessage: string },
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		stream.push({ type: "error", reason: "error", error: failureMessage(model, details) });
		stream.end();
	});
	return stream;
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
			const failure = failureMessage(model, {
				text: `tape: ${outcome.reason}`,
				errorMessage: `tape: ${outcome.reason}. The replay left the recording; replay a fork, or record a new tape.`,
			});
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

/**
 * The parts of a replayed request a live call may inherit.
 *
 * pi calls the replay provider with *its* credentials attached —
 * `apiKey: "not-needed-replay-is-offline"` — and the model registry lets a
 * caller's `apiKey` win over the resolved one. Forwarding that whole bag to the
 * real model authenticates with the placeholder and returns a 401 that reads like
 * a bad key. Only the sampling settings travel; auth, headers and routing belong
 * to the target provider.
 */
function liveCallOptions(options: unknown): Record<string, unknown> {
	const { apiKey, headers, env, baseUrl, transformHeaders, ...rest } = (options ?? {}) as Record<string, unknown>;
	void apiKey;
	void headers;
	void env;
	void baseUrl;
	void transformHeaders;
	return rest;
}

/**
 * A fork's divergent turn: the request is not in the recording, so it is asked of
 * a real provider while everything that still matches is served from the tape.
 *
 * The failure path matters as much as the happy one. If the model is gone, or the
 * call throws, the run gets an error it can read instead of an invented answer.
 */
function createForkStream(
	active: Armed,
	registry: LiveRegistry,
	context: { messages: unknown[] },
	options: unknown,
	model: { api: string; provider: string; id: string },
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const fork = active.fork;

	void (async () => {
		if (!fork) {
			const failure = failureMessage(model, {
				text: "tape: fork mode is not armed",
				errorMessage: "tape: fork mode is not armed",
			});
			stream.push({ type: "error", reason: "error", error: failure });
			stream.end();
			return;
		}

		const label = `${fork.provider}/${fork.modelId}`;
		if (fork.maxLiveTokens !== undefined && fork.liveTokens >= fork.maxLiveTokens) {
			stream.push({
				type: "error",
				reason: "error",
				error: failureMessage(model, {
					text: `tape: the fork's live-token budget is spent (${fork.liveTokens} of ${fork.maxLiveTokens})`,
					errorMessage:
						`tape: this fork has spent its live-token budget (${fork.liveTokens} of ${fork.maxLiveTokens} tokens), so the request was not sent. ` +
						"Raise it with /tape fork <file> --model <p>/<m> --max-live-tokens N, or record a new tape. Nothing was invented; the run stops here.",
				}),
			});
			stream.end();
			return;
		}

		const target = registry.find(fork.provider, fork.modelId);
		if (!target) {
			stream.push({
				type: "error",
				reason: "error",
				error: failureMessage(model, {
					text: `tape: ${label} is not in the model registry`,
					errorMessage: `tape: the fork target ${label} is not in the model registry, so the divergent request cannot be answered. The recording is intact; nothing was invented.`,
				}),
			});
			stream.end();
			return;
		}

		try {
			let last: unknown;
			for await (const event of registry.streamSimple(target, context, liveCallOptions(options))) {
				stream.push(event as never);
				const item = event as { type?: string; message?: unknown; error?: unknown; partial?: unknown };
				if (item.type === "done") last = item.message;
				else if (item.type === "error") last = item.error;
				else if (item.partial !== undefined) last = item.partial;
			}
			fork.liveTokens += tokensOfMessage(last);
			fork.forks++;
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: failureMessage(model, {
					text: `tape: the fork call to ${label} failed`,
					errorMessage: `tape: the fork call to ${label} failed: ${(error as Error).message}`,
				}),
			});
		} finally {
			stream.end();
		}
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

	// Recording a session that ran as a fork makes the fork a tape in its own right.
	// The link back is what lets `diff` say "this is that run with one value changed"
	// instead of presenting a deliberate experiment as a regression.
	const parent: TapeParent | undefined = armed?.fork
		? {
				tapeId: armed.tape.id,
				...(armed.fork.intervention
					? {
							forkPoint: {
								toolCallId: armed.fork.intervention.toolCallId,
								toolName: armed.fork.intervention.toolName,
								turn: armed.fork.intervention.turn,
								replacement: armed.fork.intervention.result,
							},
						}
					: {}),
				liveRequests: armed.fork.forks,
				reconnected: armed.fork.reconnected,
			}
		: undefined;
	const result = recordSession(session, { name, piVersion: piVersion(), redact, parent });
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

/**
 * Split the arm arguments out of a command line.
 *
 * Both `--model p/id` and `--model=p/id` are accepted, likewise
 * `--max-live-tokens N`, and what is left over is the file reference. A malformed
 * value yields no target (or a `error`) so the caller prints its own usage line
 * instead of acting on half a model name or an unreadable budget.
 */
function parseArmArguments(rest: string): {
	file: string;
	target?: { provider: string; modelId: string };
	maxLiveTokens?: number;
	at?: string;
	result?: string;
	liveTools?: string[];
	error?: string;
} {
	const parts = rest.trim().split(/\s+/).filter(Boolean);
	const consumed = new Set<number>();
	let target: { provider: string; modelId: string } | undefined;
	let maxLiveTokens: number | undefined;
	let at: string | undefined;
	let result: string | undefined;
	const liveTools: string[] = [];
	let error: string | undefined;

	parts.forEach((part, index) => {
		const flag = (name: string): string | undefined => {
			if (part === name) {
				consumed.add(index).add(index + 1);
				return parts[index + 1];
			}
			if (part.startsWith(`${name}=`)) {
				consumed.add(index);
				return part.slice(name.length + 1);
			}
			return undefined;
		};

		const model = flag("--model");
		if (model !== undefined) {
			const slash = model.indexOf("/");
			if (slash > 0 && slash < model.length - 1) {
				target = { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
			}
			return;
		}

		const budget = flag("--max-live-tokens");
		if (budget !== undefined) {
			const parsed = Number(budget);
			if (!Number.isFinite(parsed) || parsed < 0) error = `--max-live-tokens expects a number, got "${budget}"`;
			else maxLiveTokens = parsed;
			return;
		}

		// `--result` takes everything up to the next flag, because an intervention is
		// usually a sentence. Treating it as one token silently pushed the rest of the
		// sentence into the tape's file name, which then failed to load.
		if (part === "--result" || part.startsWith("--result=")) {
			consumed.add(index);
			const inline = part.startsWith("--result=") ? part.slice("--result=".length) : undefined;
			const words = inline === undefined ? [] : [inline];
			if (inline === undefined) {
				for (let i = index + 1; i < parts.length; i++) {
					const next = parts[i] as string;
					if (next.startsWith("--")) break;
					words.push(next);
					consumed.add(i);
				}
			}
			result = words.join(" ");
			return;
		}

		const atFlag = flag("--at");
		if (atFlag !== undefined) {
			at = atFlag;
			return;
		}

		const live = flag("--live-tools");
		if (live !== undefined) {
			liveTools.push(...live.split(",").map((item) => item.trim()).filter(Boolean));
		}
	});

	return {
		file: parts.filter((_, index) => !consumed.has(index)).join(" "),
		...(target ? { target } : {}),
		...(maxLiveTokens === undefined ? {} : { maxLiveTokens }),
		...(at === undefined ? {} : { at }),
		...(result === undefined ? {} : { result }),
		...(liveTools.length ? { liveTools } : {}),
		...(error === undefined ? {} : { error }),
	};
}

/**
 * Resolve `--at` against the recording's tool calls.
 *
 * Both spellings matter and mean different things: `--at 2` is the second tool call,
 * which a human can read off `pi-tape inspect --timeline`, and `--at call_abc` is one
 * exact call, which a script can paste.
 */
function resolveIntervention(
	engine: ReplayEngine,
	at: string,
): { toolCallId: string; turn: number; toolName: string } | undefined {
	const points = engine.toolCallPoints();
	const wanted = at.trim();
	const asTurn = /^(?:turn-?)?(\d+)$/i.exec(wanted);
	const point = asTurn
		? points.find((item) => item.turn === Number(asTurn[1]))
		: points.find((item) => item.toolCallId === wanted);
	if (!point) return undefined;
	return { toolCallId: point.toolCallId, turn: point.turn, toolName: point.toolName };
}

/** A one-line taste of a value, for a notification. */
function previewText(value: string, max = 60): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A recorded tool result in the shape pi expects from a tool. */
function toolResultPayload(entry: SessionEntry) {
	const message = (entry.message ?? {}) as Record<string, unknown>;
	return {
		content: (Array.isArray(message.content) ? message.content : []) as never,
		details: (message.details ?? { tape: "replayed" }) as never,
		...(message.isError === true ? { isError: true } : {}),
	};
}

/**
 * A reconnected result, marked as one.
 *
 * The recorded details are kept, but `tape: "reconnected"` and the recorded call id
 * say where the answer came from, so a tape recorded from the fork shows which results
 * the branch produced and which it borrowed from the run it forked.
 */
function reconnectedPayload(entry: SessionEntry) {
	const payload = toolResultPayload(entry);
	const message = (entry.message ?? {}) as Record<string, unknown>;
	const recorded = message.details;
	const base = recorded !== null && typeof recorded === "object" && !Array.isArray(recorded) ? recorded : {};
	return {
		...payload,
		details: {
			...(base as Record<string, unknown>),
			tape: (base as Record<string, unknown>).tape === "override" ? "override" : "reconnected",
			from: message.toolCallId,
		} as never,
	};
}

/**
 * The replaced tools, short enough to read. A real setup declares hundreds — every
 * extension's tools — and the notice is for a person, not an inventory.
 */
function summarizeTools(names: string[], shown = 6): string {
	if (!names.length) return "(none)";
	if (names.length <= shown + 2) return names.join(", ");
	return `${names.length} tools (${names.slice(0, shown).join(", ")}, … +${names.length - shown} more)`;
}

/** The read-only tools, for the arm notice. */
const READ_ONLY_NAMES = ["read", "grep", "find", "ls"].filter(isReadOnlyTool);

type BuiltinFactory = (cwd: string) => {
	execute(toolCallId: string, params: never, signal: unknown, onUpdate: unknown, ctx: unknown): Promise<unknown>;
};

/**
 * pi's own tool implementations, which is what lets a fork run a real tool behind an
 * override instead of leaving the tool un-overridden and replaying its side effects.
 */
const BUILTIN_TOOLS: Record<string, BuiltinFactory> = {
	read: createReadToolDefinition as unknown as BuiltinFactory,
	bash: createBashToolDefinition as unknown as BuiltinFactory,
	edit: createEditToolDefinition as unknown as BuiltinFactory,
	write: createWriteToolDefinition as unknown as BuiltinFactory,
	grep: createGrepToolDefinition as unknown as BuiltinFactory,
	find: createFindToolDefinition as unknown as BuiltinFactory,
	ls: createLsToolDefinition as unknown as BuiltinFactory,
};

/**
 * The declaration of a pi built-in, for a live tool the recording never declared — so
 * the model sees the real schema rather than an empty one.
 */
function builtinDeclaration(name: string, cwd: string): Record<string, unknown> | undefined {
	const factory = BUILTIN_TOOLS[name];
	if (!factory) return undefined;
	const definition = factory(cwd) as unknown as { description?: unknown; parameters?: unknown };
	return { name, description: definition.description, parameters: definition.parameters };
}

/** Run a live tool for real, in the session's directory, and count it. */
async function runLiveTool(
	fork: Fork,
	name: string,
	toolCallId: string,
	params: unknown,
	signal: unknown,
	onUpdate: unknown,
	toolCtx: unknown,
) {
	const factory = BUILTIN_TOOLS[name] as BuiltinFactory;
	fork.liveRuns += 1;
	// Mark before running: a tool that fails half-way may already have changed things.
	if (!isReadOnlyTool(name)) fork.liveMutated = true;
	return (await factory(fork.cwd).execute(toolCallId, (params ?? {}) as never, signal, onUpdate, toolCtx)) as never;
}

/** Modes a replay can be armed in. A plain replay is neither. */
interface PlayModes {
	/** Ask this model the same requests in the background, while serving the recording. */
	shadow?: { provider: string; modelId: string };
	/** Ask this model a request the recording does not contain, instead of the next recorded event. */
	fork?: {
		provider: string;
		modelId: string;
		maxLiveTokens?: number;
		/** Tool call to intervene on, by 1-based turn or by tool call id. */
		at?: string;
		/** What that tool call should return instead of the recording. */
		result?: string;
		/** Tools to leave un-overridden so pi runs the real implementation. */
		liveTools?: string[];
	};
}

function playCommand(
	pi: ExtensionAPI,
	reference: string,
	ctx: ExtensionCommandContext,
	modes: PlayModes = {},
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

	// Fork mode switches off the positional fallback, so a request the recording
	// does not contain is reported as a miss instead of being answered from it.
	const engine = new ReplayEngine(tape, modes.fork ? { onMiss: "miss" } : {});
	const recordedModels = tape.stats.models;
	const modelId = recordedModels[0] ?? "replay";
	const active: Armed = { path, tape, engine, modelId, registeredTools: [] };
	if (modes.shadow) {
		active.shadow = { ...modes.shadow, samples: [], liveTokens: 0, pending: 0 };
		liveRegistry = ctx.modelRegistry as unknown as LiveRegistry;
	}
	if (modes.fork) {
		const { provider, modelId: forkModel, maxLiveTokens, at, result, liveTools } = modes.fork;
		if (at !== undefined && result === undefined) {
			ctx.ui.notify("tape: --at needs a --result, or there is nothing to put in its place.", "warning");
			return;
		}
		const fork: Fork = {
			provider,
			modelId: forkModel,
			...(maxLiveTokens === undefined ? {} : { maxLiveTokens }),
			liveTokens: 0,
			forks: 0,
			reconnected: 0,
			liveTools: [],
			unreachableLiveTools: [],
			cwd: ctx.cwd,
			liveRuns: 0,
			liveMutated: false,
		};
		for (const name of new Set((liveTools ?? []).map((item) => item.trim()).filter(Boolean))) {
			(BUILTIN_TOOLS[name] ? fork.liveTools : fork.unreachableLiveTools).push(name);
		}
		if (at !== undefined && result !== undefined) {
			const point = resolveIntervention(engine, at);
			if (!point) {
				ctx.ui.notify(
					`tape: no recorded tool call matches --at ${at}. \`pi-tape inspect <file> --timeline\` lists them by turn and id.`,
					"error",
				);
				return;
			}
			// The replacement is what the next request will contain, so the prefix stops
			// matching and the model is asked for real — the counterfactual being tested.
			engine.setToolResultOverride(point.toolCallId, [{ type: "text", text: result }]);
			fork.intervention = { ...point, result };
		}
		active.fork = fork;
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
			const typed = model as unknown as { api: string; provider: string; id: string };
			// The recorded answer is served either way; the shadow call only observes.
			if (current.shadow && liveRegistry) {
				void observeWithLiveModel(current, liveRegistry, context as { messages: unknown[] }, options);
			}
			// A fork asks a real model for a request the recording does not contain,
			// instead of answering a new context with the next recorded event.
			if (current.fork && liveRegistry) {
				const prefix = entriesFromMessages((context as { messages: unknown[] }).messages);
				if (!current.engine.lookupAssistant(prefix)) {
					// Aimed at a later turn and not there yet: the recorded prefix should have
					// matched and did not. That is a bug in the key (or a prompt that differs
					// from the recording), not the experiment, so nothing is sent.
					if (current.fork.intervention && !current.fork.interventionServed) {
						current.fork.stoppedBeforeIntervention = true;
						return createStopStream(typed, {
							text: "tape: this request is not in the recording, and the fork has not reached its intervention yet",
							errorMessage:
								`tape: this request is not in the recording, but the fork has not reached its intervention ` +
								`(${current.fork.intervention.toolName} turn ${current.fork.intervention.turn}) yet. ` +
								"Nothing has diverged at this point, so this is a hash mismatch — or a first prompt that differs from the recording. " +
								`Nothing was sent to ${current.fork.provider}/${current.fork.modelId}. Send the recording's original first prompt; ` +
								"if it was the original, /tape status shows the miss and it is a bug worth reporting.",
						});
					}
					// Without an intervention, a different first prompt is the documented way to
					// fork; the fact is recorded for the report, not raised as an alarm.
					if (
						current.fork.forks === 0 &&
						current.engine.status().assistantConsumed === 0 &&
						!current.fork.firstMissed
					) {
						current.fork.firstMissed = true;
					}
					return createForkStream(current, liveRegistry, context as { messages: unknown[] }, options, typed);
				}
			}
			return createReplayStream(
				typed,
				context as unknown as { messages: unknown[] },
				options as never,
				current,
			);
		},
	});

	// Override every tool the recording used with a cache-backed stand-in. A live tool
	// is overridden too: its recorded calls are served from the tape like any other, and
	// only a call the recording does not contain reaches pi's real implementation. That
	// is what keeps the replayed prefix from running its side effects a second time.
	//
	// The exception is a live tool pi-tape cannot build itself (an extension's or an MCP
	// server's): `registerTool` would hide the real one for good, so it is left alone,
	// and the arm notice says that its recorded calls run again.
	//
	// A fork also covers every tool the recording *declared*, and every live tool, not
	// only the ones it used: a live branch can reach for a tool the original run never
	// called, and an un-overridden built-in would then run for real without having
	// been allowed to.
	const overridden = new Set(engine.toolNames());
	if (active.fork) {
		for (const name of engine.declaredToolNames()) overridden.add(name);
		for (const name of active.fork.liveTools) overridden.add(name);
	}
	for (const name of overridden) {
		if (active.fork?.unreachableLiveTools.includes(name)) continue;
		const declaration = engine.toolDeclaration(name) ?? builtinDeclaration(name, ctx.cwd);
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
			async execute(toolCallId: string, params?: unknown, signal?: AbortSignal, onUpdate?: unknown, toolCtx?: unknown) {
				const current = armed;
				if (!current) {
					return {
						content: [{ type: "text", text: "tape: replay is disarmed; run /reload to restore the real tools." }],
						details: { tape: "disarmed" },
						isError: true,
					};
				}

				// An armed intervention wins: this is the counterfactual being tested.
				const replacement = current.engine.toolResultOverride(toolCallId);
				if (replacement !== undefined) {
					if (current.fork) current.fork.interventionServed = true;
					return { content: replacement as never, details: { tape: "override" } as never };
				}

				const outcome = current.engine.nextToolResultById(toolCallId);
				if (outcome.kind === "hit") return toolResultPayload(outcome.entry);

				let reason = outcome.reason;
				if (current.fork) {
					// A live branch that asks for what the recording already did gets the
					// recorded answer — as long as the recording still describes this branch's
					// world. This comes first even for a live tool: the recorded answer is the
					// world at the fork point, while the real tool sees the directory as it is
					// today, which may have moved on since the recording.
					if (current.fork.liveMutated) {
						reason = "a live tool has changed things in this branch, so the recording no longer describes it";
					} else {
						const reconnected = current.engine.matchRecordedCall(name, params ?? {});
						if (reconnected.kind === "hit") {
							current.fork.reconnected += 1;
							return reconnectedPayload(reconnected.entry);
						}
						reason = reconnected.reason;
					}

					// Only what the recording cannot answer reaches the real tool.
					if (current.fork.liveTools.includes(name)) {
						return runLiveTool(current.fork, name, toolCallId, params, signal, onUpdate, toolCtx);
					}
				}

				const text = current.fork
					? `tape: ${reason}. This fork went live and asked for something the recording cannot answer, and the real ${name} is not enabled. Run it for real with \`--live-tools ${name}\`, record a fresh tape, or run the procedure with \`pi-tape run\`.`
					: `tape: ${outcome.reason}`;
				return {
					content: [{ type: "text", text }],
					details: { tape: "miss" },
					isError: true,
				};
			},
		});
		active.registeredTools.push(name);
	}

	ctx.ui.setStatus(STATUS_KEY, `replay: ${tape.name ?? tape.id.slice(7, 15)}`);
	const lines = [
		`tape armed → ${path}`,
		`  recorded      ${tape.stats.assistantMessages} assistant / ${tape.stats.toolResults} tool results · $${tape.stats.costUsd.toFixed(4)}`,
		`  tools replaced ${summarizeTools(active.registeredTools)}`,
	];
	if (active.fork) {
		lines.push(
			`  fork          a request the recording does not contain goes to ${active.fork.provider}/${active.fork.modelId}`,
			active.fork.maxLiveTokens === undefined
				? "                no live budget (cap it with --max-live-tokens N); the recorded prefix stays free"
				: `                budget ${active.fork.maxLiveTokens} live tokens; the recorded prefix stays free`,
		);
		if (active.fork.intervention) {
			const { turn, toolName, toolCallId, result } = active.fork.intervention;
			lines.push(
				`  intervention  ${toolName} turn ${turn} (${toolCallId}) → ${JSON.stringify(previewText(result))}`,
				"                a request that misses the recording before this point stops the fork unsent",
			);
		}
		if (active.fork.liveTools.length) {
			lines.push(
				`  live tools    ${active.fork.liveTools.join(", ")} run for real where the recording has no answer`,
				"                recorded calls, and reads the recording already answered, still come from the tape",
			);
		}
		if (active.fork.unreachableLiveTools.length) {
			lines.push(
				`  ⚠ not built-in ${active.fork.unreachableLiveTools.join(", ")}: pi-tape cannot reach the implementation,`,
				"                so they are left as they are — and their RECORDED calls run again, side effects included",
			);
		}
		lines.push(
			`                a live branch that repeats a recorded ${[...READ_ONLY_NAMES].join("/")} call gets the recorded result`,
			"                until the recording's next change; anything else is asked of the real tool or stops",
		);
	}
	lines.push(
		"",
		`Next: run  /model ${PROVIDER}/${modelId}`,
		active.fork
			? "then send a prompt that diverges from the recording. Unchanged requests are served, new ones are asked."
			: "then send the original first prompt. Every answer comes from the recording.",
		"Leaving replay requires /reload — pi cannot unregister a tool.",
	);
	ctx.ui.notify(lines.join("\n"), "info");
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

/** Token usage reported by the last message of a provider stream. */
function tokensOfMessage(message: unknown): number {
	const usage = (message as { usage?: { input?: number; output?: number; totalTokens?: number } } | undefined)?.usage;
	return usage ? (usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0)) : 0;
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
	return { message: last, tokens: tokensOfMessage(last) };
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
		const stream = registry.streamSimple(target, context, liveCallOptions(options));
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
			armed.compactionsServed || armed.compactionsRefused
				? `  compaction ${armed.compactionsServed ?? 0} served from the recording` +
					(armed.compactionsRefused ? ` · ${armed.compactionsRefused} skipped (none recorded at that point)` : "")
				: "",
			...misses.slice(-3).map((miss) => `    · [${miss.kind}] ${miss.detail}`),
			`  recorded   $${armed.tape.stats.costUsd.toFixed(4)} ${armed.fork ? "(plus the fork's live tokens)" : "(this replay cost $0)"}`,
			armed.shadow
				? `  shadow     ${armed.shadow.samples.length}/${armed.engine.assistantCount} compared against ` +
					`${armed.shadow.provider}/${armed.shadow.modelId} · ${armed.shadow.liveTokens} tokens spent`
				: "",
			armed.fork
				? `  fork       ${armed.fork.forks} request(s) the recording lacked → ` +
					`${armed.fork.provider}/${armed.fork.modelId} · ${armed.fork.liveTokens}${armed.fork.maxLiveTokens === undefined ? "" : `/${armed.fork.maxLiveTokens}`} tokens` +
					(armed.fork.stoppedBeforeIntervention
						? "\n  fork       ! a request missed the recording before the intervention — stopped unsent (hash mismatch, or a different first prompt)"
						: "") +
					(armed.fork.reconnected ? `\n  fork       ${armed.fork.reconnected} live call(s) reconnected to the recording` : "") +
					(armed.fork.liveRuns ? `\n  fork       ${armed.fork.liveRuns} live tool call(s) run for real` : "") +
					(armed.fork.intervention
						? `\n  fork       ${armed.fork.intervention.toolName} turn ${armed.fork.intervention.turn} was replaced with ${JSON.stringify(previewText(armed.fork.intervention.result))}`
						: "") +
					(armed.fork.firstMissed && !armed.fork.intervention
						? "\n  fork       the run diverged at the first request (a different prompt, or a hash mismatch)"
						: "")
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

	// A compaction during a replay asks the current model — the tape — for a summary.
	// Left alone, that request would be answered with the next recorded event (a tool
	// call, usually), pi would reject it, and the replay would be one answer short from
	// then on. So while armed, pi-tape answers it: with the recorded summary when the
	// recording compacted at this point, and by refusing the compaction otherwise —
	// except past a fork's divergence, where the branch is its own run and a live model
	// summarises it like any other session.
	pi.on("session_before_compact", (event, ctx) => {
		const current = armed;
		if (!current) return undefined;
		const fork = current.fork;
		const diverged = fork !== undefined && (fork.forks > 0 || fork.interventionServed === true);
		if (diverged) return undefined;

		const served = current.engine.status().assistantConsumed;
		const recorded = current.engine.takeCompaction(served);
		if (recorded) {
			current.compactionsServed = (current.compactionsServed ?? 0) + 1;
			const preparation = (event as { preparation?: { firstKeptEntryId?: string; tokensBefore?: number } }).preparation;
			return {
				compaction: {
					summary: recorded.summary,
					firstKeptEntryId: preparation?.firstKeptEntryId,
					tokensBefore: preparation?.tokensBefore,
					details: recorded.details ?? { tape: "replayed" },
				},
			} as never;
		}

		current.compactionsRefused = (current.compactionsRefused ?? 0) + 1;
		ctx.ui.notify(
			current.engine.compactionCount
				? `tape: the recording compacted at a different point, not after ${served} answer(s) — this compaction is skipped so the replay stays aligned.`
				: "tape: the recording has no compaction here — this one is skipped, so a recorded answer is not spent on a summary.",
			"warning",
		);
		return { cancel: true } as never;
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
					const { file, target } = parseArmArguments(rest);
					if (!target) {
						ctx.ui.notify(
							"Usage: /tape shadow <file.tape> --model <provider>/<model>\n" +
								"The recording is served as usual; the named model is asked the same requests.",
							"warning",
						);
						return;
					}
					playCommand(pi, file, ctx, { shadow: target });
					return;
				}
				case "fork": {
					// `--model provider/id` answers a request the recording lacks, so a run
					// can continue past the recording instead of being served the next
					// recorded event for a context that is not the one asked about.
					const { file, target, maxLiveTokens, at, result, liveTools, error } = parseArmArguments(rest);
					if (error) {
						ctx.ui.notify(`tape: ${error}`, "warning");
						return;
					}
					if (!target) {
						ctx.ui.notify(
							"Usage: /tape fork <file.tape> --model <provider>/<model> [options]\n" +
								"  --max-live-tokens N   optional token cap; the run stops when it is spent (default: none)\n" +
								"  --at <turn|toolCallId> --result <text|@file>\n" +
								"                        answer that tool call differently, then continue with the model\n" +
								"  --live-tools a,b      run pi's real tool for the fork's own calls (recorded ones stay on tape)",
							"warning",
						);
						return;
					}
					if (at !== undefined && result === undefined) {
						ctx.ui.notify("tape: --at needs a --result, or there is nothing to put in its place.", "warning");
						return;
					}

					// A replacement read from a file is how a long or multi-line intervention is
					// supplied, because a slash command cannot carry one inline.
					let replacement = result;
					if (replacement?.startsWith("@")) {
						try {
							replacement = readFileSync(resolve(ctx.cwd, replacement.slice(1)), "utf8");
						} catch (readError) {
							ctx.ui.notify(`tape: could not read ${replacement.slice(1)}: ${(readError as Error).message}`, "error");
							return;
						}
					}

					playCommand(pi, file, ctx, {
						fork: {
							...target,
							...(maxLiveTokens === undefined ? {} : { maxLiveTokens }),
							...(at === undefined || replacement === undefined ? {} : { at, result: replacement }),
							...(liveTools === undefined ? {} : { liveTools }),
						},
					});
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
							"  /tape fork <file> --model <provider>/<model>",
							"                           serve the recording, ask the model where it ends",
							"    --at <turn|id> --result <text|@file>",
							"                           answer one tool call differently, then continue live",
							"    --live-tools a,b       run pi's real tool for the fork's own calls (recorded ones stay on tape)",
							"    --max-live-tokens N    optional token cap (default: none)",
							"  /tape regress            what the shadow model answered differently",,
							"  /tape status             replay progress, misses, shadow and fork progress",
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
