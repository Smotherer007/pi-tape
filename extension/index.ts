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
import { composeRecipe, missingInputs, queryRecipes } from "../src/recipe-query.ts";
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
import { parseSession, type SessionFile } from "../src/session.ts";
import { packTape, readTape, writeTape } from "../src/tape.ts";
import type { TapeFile } from "../src/types.ts";

const PROVIDER = "tape";
const STATUS_KEY = "tape";

interface Armed {
	path: string;
	tape: TapeFile;
	engine: ReplayEngine;
	modelId: string;
	registeredTools: string[];
}

/** Module state: undefined means capture/live mode. */
let armed: Armed | undefined;

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
		lines.push(
			`- **${recipe.name}** (${scope}, ${recipe.observations} obs, ${(recipe.orthogonality * 100).toFixed(0)}% orth)` +
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
				const missing = missingInputs(steps);
				const body = [`${recipe.name} — ${steps.length} step(s)`, "", ...steps.map((step, index) => `${index}. ${step}`)];
				if (missing.length) {
					body.push("", `still unfilled: ${missing.join(", ")}`);
					body.push(
						`available parameters: ${recipe.parameters.map((item) => item.name).join(", ") || "(none)"}`,
					);
				}
				return textResult(body.join("\n"), { steps: steps.length, missing });
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

		const recordedBlocks = (recorded.content ?? []) as Array<Record<string, unknown>>;

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

	const result = recordSession(session, { name: args.trim() || undefined, piVersion: piVersion() });
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

function playCommand(pi: ExtensionAPI, reference: string, ctx: ExtensionCommandContext): void {
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
		].join("\n"),
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
							"  /tape record [name]   save this session as a .tape file",
							"  /tape play <file>      arm deterministic replay from a recording",
							"  /tape status           replay progress and misses",
							"  /tape stop              disarm (then /reload to restore real tools)",
							"  /tape recipes          list the recipe store",
							"  /tape index            rebuild the recipe graph index",
							"",
							"Tools: tape_search, tape_show, tape_dub, tape_check, tape_splice",
							"CLI:   pi-tape sessions | capture | inspect | verify | diff",
							"       pi-tape splice | library | recipe | compose | search | index | fresh",
						].join("\n"),
						"info",
					);
			}
		},
	});

	pi.on("session_shutdown", () => {
		armed = undefined;
	});
}
