#!/usr/bin/env node
/**
 * pi-tape command line interface.
 *
 *   pi-tape sessions                 list pi sessions
 *   pi-tape record [session]        session  -> .tape
 *   pi-tape inspect <tape>           what happened, what it cost
 *   pi-tape verify <tape>            check the recording is complete
 *   pi-tape diff <a.tape> <b.tape>   where two runs diverged
 *   pi-tape extension                print the path for `pi -e`
 */

import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { recordSession } from "./record.ts";
import { formatDiff, diffTapes } from "./diff.ts";
import { listSessions, resolveSession, sessionsRoot } from "./discover.ts";
import { checkFreshness, formatFreshness } from "./freshness.ts";
import { buildRecipeGraph, computeCentrality, detectCommunities, godSteps, recipeCommunities } from "./graph.ts";
import { inspectTape } from "./inspect.ts";
import { verifyRecording } from "./replay.ts";
import { extractRecipe } from "./recipe-extract.ts";
import { familyOrthogonality, intersectRecipes } from "./recipe-intersect.ts";
import { composeRecipe, missingInputs, queryRecipes } from "./recipe-query.ts";
import {
	globalStoreDir,
	indexIsStale,
	loadRecipes,
	projectStoreDir,
	recipeFileDigests,
	saveRecipe,
	writeIndex,
} from "./recipe-store.ts";
import type { Recipe, RecipeIndex } from "./recipe-types.ts";
import { formatBytes, packTape, readTape, writeTape } from "./tape.ts";
import { readSession } from "./session.ts";
import type { TapeFile, TapeProfile } from "./types.ts";

const HELP = `pi-tape — record pi agent sessions, play them back, splice them into recipes

Tapes
  pi-tape sessions [--limit N] [--json]
  pi-tape record [session] [--out FILE] [--profile full|normal|minimal] [--name NAME] [--leaf ID]
  pi-tape inspect <tape> [--timeline] [--limit N] [--json]
  pi-tape verify <tape>
  pi-tape diff <a.tape> <b.tape>

Library
  pi-tape splice <tape...> [--name N] [--scope global|project] [--min-support 0.6]
                           [--include-noise] [--save] [--json]
  pi-tape library [--json]
  pi-tape show <name> [--json]
  pi-tape dub <name> [--set key=value]...
  pi-tape search <query> [--budget N] [--scope global|project]
  pi-tape index [--write]
  pi-tape check [name] [--dry-run] [--timeout MS]

Other
  pi-tape extension

Session references
  omitted            the most recently modified session
  an id prefix       e.g. 01a10cda
  a path             e.g. ~/.pi/agent/sessions/--home-deck--/....jsonl

Record profiles
  full               keep everything
  normal (default)   keep everything, deduplicate repeated large strings
  minimal            drop thinking, telemetry and truncate tool results (lossy)

Tape library
  global             ${globalStoreDir()}
  project            <cwd>/.tape      (shadows global recipes of the same name)
`;

interface Args {
	_: string[];
	/** A repeated flag collapses into an array; single flags stay scalar. */
	flags: Map<string, string | true | string[]>;
}

function parseArgs(argv: string[]): Args {
	const _: string[] = [];
	const flags = new Map<string, string | true | string[]>();

	const record = (name: string, value: string | true) => {
		const existing = flags.get(name);
		if (existing === undefined) {
			flags.set(name, value);
			return;
		}
		// `--set a=1 --set b=2` must keep both; a Map alone would silently drop the
		// first one, which is exactly the kind of bug that looks like a logic error.
		const list = Array.isArray(existing) ? existing : [typeof existing === "string" ? existing : "true"];
		list.push(typeof value === "string" ? value : "true");
		flags.set(name, list);
	};

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string;
		if (!token.startsWith("--")) {
			_.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		if (eq !== -1) {
			record(token.slice(2, eq), token.slice(eq + 1));
			continue;
		}
		const name = token.slice(2);
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--")) {
			record(name, next);
			i++;
		} else {
			record(name, true);
		}
	}
	return { _, flags };
}

