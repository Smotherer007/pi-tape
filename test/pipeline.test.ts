/**
 * End-to-end tests for the parts that make a recipe more than a transcript:
 *
 *   gaps     a credential or a machine path stays open instead of being folded in
 *   outcome  a failed recording is not knowledge, and is not silently learned from
 *   link     parts of different recordings can be stitched, and the seam is named
 *
 * The fixture is deliberately several unrelated procedures rather than one family
 * of variants, because stitching is only interesting across procedures.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { linkFragments } from "../src/contract.ts";
import { deriveOutcome } from "../src/outcome.ts";
import { extractRecipe } from "../src/recipe-extract.ts";
import { intersectRecipes } from "../src/recipe-intersect.ts";
import { composeRecipe, missingInputs, unfilledGaps } from "../src/recipe-query.ts";
import type { Recipe } from "../src/recipe-types.ts";
import {
	absolutePathFamily,
	containeriseFamily,
	deployFamily,
	dockerfileFamily,
	mixedOutcomeFamily,
	secretFamily,
	serviceFamily,
	tapeOfCalls,
	tapeOfCommands,
} from "./fixtures-family.ts";

function learned(tapes: Parameters<typeof extractRecipe>[0][], name: string): Recipe {
	const recipes = tapes.map((tape) => extractRecipe(tape).recipe);
	return intersectRecipes(recipes, { name }).recipe;
}

// ---------------------------------------------------------------------------
// outcomes
// ---------------------------------------------------------------------------

test("a green verification is success, and absence of errors is not", () => {
	const verified = tapeOfCommands(["npm install express", "npm test"], "verified");
	assert.equal(verified.outcome?.status, "success");
	assert.match(verified.outcome?.evidence[0] ?? "", /verification succeeded/);

	const quiet = tapeOfCommands(["ls -la src"], "quiet");
	assert.equal(quiet.outcome?.status, "unknown", "doing something without checking it is not success");
});

test("a failed verification marks the recording failed, even if earlier errors were fixed", () => {
	const broken = tapeOfCalls(
		[
			{ tool: "bash", args: { command: "npm run build" }, text: "syntax error", isError: true },
			{ tool: "bash", args: { command: "npm test" }, text: "1 failing", isError: true },
		],
		"broken",
	);
	assert.equal(broken.outcome?.status, "failed");
	assert.match(broken.outcome?.evidence[0] ?? "", /verification failed/);

	// A failed step that a later green verification made good is a successful run.
	const retried = tapeOfCalls(
		[
			{ tool: "bash", args: { command: "npm run build" }, text: "syntax error", isError: true },
			{ tool: "bash", args: { command: "npm test" }, text: "18 passing", isError: false },
		],
		"retried",
	);
	assert.equal(retried.outcome?.status, "success");
	assert.ok(
		retried.outcome?.evidence.some((line) => line.includes("earlier")),
		"the failed attempt is still reported",
	);
});

test("a declared outcome beats what the recorder could infer", () => {
	const entries = tapeOfCommands(["npm test"], "declared").entries;
	const outcome = deriveOutcome(entries, "failed");
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.declared, true);
});

test("splice learns from successful recordings and only reports the failures", () => {
	const tapes = mixedOutcomeFamily();
	assert.deepEqual(
		tapes.map((tape) => tape.outcome?.status),
		["success", "success", "failed"],
	);

	const result = intersectRecipes(
		tapes.map((tape) => extractRecipe(tape).recipe),
		{ name: "express-service" },
	);

	assert.equal(result.recipe.observations, 2, "the failed recording is not part of the skeleton");
	assert.equal(result.excludedFailed.length, 1);
	assert.equal(result.recipe.outcome.failures, 1);
	assert.equal(result.recipe.outcome.successes, 2);
	assert.equal(result.recipe.outcome.status, "mixed");
	assert.ok(
		result.recipe.outcome.evidence.some((line) => line.includes("excluded from the skeleton")),
		`expected the exclusion to be reported, got ${JSON.stringify(result.recipe.outcome.evidence)}`,
	);
	assert.deepEqual(
		result.recipe.steps.map((step) => step.template),
		["npm install express", "npm test"],
	);

	// Asking for them explicitly is allowed, but has to be asked for.
	const forced = intersectRecipes(
		tapes.map((tape) => extractRecipe(tape).recipe),
		{ name: "express-service", includeFailed: true },
	);
	assert.equal(forced.recipe.observations, 3);
	assert.equal(forced.excludedFailed.length, 0);
});

// ---------------------------------------------------------------------------
// gaps
// ---------------------------------------------------------------------------

test("a credential never reaches the recipe, however consistently it was used", () => {
	const [first, second] = secretFamily();
	assert.ok(first && second);
	assert.notEqual(first.id, second.id, "the recordings really are different runs");

	const recipe = learned([first, second], "publish");
	const json = JSON.stringify(recipe);

	assert.equal(json.includes("npm_aaaaaaaaaaaaaaaaaaaa"), false, "the first token must not be stored");
	assert.equal(json.includes("npm_bbbbbbbbbbbbbbbbbbbb"), false, "the second token must not be stored");
	assert.ok(json.includes("[redacted]"), "the marker records that a secret was there");
	assert.equal(recipe.steps[0]?.template, "npm publish --token {{token}}");

	// A secret is never a parameter: it has no observed variants worth choosing from.
	assert.deepEqual(recipe.parameters, []);
	assert.equal(recipe.slots[0]?.kind, "secret");

	const steps = composeRecipe(recipe);
	assert.deepEqual(missingInputs(steps), ["token"], "the caller still has to supply it");

	const gaps = unfilledGaps(recipe, steps);
	assert.equal(gaps[0]?.kind, "secret");
	assert.match(gaps[0]?.hint ?? "", /redacted/);

	// And supplying it does not resurrect a recorded value.
	assert.deepEqual(composeRecipe(recipe, { token: "npm_zzzzzzzzzzzzzzzzzzzz" }), [
		"npm publish --token npm_zzzzzzzzzzzzzzzzzzzz",
	]);
});

test("a credential is redacted in the example too, not just in the template", () => {
	const recipe = extractRecipe(secretFamily()[0] as never).recipe;
	const example = recipe.steps[0]?.example ?? "";
	assert.equal(example.includes("npm_aaaaaaaaaaaaaaaaaaaa"), false, "the human-readable example is an output too");
	assert.match(example, /--token \[redacted\]/);
});

test("a machine-specific path stays open, a relative one is part of the procedure", () => {
	const recipe = learned(absolutePathFamily() as never[], "absolute-paths");

	assert.deepEqual(
		recipe.steps.map((step) => step.template),
		["read {{path}}", "write {{path}}"],
		"an absolute path is not portable, so it cannot be folded in",
	);
	assert.ok(recipe.slots.every((slot) => slot.kind === "path"));
	assert.equal(recipe.slots.length, 2, "each step owns its own path slot");

	// A relative path, by contrast, is knowledge: it is part of the procedure.
	const service = learned(serviceFamily() as never[], "service");
	assert.ok(
		service.steps.some((step) => step.template === "write src/main.py"),
		`a project-relative path belongs in the skeleton, got ${JSON.stringify(service.steps.map((s) => s.template))}`,
	);
});

test("parameter kinds say how a gap has to be filled", () => {
	const recipe = learned(serviceFamily() as never[], "service");
	const byName = new Map(recipe.parameters.map((parameter) => [parameter.name, parameter]));

	const framework = byName.get("package");
	assert.ok(framework, `expected a package parameter, got ${JSON.stringify([...byName.keys()])}`);
	assert.equal(framework?.kind, "free", "a framework is knowledge the caller may extend");
	assert.deepEqual(framework?.variants.map((variant) => variant.label).sort(), ["fastapi", "flask"]);

	const port = byName.get("port");
	assert.ok(port, "the port varied independently of the framework, so it is its own parameter");
	assert.equal(port?.kind, "env", "a port is a fact about where this runs, not knowledge");
	assert.equal(port?.enumerated, false, "a port is free to set even though only two were observed");

	// The port must not have been grouped with the framework: fastapi ran on both.
	assert.equal(framework?.kind, "free");
	assert.deepEqual(framework?.members.map((member) => member.slot), ["package"]);
});

// ---------------------------------------------------------------------------
// contracts and stitching
// ---------------------------------------------------------------------------

test("contracts are derived from what the steps actually do", () => {
	const dockerfile = learned([dockerfileFamily()[0] as never], "dockerfile");
	assert.deepEqual(dockerfile.contracts.provides, [
		{ kind: "file", target: "Dockerfile", note: "write Dockerfile" },
	]);

	const image = learned([containeriseFamily()[0] as never], "containerise");
	assert.deepEqual(image.contracts.provides, [
		{ kind: "image", target: "api:latest", note: "docker build -t api:latest ." },
	]);
	assert.deepEqual(image.contracts.requires, [
		{ kind: "file", target: "Dockerfile", note: "docker build -t api:latest ." },
		{ kind: "command", target: "docker", note: "docker build -t api:latest ." },
	]);
});

test("a fragment that needs something nobody provides reports it as a gap", () => {
	const containerise = composeRecipe(learned([containeriseFamily()[0] as never], "containerise"));
	const report = linkFragments([{ name: "containerise", steps: containerise }]);

	assert.equal(report.resolved, false);
	assert.deepEqual(
		report.gaps.map((gap) => `${gap.condition.kind} ${gap.condition.target}`),
		["file Dockerfile"],
		"the missing Dockerfile is named, which is the whole point",
	);
	assert.deepEqual(report.environment, ["docker"], "the host tool is a probe, not a gap");
});

test("parts of different recordings stitch into one chain", () => {
	const dockerfile = composeRecipe(learned([dockerfileFamily()[0] as never], "dockerfile"));
	const containerise = composeRecipe(learned([containeriseFamily()[0] as never], "containerise"));
	const deploy = composeRecipe(learned([deployFamily()[0] as never], "deploy"));
	const service = composeRecipe(learned(serviceFamily() as never[], "service"), {
		package: "fastapi",
		port: "8000",
	});

	const report = linkFragments([
		{ name: "service", steps: service },
		{ name: "dockerfile", steps: dockerfile },
		{ name: "containerise", steps: containerise },
		{ name: "deploy", steps: deploy },
	]);

	assert.equal(report.resolved, true, report.text);
	assert.equal(report.gaps.length, 0);

	// The seam that matters: the image the build produced is the one run consumes.
	const image = report.satisfied.find((item) => item.condition.kind === "image");
	assert.equal(image?.condition.target, "api:latest");
	assert.equal(image?.providedBy, "containerise");

	assert.deepEqual(report.environment, ["docker", "pip", "python", "uvicorn"]);
	assert.deepEqual(
		report.result.map((item) => `${item.kind} ${item.target}`).sort(),
		["dependency fastapi", "dir .venv", "file src/main.py"],
		"what the chain leaves behind, with everything consumed along the way taken out",
	);
	assert.match(report.text, /linking 4 fragment\(s\): service → dockerfile → containerise → deploy/);
});

test("skipping a fragment in the middle is reported as the gap it is", () => {
	const containerise = composeRecipe(learned([containeriseFamily()[0] as never], "containerise"));
	const deploy = composeRecipe(learned([deployFamily()[0] as never], "deploy"));

	// Running the deploy without ever building the image.
	const report = linkFragments([
		{ name: "containerise", steps: containerise },
		{ name: "deploy", steps: deploy },
	]);

	assert.equal(report.resolved, false);
	assert.deepEqual(
		report.gaps.map((gap) => `${gap.condition.kind} ${gap.condition.target}`),
		["file Dockerfile"],
		"the image really is produced; what is missing is the input to producing it",
	);
});

test("an unset parameter is unresolved, not silently treated as met", () => {
	const service = composeRecipe(learned(serviceFamily() as never[], "service"));
	const report = linkFragments([{ name: "service", steps: service }]);

	assert.ok(
		report.unresolved.length > 0,
		`expected unresolved conditions, got ${JSON.stringify(report)}`,
	);
	assert.equal(report.resolved, false);
	assert.ok(report.unresolved.every((item) => item.condition.target.includes("{{")));
});

test("a fragment that writes and consumes a file satisfies its own requirement", () => {
	// Order inside a fragment counts: writing the Dockerfile and then building is
	// one procedure, and reporting the build as unfulfillable would be wrong.
	const report = linkFragments([
		{ name: "everything", steps: ["write Dockerfile", "docker build -t api:latest ."] },
	]);

	assert.equal(report.resolved, true, report.text);
	assert.equal(report.gaps.length, 0);
});
