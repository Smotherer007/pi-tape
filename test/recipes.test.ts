import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeCommand, categorizeFile, isNoiseCommand, normalizeCommand, renderTemplate, shapeAction } from "../src/normalize.ts";
import { recordSession } from "../src/record.ts";
import { extractRecipe } from "../src/recipe-extract.ts";
import { familyOrthogonality, intersectRecipes, lcsAlignment, lcsLength, medoid } from "../src/recipe-intersect.ts";
import type { Recipe } from "../src/recipe-types.ts";
import { composeRecipe, missingInputs, queryRecipes } from "../src/recipe-query.ts";
import { parseSession } from "../src/session.ts";
import type { TapeFile } from "../src/types.ts";
import { assistantToolCall, sessionText, systemEntry, toolResultEntry } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build a synthetic recording whose tool calls are exactly these bash commands. */
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

/**
 * A family with combinatorial variation: two Vue runs and two React runs, and
 * the two Vue runs differ in project name. That structure is what lets the
 * intersection tell a real parameter from a coincidence.
 */
function familyTapes(): TapeFile[] {
	return [
		recordingOf(["npm create vue@latest app-one", "npm install vue-router", "npm run build"], "setup app-one"),
		recordingOf(["npm create vue@latest app-two", "npm install vue-router", "npm run build"], "setup app-two"),
		recordingOf(["npm create react@latest app-three", "npm install react-router-dom", "npm run build"], "setup app-three"),
		recordingOf(["npm create react@latest app-four", "npm install react-router-dom", "npm run build"], "setup app-four"),
	];
}

// ---------------------------------------------------------------------------
// normalization
// ---------------------------------------------------------------------------

test("two recordings of the same procedure produce the same step key", () => {
	const vue = normalizeCommand("npm create vue@latest my-app");
	const react = normalizeCommand("npm create react@latest other-app");

	assert.equal(vue.key, react.key, "the framework argument must not be part of the identity");
	assert.equal(vue.key, "npm create <*> <*>");
});

test("bare package arguments are normalized by command position, not content", () => {
	assert.equal(normalizeCommand("npm install vue-router").key, normalizeCommand("npm install react-router-dom").key);
	assert.equal(normalizeCommand("npm install vue-router").key, "npm install <*>");

	// A flag-based install is a different action and keeps a distinct key.
	assert.equal(normalizeCommand("npm install -D vite").key, "npm install -D <*>");
	assert.notEqual(normalizeCommand("npm install -D vite").key, normalizeCommand("npm install vite").key);
});

test("templates carry semantic slot names derived from position", () => {
	const analyzed = analyzeCommand("npm create vue@latest my-app");
	const { template, slots } = renderTemplate(analyzed, (token) => token.suggested ?? "arg");

	assert.equal(template, "npm create {{template}} {{name}}");
	assert.deepEqual(slots, [
		{ name: "template", value: "vue@latest" },
		{ name: "name", value: "my-app" },
	]);
});

test("git branches, services and run scripts get their own slots", () => {
	const branch = analyzeCommand("git checkout -b feat/login");
	assert.equal(branch.key, "git checkout -b <*>");
	assert.equal(renderTemplate(branch, (token) => token.suggested ?? "arg").template, "git checkout -b {{branch}}");

	const service = analyzeCommand("systemctl enable netbird");
	assert.equal(service.key, normalizeCommand("systemctl enable nginx").key);

	const script = analyzeCommand("npm run dev");
	assert.equal(renderTemplate(script, (token) => token.suggested ?? "arg").template, "npm run {{script}}");
});

test("redirections are dropped and shell variables become wildcards", () => {
	assert.equal(normalizeCommand("ls -la /tmp 2>/dev/null").key, "ls -la <*>");
	assert.equal(normalizeCommand("cat $HOME/file.txt").key, normalizeCommand("cat ${OTHER}/file.txt").key);
});

test("versions and paths are normalized away", () => {
	assert.equal(normalizeCommand("npm i pkg@1.2.3").key, normalizeCommand("npm i pkg@2.0.0").key);
	assert.equal(normalizeCommand("node src/a.ts").key, normalizeCommand("node src/b.ts").key);
});

test("reconnaissance is recognised", () => {
	assert.equal(isNoiseCommand("ls -la <*>"), true);
	assert.equal(isNoiseCommand("echo hello"), true);
	assert.equal(isNoiseCommand("git status"), true);
	assert.equal(isNoiseCommand("npm create <*> <*>"), false);
	assert.equal(isNoiseCommand("npm install <*>"), false);
});