/** Every value given for a repeatable flag, in order. */
function flagList(args: Args, name: string): string[] {
	const value = args.flags.get(name);
	if (value === undefined) return [];
	if (Array.isArray(value)) return value;
	return [typeof value === "string" ? value : "true"];
}

function flagString(args: Args, name: string, fallback?: string): string | undefined {
	const value = args.flags.get(name);
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value[value.length - 1];
	return fallback;
}

function flagNumber(args: Args, name: string, fallback: number): number {
	const value = flagString(args, name);
	if (value === undefined) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function fail(message: string): never {
	process.stderr.write(`error: ${message}\n`);
	process.exit(1);
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Library: recipes learned from tapes
// ---------------------------------------------------------------------------

function loadTapes(paths: string[]): TapeFile[] {
	if (!paths.length) fail("usage: pi-tape splice <tape...> [--name NAME] [--save]");
	return paths.map((path) => {
		if (!existsSync(path)) fail(`no such tape: ${path}`);
		return readTape(path);
	});
}

function cmdSplice(args: Args): void {
	const tapes = loadTapes(args._);
	const scope = (flagString(args, "scope", "project") ?? "project") as "global" | "project";
	const name = flagString(args, "name");
	const minSupport = Number(flagString(args, "min-support", "0.6"));
	const includeNoise = args.flags.has("include-noise");

	const extracted = tapes.map((tape) => extractRecipe(tape, { name: name ?? tape.name, scope }).recipe);

	let recipe: Recipe;
	let sharedSteps: number;
	let longestSteps: number;
	let noiseExcluded = 0;
	let variants: Array<{ key: string; verb: string; inRecordings: number[] }> = [];

	if (extracted.length === 1) {
		recipe = extracted[0] as Recipe;
		sharedSteps = recipe.steps.length;
		longestSteps = recipe.steps.length;
	} else {
		const result = intersectRecipes(extracted, { name, scope, minSupport, includeNoise });
		recipe = result.recipe;
		sharedSteps = result.sharedSteps;
		longestSteps = result.longestSteps;
		noiseExcluded = result.noiseExcluded;
		variants = result.variants;
		// Orthogonality over the family, not just the skeleton: this is the number
		// that says whether a filler swap transfers knowledge here.
		recipe.orthogonality = familyOrthogonality(extracted, includeNoise);
	}

	if (args.flags.has("json")) {
		process.stdout.write(`${JSON.stringify({ recipe, sharedSteps, longestSteps, noiseExcluded, variants }, null, 2)}\n`);
		return;
	}

	const lines: string[] = [];
	lines.push(`spliced "${recipe.name}" from ${tapes.length} tape(s)`);
	lines.push(`  scope          ${recipe.scope}`);
	lines.push(`  observations   ${recipe.observations}`);
	if (extracted.length > 1) {
		lines.push(`  skeleton       ${sharedSteps} of max ${longestSteps} steps (support >= ${minSupport})`);
		lines.push(`  orthogonality  ${(recipe.orthogonality * 100).toFixed(1)}%   <- high means a filler swap transfers knowledge`);
		if (noiseExcluded > 0) lines.push(`  noise          ${noiseExcluded} reconnaissance step(s) left out`);
	}
	lines.push(`  steps / slots / params  ${recipe.steps.length} / ${recipe.slots.length} / ${recipe.parameters.length}`);
	lines.push(`  validators     ${recipe.validators.length}`);
	lines.push("");
	lines.push("skeleton:");
	for (const step of recipe.steps) lines.push(`  ${step.template}`);

	if (recipe.parameters.length) {
		lines.push("");
		lines.push("parameters:");
		for (const parameter of recipe.parameters) {
			const members = parameter.members.map((member) => `${member.stepIndex}#${member.slot}`).join(", ");
			const values = parameter.variants.map((variant) => `${variant.label} (x${variant.observedIn})`).join(", ");
			lines.push(`  ${parameter.name}  [${members}]`);
			lines.push(`      ${values}`);
		}
	}

	if (variants.length) {
		lines.push("");
		lines.push("not in the skeleton:");
		for (const variant of variants.slice(0, 8)) {
			lines.push(`  ${variant.verb}  (in ${variant.inRecordings.length}/${tapes.length} tapes)`);
		}
	}

	if (args.flags.has("save")) {
		const storeDir = scope === "global" ? globalStoreDir() : projectStoreDir(process.cwd());
		const saved = saveRecipe(storeDir, recipe);
		lines.push("");
		lines.push(`saved → ${saved.path}`);
	} else {
		lines.push("");
		lines.push("not saved; pass --save to store it");
	}

	process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdLibrary(args: Args): void {
	const { recipes, errors } = loadRecipes(process.cwd());

	if (args.flags.has("json")) {
		process.stdout.write(`${JSON.stringify({ recipes: recipes.map((item) => item.recipe), errors }, null, 2)}\n`);
		return;
	}

	if (!recipes.length) {
		process.stdout.write("no recipes in the store\n");
		process.stdout.write(`  global   ${globalStoreDir()}\n`);
		process.stdout.write(`  project  ${projectStoreDir(process.cwd())}\n`);
		process.stdout.write("\nlearn one with: pi-tape splice <tape...> --save\n");
		return;
	}

	for (const { recipe, scope, shadowed } of recipes) {
		const tags = [
			scope,
			`${recipe.observations} obs`,
			`${recipe.steps.length} steps`,
			`${recipe.parameters.length} params`,
			`${(recipe.orthogonality * 100).toFixed(0)}% orth`,
		];
		process.stdout.write(`  ${recipe.name.padEnd(28)} ${tags.join(" · ")}\n`);
		if (shadowed) process.stdout.write(`      shadows ${shadowed}\n`);
	}
	process.stdout.write(`\n${recipes.length} recipe(s)\n`);
	for (const error of errors) process.stderr.write(`warning: ${error.path}: ${error.message}\n`);
}

function findRecipe(name: string): Recipe {
	const { recipes } = loadRecipes(process.cwd());
	const match =
		recipes.find((item) => item.recipe.name === name) ??
		recipes.find((item) => item.recipe.name.toLowerCase().includes(name.toLowerCase()));
	if (!match) fail(`no recipe matching "${name}" (try: pi-tape library)`);
	return match.recipe;
}

function cmdShow(args: Args): void {
	const name = args._[0] ?? fail("usage: pi-tape show <name>");
	const recipe = findRecipe(name);

	if (args.flags.has("json")) {
		process.stdout.write(`${JSON.stringify(recipe, null, 2)}\n`);
		return;
	}

	const lines: string[] = [];
	lines.push(`recipe "${recipe.name}" (${recipe.scope})`);
	if (recipe.description) lines.push(`  ${recipe.description}`);
	lines.push(`  spliced from   ${recipe.learnedFrom.length} tape(s)`);
	lines.push(`  updated        ${recipe.updatedAt}`);
	lines.push(`  orthogonality  ${(recipe.orthogonality * 100).toFixed(1)}%`);
	lines.push("");
	lines.push("steps:");
	recipe.steps.forEach((step, index) => {
		lines.push(`  ${String(index).padStart(2)}  ${step.template}`);
		if (step.usesSlots.length) lines.push(`      slots: ${step.usesSlots.join(", ")}`);
	});

	if (recipe.parameters.length) {
		lines.push("");
		lines.push("parameters:");
		for (const parameter of recipe.parameters) {
			lines.push(`  ${parameter.name} — ${parameter.description}`);
			for (const variant of parameter.variants) {
				lines.push(`      ${variant.label} (x${variant.observedIn})  ${JSON.stringify(variant.values)}`);
			}
		}
	}

	if (recipe.validators.length) {
		lines.push("");
		lines.push("validators:");
		for (const validator of recipe.validators) lines.push(`  ${validator.command}`);
	}

	process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdDub(args: Args): void {
	const name = args._[0] ?? fail("usage: pi-tape dub <name> [--set key=value]...");
	const recipe = findRecipe(name);

	const assignments: Record<string, string> = {};
	for (const value of flagList(args, "set")) {
		const separator = value.indexOf("=");
		if (separator === -1) fail(`--set expects key=value, got "${value}"`);
		// Later assignments win, so `--set name=a --set name=b` means b.
		assignments[value.slice(0, separator)] = value.slice(separator + 1);
	}

	let steps: string[];
	try {
		steps = composeRecipe(recipe, assignments);
	} catch (error) {
		return fail((error as Error).message);
	}

	for (const step of steps) process.stdout.write(`${step}\n`);

	const missing = missingInputs(steps);
	if (missing.length) {
		process.stderr.write(`\nunfilled: ${missing.join(", ")}\n`);
		process.stderr.write(`available parameters: ${recipe.parameters.map((item) => item.name).join(", ") || "(none)"}\n`);
	}
}

function cmdSearch(args: Args): void {
	const query = args._.join(" ").trim();
	if (!query) fail("usage: pi-tape search <query> [--budget N]");

	const { recipes } = loadRecipes(process.cwd());
	if (!recipes.length) fail("the recipe store is empty; run: pi-tape splice <tape...> --save");

	const budget = flagNumber(args, "budget", 1200);
	const result = queryRecipes(recipes.map((item) => item.recipe), query, {
		budget,
		limit: flagNumber(args, "limit", 10),
		scope: (flagString(args, "scope", "any") ?? "any") as "any" | "global" | "project",
	});

	process.stdout.write(`${result.text}\n`);
	process.stderr.write(`\n~${result.estimatedTokens} tokens of ${budget} budget\n`);
}

function stepUsage(graph: ReturnType<typeof buildRecipeGraph>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [id, node] of graph.nodes) {
		if (node.kind !== "step") continue;
		out[id.slice("step:".length)] = [...(graph.adjacency.get(id)?.keys() ?? [])]
			.filter((neighbour) => neighbour.startsWith("recipe:"))
			.map((neighbour) => neighbour.slice("recipe:".length));
	}
	return out;
}

function cmdIndex(args: Args): void {
	const cwd = process.cwd();
	const { recipes, errors } = loadRecipes(cwd);
	if (!recipes.length) fail("the recipe store is empty; run: pi-tape splice <tape...> --save");

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
		stepUsage: stepUsage(graph),
		clusters: Object.fromEntries([...families].map(([id, names]) => [String(id), names])),
		godSteps: gods.map((god) => ({ key: god.key, verb: god.verb, recipes: god.recipes, centrality: god.centrality })),
		stats: {
			recipes: recipes.length,
			steps: recipes.reduce((sum, item) => sum + item.recipe.steps.length, 0),
			distinctSteps: [...graph.nodes.values()].filter((node) => node.kind === "step").length,
			clusters: families.size,
			meanOrthogonality:
				Math.round((recipes.reduce((sum, item) => sum + item.recipe.orthogonality, 0) / recipes.length) * 10_000) /
				10_000,
		},
	};

	const lines: string[] = [];
	lines.push(`indexed ${index.stats.recipes} recipe(s)`);
	lines.push(`  steps              ${index.stats.steps} total, ${index.stats.distinctSteps} distinct`);
	lines.push(`  mean orthogonality ${(index.stats.meanOrthogonality * 100).toFixed(1)}%`);
	lines.push(`  families           ${index.stats.clusters} (Louvain, modularity ${communities.modularity})`);
	lines.push("");
	lines.push("families:");
	for (const [id, names] of [...families].sort((a, b) => b[1].length - a[1].length)) {
		lines.push(`  #${id}  ${names.length} recipe(s)  ${names.join(", ")}`);
	}
	lines.push("");
	lines.push("god steps (highest leverage across all recipes):");
	for (const god of gods) {
		lines.push(`  ${god.centrality.toFixed(5)}  ${String(god.recipes).padStart(3)} recipes  ${god.key}`);
	}

	if (args.flags.has("write")) {
		const path = writeIndex(globalStoreDir(), index);
		lines.push("");
		lines.push(`written → ${path}`);
	} else {
		lines.push("");
		lines.push(`stale: ${indexIsStale(cwd) ? "yes" : "no"}   (pass --write to persist)`);
	}

	for (const error of errors) process.stderr.write(`warning: ${error.path}: ${error.message}\n`);
	process.stdout.write(`${lines.join("\n")}\n`);
}

async function cmdCheck(args: Args): Promise<void> {
	const name = args._[0];
	const { recipes } = loadRecipes(process.cwd());
	const targets = name === undefined ? recipes.map((item) => item.recipe) : [findRecipe(name)];
	if (!targets.length) fail("the recipe store is empty");

	for (const recipe of targets) {
		const report = await checkFreshness(recipe, {
			dryRun: args.flags.has("dry-run"),
			timeoutMs: flagNumber(args, "timeout", 20_000),
		});
		process.stdout.write(`${formatFreshness(report)}\n\n`);
	}
}

// ---------------------------------------------------------------------------
// Sessions and recordings
// ---------------------------------------------------------------------------

function cmdSessions(args: Args): void {
	const limit = flagNumber(args, "limit", 25);
	const all = listSessions();

	if (args.flags.has("json")) {
		process.stdout.write(`${JSON.stringify(all.slice(0, limit), null, 2)}\n`);
		return;
	}

	if (!all.length) {
		process.stdout.write(`no sessions found under ${sessionsRoot()}\n`);
		return;
	}

	process.stdout.write(`${all.length} session(s) under ${sessionsRoot()}\n\n`);
	for (const session of all.slice(0, limit)) {
		const when = session.modified.toISOString().slice(0, 16).replace("T", " ");
		const id = (session.sessionId ?? "?").slice(0, 8);
		const size = formatBytes(session.sizeBytes);
		const name = session.name ? `"${session.name}"` : (session.preview ?? "");
		process.stdout.write(`  ${when}  ${id}  ${size.padStart(9)}  ${name}\n`);
		process.stdout.write(`      ${session.path}\n`);
	}
	if (all.length > limit) {
		process.stdout.write(`\n… ${all.length - limit} more (use --limit)\n`);
	}
}

function cmdRecord(args: Args): void {
	const reference = args._[0];
	const path = resolveSession(reference);
	if (!path) fail("no session found; pass a path, an id prefix, or run a pi session first");
	if (!existsSync(path)) fail(`session file not found: ${path}`);

	const profile = (flagString(args, "profile", "normal") ?? "normal") as TapeProfile;
	if (!["full", "normal", "minimal"].includes(profile)) {
		fail(`unknown profile "${profile}" (expected full, normal or minimal)`);
	}

	const session = readSession(path);
	const leafOverride = flagString(args, "leaf");
	const result = recordSession(session, {
		profile,
		name: flagString(args, "name"),
		...(leafOverride === undefined ? {} : { leafId: leafOverride }),
	});

	const out =
		flagString(args, "out") ??
		join(process.cwd(), `${result.tape.name ? slug(result.tape.name) : result.tape.id.slice(7, 19)}.tape`);

	writeTape(out, result.tape);

	const packed = packTape(result.tape);
	const raw = Buffer.byteLength(JSON.stringify(result.tape), "utf8");
	const sourceSize = statSync(path).size;

	process.stdout.write(`recorded ${result.path.length} entries on one branch\n`);
	process.stdout.write(`  from      ${path} (${formatBytes(sourceSize)})\n`);
	process.stdout.write(`  to        ${resolve(out)} (${formatBytes(packed.length)})\n`);
	process.stdout.write(
		`  ratio     ${(100 - (packed.length / Math.max(sourceSize, 1)) * 100).toFixed(1)}% smaller than the source session\n`,
	);
	process.stdout.write(
		`  json      ${formatBytes(raw)} raw → ${formatBytes(packed.length)} gzipped (${result.tape.dict.length} pooled strings)\n`,
	);
	process.stdout.write(
		`  run       ${result.tape.stats.assistantMessages} assistant / ${result.tape.stats.toolResults} tool results, $${result.tape.stats.costUsd.toFixed(4)}\n`,
	);
	if (result.branchPoints > 0) {
		process.stdout.write(`  note      ${result.branchPoints} branch point(s) on this path; record another with --leaf\n`);
	}
	if (result.tape.lossy) {
		process.stdout.write(`  lossy     ${result.tape.dropped.join("; ")}\n`);
	}
}

function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48) || "tape"
	);
}

