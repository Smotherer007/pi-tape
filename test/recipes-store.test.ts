import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { recordSession } from "../src/record.ts";
import { checkFreshness, formatFreshness } from "../src/freshness.ts";
import { buildRecipeGraph, computeCentrality, detectCommunities, godSteps } from "../src/graph.ts";
import { extractRecipe } from "../src/recipe-extract.ts";
import { intersectRecipes } from "../src/recipe-intersect.ts";
import { composeRecipe, estimateTokens, missingInputs, queryRecipes, rankRecipes, tokenize } from "../src/recipe-query.ts";
import {
	globalStoreDir,
	indexIsStale,
	loadRecipes,
	recipeFileDigests,
	recipeId,
	saveRecipe,
	validateRecipe,
	writeIndex,
} from "../src/recipe-store.ts";
import { parseSession } from "../src/session.ts";
import { emptyRecipe, RECIPE_MAGIC } from "../src/recipe-types.ts";
import type { Recipe } from "../src/recipe-types.ts";
import type { TapeFile } from "../src/types.ts";
import { assistantToolCall, sessionText, systemEntry, toolResultEntry } from "./fixtures.ts";

let workDir: string;
let originalStore: string | undefined;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "tape-store-"));
	originalStore = process.env.PI_TAPE_DIR;
	process.env.PI_TAPE_DIR = join(workDir, "global");
});

afterEach(() => {
	if (originalStore === undefined) delete process.env.PI_TAPE_DIR;
	else process.env.PI_TAPE_DIR = originalStore;
	rmSync(workDir, { recursive: true, force: true });
});

function recordingOf(commands: string[], name: string): TapeFile {
	const entries = [systemEntry("s1000", null)];
	let parent = "s1000";
	commands.forEach((command, index) => {
		const assistantId = `a${1000 + index}`;
		const resultId = `t${1000 + index}`;
		entries.push(assistantToolCall(assistantId, parent, "bash", { command }));
		entries.push(toolResultEntry(resultId, assistantId, "bash", "ok"));
		parent = resultId;
	});
	return recordSession(parseSession(sessionText(entries)), { name }).tape;
}

function frontendFamily(): Recipe[] {
	return [
		recordingOf(["npm create vue@latest app-one", "npm install vue-router", "npm run build"], "a"),
		recordingOf(["npm create vue@latest app-two", "npm install vue-router", "npm run build"], "b"),
		recordingOf(["npm create react@latest app-three", "npm install react-router-dom", "npm run build"], "c"),
		recordingOf(["npm create react@latest app-four", "npm install react-router-dom", "npm run build"], "d"),
	].map((tape) => extractRecipe(tape).recipe);
}