test("file arguments are identified by category, not by path", () => {
	assert.equal(categorizeFile("/a/package.json"), "manifest");
	assert.equal(categorizeFile("src/main.ts"), "source");
	assert.equal(categorizeFile("src/main.test.ts"), "test");
	assert.equal(categorizeFile("vite.config.ts"), "build-config");
	assert.equal(categorizeFile(".github/workflows/ci.yml"), "ci");
	assert.equal(categorizeFile("Dockerfile"), "container");

	const a = shapeAction("read", { path: "src/a.ts" });
	const b = shapeAction("read", { path: "src/very/different/b.ts" });
	assert.equal(a.key, b.key, "reading a different source file is the same kind of step");
	assert.equal(a.key, "read::source");
});

// ---------------------------------------------------------------------------
// extraction
// ---------------------------------------------------------------------------

test("extraction produces steps, slots and dependency validators", () => {
	const tape = recordingOf(
		["npm create vue@latest my-app", "npm install vue-router", "npm run build"],
		"setup",
	);
	const { recipe } = extractRecipe(tape, { name: "setup" });

	assert.equal(recipe.steps.length, 3);
	assert.deepEqual(
		recipe.steps.map((step) => step.key),
		["bash::npm create <*> <*>", "bash::npm install <*>", "bash::npm run <*>"],
	);
	assert.equal(recipe.observations, 1);

	// One slot per placeholder, scoped to its step.
	assert.deepEqual(
		recipe.slots.map((slot) => `${slot.stepIndex}#${slot.name}`),
		["0#template", "0#name", "1#package", "2#script"],
	);

	// The dependency check is derived, which is what makes freshness testable.
	const commands = recipe.validators.map((validator) => validator.command);
	assert.ok(commands.includes("npm view vue version"));
	assert.ok(commands.includes("npm view vue-router version"));
	// The project name is not a dependency and must never produce a validator.
	assert.equal(
		commands.some((command) => command.includes("my-app")),
		false,
		`project names must not become validators, got ${commands.join(", ")}`,
	);
});

test("a repeated identical command is kept as two steps that align on one key", () => {
	const tape = recordingOf(["npm install vue-router", "npm install vue-router"], "twice");
	const { recipe } = extractRecipe(tape);

	// Both invocations are preserved: a repeat can be a deliberate retry after a
	// fix, and silently dropping recorded actions would be worse than a little noise.
	assert.equal(recipe.steps.length, 2);
	assert.equal(recipe.steps[0]?.key, recipe.steps[1]?.key, "they share one identity, so they align");

	// Slots are scoped per step, so each invocation owns its own `package` slot.
	assert.deepEqual(
		recipe.slots.map((slot) => `${slot.stepIndex}#${slot.name}`),
		["0#package", "1#package"],
	);
	assert.ok(recipe.slots.every((slot) => slot.fillers[0]?.value === "vue-router"));

	// Because both steps share a key, the intersection collapses them onto one
	// skeleton position instead of treating them as two different procedures.
	const result = intersectRecipes([recipe], { name: "twice" });
	assert.equal(result.recipe.steps.length, 2);
});

// ---------------------------------------------------------------------------
// LCS alignment
// ---------------------------------------------------------------------------

test("LCS alignment survives insertions and deletions", () => {
	const reference = ["a", "b", "c", "d"];
	assert.deepEqual(lcsAlignment(reference, ["a", "c", "d"]), [
		[0, 0],
		[2, 1],
		[3, 2],
	]);
	assert.deepEqual(lcsAlignment(reference, ["x", "a", "b", "y", "d"]), [
		[0, 1],
		[1, 2],
		[3, 4],
	]);
	assert.equal(lcsLength(["a", "b"], ["b", "a"]), 1);
});

test("the medoid is the recording most similar to the rest", () => {
	assert.equal(medoid([["a", "b", "c"], ["a", "b", "c"], ["x", "y", "z"]]), 0);
	assert.equal(medoid([["x", "y", "z"], ["a", "b", "c"], ["a", "b", "c"]]), 1);
});

// ---------------------------------------------------------------------------
// intersection
// ---------------------------------------------------------------------------

test("the intersection yields a skeleton, not a concatenation", () => {
	const recipes = familyTapes().map((tape) => extractRecipe(tape, { scope: "project" }).recipe);
	const result = intersectRecipes(recipes, { name: "frontend setup", scope: "project" });

	// Every recording had the same three meaningful steps.
	assert.equal(result.sharedSteps, 3);
	assert.equal(result.longestSteps, 3);
	assert.equal(result.recipe.observations, 4);
	assert.equal(result.recipe.steps.length, 3);
	assert.equal(result.noiseExcluded, 0, "these recordings contain no reconnaissance");
});