function cmdInspect(args: Args): void {
	const path = args._[0] ?? fail("usage: pi-tape inspect <tape>");
	const tape = readTape(path);

	if (args.flags.has("json")) {
		process.stdout.write(`${JSON.stringify(tape, null, 2)}\n`);
		return;
	}

	const bytes = statSync(path).size;
	const text = inspectTape(tape, {
		timeline: args.flags.has("timeline"),
		limit: flagNumber(args, "limit", 40),
		bytes,
	});
	process.stdout.write(`${text}\n`);
}

function cmdVerify(args: Args): void {
	const path = args._[0] ?? fail("usage: pi-tape verify <tape>");
	const tape = readTape(path);
	const result = verifyRecording(tape);

	process.stdout.write(`${basename(path)} (${tape.id.slice(0, 19)})\n`);
	process.stdout.write(`  assistant events served    ${result.assistantHits}\n`);
	process.stdout.write(`  tool result events served  ${result.toolHits}\n`);
	process.stdout.write(`  ${result.ok ? "✓ no gaps: every recorded event is servable" : `✗ ${result.misses.length} gap(s)`}\n`);
	for (const miss of result.misses.slice(0, 10)) {
		process.stdout.write(`    · [${miss.kind}] ${miss.detail} (${miss.hash})\n`);
	}

	// ``verify`` replays the recording against itself, so it proves internal
	// consistency, not fidelity to the original run. Say so when it matters.
	if (tape.lossy) {
		process.stdout.write(`\n  note: this is a LOSSY recording (${tape.profile}). Replay may differ from the original run.\n`);
		for (const item of tape.dropped.slice(0, 5)) process.stdout.write(`        · ${item}\n`);
	}
	if (!result.ok) process.exit(2);
}