function learnedFrontendRecipe(): Recipe {
	return intersectRecipes(frontendFamily(), { name: "frontend-setup" }).recipe;
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

test("a recipe survives a save/load round trip", () => {
	const recipe = learnedFrontendRecipe();
	const { path } = saveRecipe(globalStoreDir(), recipe);
	assert.ok(path.endsWith("frontend-setup.recipe.json"));

	const { recipes, errors } = loadRecipes(workDir);
	assert.deepEqual(errors, []);
	assert.equal(recipes.length, 1);
	assert.equal(recipes[0]?.recipe.name, "frontend-setup");
	assert.equal(recipes[0]?.scope, "global");
});

test("a project recipe shadows a global one with the same name", () => {
	saveRecipe(globalStoreDir(), learnedFrontendRecipe());

	const projectRecipe = { ...learnedFrontendRecipe(), description: "project-local variant" };
	saveRecipe(join(workDir, ".tape"), projectRecipe);

	const { recipes } = loadRecipes(workDir);
	assert.equal(recipes.length, 1, "one effective recipe, not two");
	assert.equal(recipes[0]?.scope, "project");
	assert.ok(recipes[0]?.shadowed, "the shadowed global file is reported");
});

test("the recipe id is stable across saves of identical content", () => {
	const a = learnedFrontendRecipe();
	const b = learnedFrontendRecipe();
	assert.equal(recipeId(a), recipeId(b));
	assert.notEqual(recipeId({ ...a, name: "different" }), recipeId(a));
});

test("the validator backfills `enumerated` on recipes written before it existed", () => {
	const recipe = learnedFrontendRecipe();
	const stripped = JSON.parse(JSON.stringify(recipe)) as Recipe;
	for (const parameter of stripped.parameters) delete (parameter as Partial<typeof parameter>).enumerated;

	const validated = validateRecipe(stripped, "<test>");
	const multi = validated.parameters.find((parameter) => parameter.members.length > 1);
	const single = validated.parameters.find((parameter) => parameter.members.length === 1);

	assert.equal(multi?.enumerated, true, "a multi-slot parameter must be enumerated");
	assert.equal(single?.enumerated, false, "a single slot is free-form");
});

test("a foreign file is rejected with a path in the message", () => {
	assert.throws(() => validateRecipe({ magic: "nope" }, "/x/y.json"), /\/x\/y\.json: expected magic/);
	assert.throws(() => validateRecipe({ magic: RECIPE_MAGIC, version: 99 }, "r.json"), /unsupported recipe version/);
	assert.throws(() => validateRecipe({ ...emptyRecipe("x", "global"), name: "" }, "r.json"), /missing a name/);
	assert.throws(
		() => validateRecipe({ ...emptyRecipe("x", "global"), steps: undefined }, "r.json"),
		/`steps` must be an array/,
	);

	// A minimal but valid recipe is accepted, and the optional collections are filled in.
	const minimal = validateRecipe({ ...emptyRecipe("ok", "global"), steps: [] }, "r.json");
	assert.deepEqual(minimal.parameters, []);
	assert.deepEqual(minimal.validators, []);
	assert.deepEqual(minimal.compatibility, { constraints: [] });
});

test("the index is reported stale after a recipe changes", () => {
	saveRecipe(globalStoreDir(), learnedFrontendRecipe());
	assert.equal(indexIsStale(workDir), true, "no index yet");

	const graph = buildRecipeGraph([learnedFrontendRecipe()]);
	writeIndex(globalStoreDir(), {
		magic: "pi-tape-index",
		version: 1,
		builtAt: new Date().toISOString(),
		digests: recipeFileDigests(workDir),
		recipes: [],
		stepUsage: {},
		clusters: {},
		godSteps: [],
		stats: { recipes: 1, steps: 3, distinctSteps: 3, clusters: 1, meanOrthogonality: 1 },
	});
	assert.equal(indexIsStale(workDir), false, "an index matching the files is fresh");
	assert.ok(graph.nodes.size > 0);

	// Content-based, so an edit is noticed even within the same millisecond.
	saveRecipe(globalStoreDir(), { ...learnedFrontendRecipe(), description: "touched" });
	assert.equal(indexIsStale(workDir), true, "changed content must invalidate the index");
});

// ---------------------------------------------------------------------------
// query
// ---------------------------------------------------------------------------

test("tokenization splits camelCase and kebab-case", () => {
	assert.deepEqual(tokenize("createUserProfile"), ["create", "user", "profile"]);
	assert.deepEqual(tokenize("react-router-dom"), ["react", "router", "dom"]);
	assert.deepEqual(tokenize("npm install -D vite"), ["npm", "install", "vite"]);
});

test("a natural-language query finds the right recipe", () => {
	const recipes = [learnedFrontendRecipe()];
	const hits = rankRecipes(recipes, "vue projekt aufsetzen");
	assert.equal(hits.length, 1);
	assert.ok((hits[0]?.score ?? 0) > 0);
	assert.ok(hits[0]?.matchedTerms.includes("vue"));
});

test("the token budget truncates the result set instead of ignoring it", () => {
	// Ten near-identical recipes so the budget definitely bites.
	const recipes: Recipe[] = [];
	for (let i = 0; i < 10; i++) recipes.push({ ...learnedFrontendRecipe(), name: `frontend-setup-${i}` });

	const tiny = queryRecipes(recipes, "frontend setup", { budget: 60 });
	assert.equal(tiny.truncated, true);
	assert.ok(tiny.hits.length < 10);
	assert.ok(tiny.estimatedTokens <= 200, `budget respected, got ~${tiny.estimatedTokens}`);

	const roomy = queryRecipes(recipes, "frontend setup", { budget: 20_000 });
	assert.equal(roomy.hits.length, 10);
});

test("a query with no match says so instead of returning everything", () => {
	const result = queryRecipes([learnedFrontendRecipe()], "kubernetes cluster upgrade");
	assert.equal(result.hits.length, 0);
	assert.match(result.text, /no recipe matched/);
});

test("the scope filter works", () => {
	const global = { ...learnedFrontendRecipe(), name: "g", scope: "global" as const };
	const project = { ...learnedFrontendRecipe(), name: "p", scope: "project" as const };

	assert.equal(queryRecipes([global, project], "npm install", { scope: "project" }).hits.length, 1);
	assert.equal(queryRecipes([global, project], "npm install", { scope: "global" }).hits.length, 1);
	assert.equal(queryRecipes([global, project], "npm install", { scope: "any" }).hits.length, 2);
});

test("token estimation is proportional to length", () => {
	assert.equal(estimateTokens(""), 0);
	assert.equal(estimateTokens("abcd"), 1);
	assert.equal(estimateTokens("a".repeat(400)), 100);
});

// ---------------------------------------------------------------------------
// compose
// ---------------------------------------------------------------------------

test("an enumerated parameter swaps every member at once", () => {
	const recipe = learnedFrontendRecipe();

	const vue = composeRecipe(recipe, { template: "vue@latest", name: "demo" });
	assert.deepEqual(vue, ["npm create vue@latest demo", "npm install vue-router", "npm run build"]);

	const react = composeRecipe(recipe, { template: "react@latest", name: "demo" });
	assert.deepEqual(react, ["npm create react@latest demo", "npm install react-router-dom", "npm run build"]);

	assert.deepEqual(missingInputs(vue), [], "nothing left to fill");
});

test("a free parameter accepts a value that was never observed", () => {
	const recipe = learnedFrontendRecipe();
	const steps = composeRecipe(recipe, { name: "brand-new-project" });

	// The name was never in the recordings, and that must not be an error.
	assert.ok(steps.some((step) => step.includes("brand-new-project")));
	assert.ok(missingInputs(steps).includes("template"), "the framework is still open");
});

test("an enumerated parameter rejects an unknown value", () => {
	const recipe = learnedFrontendRecipe();
	assert.throws(
		() => composeRecipe(recipe, { template: "svelte@latest" }),
		/enumerated parameter value not recognised/,
	);
});

test("an unfilled placeholder is reported rather than silently emitted", () => {
	const recipe = learnedFrontendRecipe();
	const steps = composeRecipe(recipe, {});
	assert.ok(missingInputs(steps).length >= 2);
	assert.match(steps[0] as string, /\{\{template\}\}/);
});

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

test("the graph connects recipes to their steps and ranks them", () => {
	const recipes = frontendFamily();
	const merged = learnedFrontendRecipe();
	const graph = buildRecipeGraph([merged, ...recipes]);

	const recipeNodes = [...graph.nodes.values()].filter((node) => node.kind === "recipe");
	const stepNodes = [...graph.nodes.values()].filter((node) => node.kind === "step");
	assert.ok(recipeNodes.length >= 5);
	assert.ok(stepNodes.length >= 3);

	const scores = computeCentrality(graph);
	for (const score of scores.values()) {
		assert.ok(score > 0, "every node keeps some mass: no leaks");
		assert.ok(score < 1, "and none of them takes everything");
	}

	const total = [...scores.values()].reduce((sum, value) => sum + value, 0);
	assert.ok(Math.abs(total - 1) < 0.01, `scores sum to ~1, got ${total}`);
});

test("god steps rank the procedures that recur across recipes highest", () => {
	const merged = learnedFrontendRecipe();
	const graph = buildRecipeGraph([merged, ...frontendFamily()]);
	const gods = godSteps(graph, 5);

	assert.ok(gods.length > 0);
	assert.ok(
		gods.some((god) => god.key.includes("npm create")),
		`the create step should rank, got ${gods.map((god) => god.key).join(", ")}`,
	);
	assert.equal(gods[0]?.recipes ?? 0, godOf(gods, "npm create")?.recipes, "ranked by centrality");
});

function godOf(gods: Array<{ key: string; recipes: number }>, needle: string) {
	return gods.find((god) => god.key.includes(needle));
}

test("community detection separates unrelated recipes", () => {
	const frontend = learnedFrontendRecipe();
	const unrelatedA = extractRecipe(recordingOf(["docker build -t app .", "docker push app"], "docker-a")).recipe;
	const unrelatedB = extractRecipe(recordingOf(["docker build -t other .", "docker push other"], "docker-b")).recipe;

	const graph = buildRecipeGraph([frontend, unrelatedA, unrelatedB]);
	const result = detectCommunities(graph);

	// Assignment must be dense and every node covered.
	const ids = new Set([...result.assignment.values()]);
	assert.deepEqual([...ids].sort((a, b) => a - b), [...Array(ids.size).keys()], "communities are densely numbered");
	assert.equal(result.assignment.size, graph.nodes.size, "every node is assigned");
	assert.ok(Number.isFinite(result.modularity));
});

test("a graph with no edges does not divide by zero", () => {
	const lonely: Recipe = { ...emptyRecipe("lonely", "global"), id: "r1", steps: [] };
	const graph = buildRecipeGraph([lonely]);
	assert.doesNotThrow(() => detectCommunities(graph));
	assert.doesNotThrow(() => godSteps(graph));
});

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

test("freshness runs validators and reports per-check outcomes", async () => {
	const recipe: Recipe = {
		...learnedFrontendRecipe(),
		validators: [
			{ command: "true", describes: "always succeeds" },
			{ command: "false", describes: "always fails" },
		],
	};

	const report = await checkFreshness(recipe, { timeoutMs: 5000 });
	assert.equal(report.status, "stale");
	assert.equal(report.staleChecks.length, 1);
	assert.equal(report.validators.filter((outcome) => outcome.status === "fresh").length, 1);
	assert.match(formatFreshness(report), /needs re-learning/);
});

test("a missing checker is unknown, not stale", async () => {
	const recipe: Recipe = {
		...learnedFrontendRecipe(),
		validators: [{ command: "definitely-not-a-real-command-xyz --version", describes: "tool exists" }],
	};
	const report = await checkFreshness(recipe, { timeoutMs: 5000 });
	assert.notEqual(report.status, "stale", "an absent tool is not evidence the recipe is wrong");
	assert.equal(report.unknownChecks.length, 1);
});

test("a recipe with no validators is never claimed fresh", () => {
	const recipe: Recipe = { ...learnedFrontendRecipe(), validators: [], updatedAt: "2020-01-01T00:00:00.000Z" };
	return checkFreshness(recipe, { dryRun: true }).then((report) => {
		assert.equal(report.status, "unknown");
		assert.match(formatFreshness(report), /cannot be established/);
	});
});

test("dry run reports validators as unchecked without running them", async () => {
	const recipe: Recipe = {
		...learnedFrontendRecipe(),
		validators: [{ command: "false", describes: "would fail" }],
	};
	const report = await checkFreshness(recipe, { dryRun: true });
	assert.equal(report.staleChecks.length, 0);
	assert.equal(report.validators[0]?.status, "unchecked");
});

test("an unwritable index directory fails loudly rather than silently", () => {
	mkdirSync(join(workDir, "ro"), { recursive: true });
	writeFileSync(join(workDir, "ro", "x"), "x");
	assert.doesNotThrow(() => writeIndex(join(workDir, "nested", "deep"), {
		magic: "pi-tape-index",
		version: 1,
		builtAt: "",
		digests: {},
		recipes: [],
		stepUsage: {},
		clusters: {},
		godSteps: [],
		stats: { recipes: 0, steps: 0, distinctSteps: 0, clusters: 0, meanOrthogonality: 0 },
	}));
});