test("reconnaissance is left out of the skeleton", () => {
	const withNoise = familyTapes().map((tape) => extractRecipe(tape).recipe);
	// Prepend a reconnaissance step to one recording, then intersect.
	const noisy = structuredClone(withNoise[0] as Recipe);
	if (noisy.steps[0]) {
		noisy.steps.unshift({ ...noisy.steps[0], key: "bash::ls -la <*>", verb: "ls", template: "ls -la {{target}}", noise: true });
	}
	const result = intersectRecipes([noisy, ...withNoise.slice(1)], { name: "with noise" });

	assert.ok(result.noiseExcluded > 0);
	assert.equal(
		result.recipe.steps.some((step) => step.verb === "ls"),
		false,
		"orientation commands are not part of the procedure",
	);
});

test("a slot that never varies across recordings is inlined as a constant", () => {
	const recipes = [
		recordingOf(["npm run build"], "a"),
		recordingOf(["npm run build"], "b"),
	].map((tape) => extractRecipe(tape).recipe);

	const result = intersectRecipes(recipes, { name: "constant" });
	const step = result.recipe.steps[0];

	assert.equal(step?.template, "npm run build", "the value is folded back in");
	assert.equal(step?.usesSlots.length, 0);
	assert.equal(result.recipe.slots.length, 0, "a constant is not a slot");
});

test("co-varying slots are grouped into one parameter — the Vue/React case", () => {
	const recipes = familyTapes().map((tape) => extractRecipe(tape).recipe);
	const result = intersectRecipes(recipes, { name: "frontend setup" });

	// `template` (the framework) and `package` (the router) always moved together,
	// so they are one parameter with two variants.
	const framework = result.recipe.parameters.find((parameter) =>
		parameter.variants.some((variant) => variant.label.includes("vue")),
	);

	assert.ok(framework, `expected a framework parameter, got ${JSON.stringify(result.recipe.parameters.map((p) => p.name))}`);
	assert.equal(framework?.variants.length, 2);

	const labels = framework?.variants.map((variant) => variant.label).sort();
	assert.deepEqual(labels, ["react@latest", "vue@latest"]);

	const vue = framework?.variants.find((variant) => variant.label === "vue@latest");
	assert.equal(vue?.observedIn, 2, "two Vue runs support this variant");

	// Both members moved with it: the framework argument and the router package.
	assert.equal(framework?.members.length, 2, "template and package belong to the same parameter");
	const values = Object.values(vue?.values ?? {});
	assert.ok(values.includes("vue-router"), `expected vue-router among ${JSON.stringify(values)}`);
});

test("slots that vary independently are not grouped", () => {
	const recipes = familyTapes().map((tape) => extractRecipe(tape).recipe);
	const result = intersectRecipes(recipes, { name: "frontend setup" });

	// The project name differs in all four recordings while the framework repeats,
	// so it cannot be part of the framework parameter.
	const framework = result.recipe.parameters.find((parameter) =>
		parameter.variants.some((variant) => variant.label.includes("vue")),
	);
	const nameMembers = (framework?.members ?? []).map((member) => member.slot);
	assert.equal(nameMembers.includes("name"), false, "the project name is not part of the framework parameter");

	const nameParameter = result.recipe.parameters.find((parameter) => parameter.name === "name");
	assert.ok(nameParameter, "the project name is its own parameter");
	assert.equal(nameParameter?.variants.length, 4);
});

test("one parameter swap rewrites a whole variant", () => {
	const recipes = familyTapes().map((tape) => extractRecipe(tape).recipe);
	const result = intersectRecipes(recipes, { name: "frontend setup" });
	const parameter = result.recipe.parameters.find((item) => item.variants.some((v) => v.label.includes("react")));
	assert.ok(parameter, "expected the framework parameter");

	const steps = composeRecipe(result.recipe, {
		[parameter?.name as string]: parameter?.variants.find((variant) => variant.label.includes("react"))?.label as string,
	});

	assert.ok(
		steps.some((step) => step.includes("react")),
		`the React variant must reach the generated steps, got ${JSON.stringify(steps)}`,
	);
	assert.ok(
		steps.some((step) => step.includes("react-router-dom")),
		"swapping the parameter also swaps the router, which is the whole point",
	);
});

test("orthogonality is computed from the data, not assumed", () => {
	const identical = [
		recordingOf(["npm create vue@latest a"], "x"),
		recordingOf(["npm create vue@latest b"], "y"),
	].map((tape) => extractRecipe(tape).recipe);

	const different = [
		recordingOf(["npm create vue@latest a"], "x"),
		recordingOf(["docker build -t app ."], "y"),
	].map((tape) => extractRecipe(tape).recipe);

	assert.equal(familyOrthogonality(identical), 1, "identical procedures are fully orthogonal");
	assert.equal(familyOrthogonality(different), 0, "unrelated runs share nothing");
});

test("intersecting a single recipe is the identity", () => {
	const recipe = extractRecipe(recordingOf(["npm run build"], "solo")).recipe;
	const result = intersectRecipes([recipe], { name: "solo" });

	assert.equal(result.sharedSteps, recipe.steps.length);
	assert.equal(result.recipe.observations, 1);
});