function cmdDiff(args: Args): void {
	const [leftPath, rightPath] = args._;
	if (!leftPath || !rightPath) fail("usage: pi-tape diff <a.tape> <b.tape>");
	const report = diffTapes(readTape(leftPath), readTape(rightPath));
	process.stdout.write(`${formatDiff(report)}\n`);
}

function cmdExtension(): void {
	const path = join(import.meta.dirname, "..", "extensions", "index.ts");
	process.stdout.write(`${resolve(path)}\n`);
	process.stdout.write(`\nLoad it with:\n  pi -e ${resolve(path)}\n`);
}

// ---------------------------------------------------------------------------

function main(): void {
	const [command, ...rest] = process.argv.slice(2);
	const args = parseArgs(rest);

	switch (command) {
		case "sessions":
			cmdSessions(args);
			return;
		case "record":
			cmdRecord(args);
			return;
		case "inspect":
			cmdInspect(args);
			return;
		case "verify":
			cmdVerify(args);
			return;
		case "diff":
			cmdDiff(args);
			return;
		case "splice":
			cmdSplice(args);
			return;
		case "library":
			cmdLibrary(args);
			return;
		case "show":
			cmdShow(args);
			return;
		case "dub":
			cmdDub(args);
			return;
		case "search":
			cmdSearch(args);
			return;
		case "index":
			cmdIndex(args);
			return;
		case "check":
			void cmdCheck(args).catch((error: unknown) => fail((error as Error).message));
			return;
		case "extension":
			cmdExtension();
			return;
		case undefined:
		case "help":
		case "--help":
		case "-h":
			process.stdout.write(HELP);
			return;
		default:
			fail(`unknown command "${command}" (try: pi-tape help)`);
	}
}

main();
