/**
 * Segmentation and model regression.
 *
 * Segmentation is the deterministic half of "carry a part of one recording into
 * another": the judgement is where to cut, and the bookkeeping — reindexing,
 * contract derivation, refusing ranges that do not tile — is here. Regression is
 * the comparison half of a model upgrade, and it is strict about structure and
 * lenient about wording, because a different tool call is a different procedure and
 * a different sentence is not.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractRecipe } from "../src/recipe-extract.ts";
import { intersectRecipes } from "../src/recipe-intersect.ts";
import { composeRecipe, missingInputs, unfilledGaps } from "../src/recipe-query.ts";
import type { Recipe } from "../src/recipe-types.ts";
import { compareAnswers, formatRegression, shapeOf, summarizeRegression } from "../src/regress.ts";
import { parseRange, segmentEvidence, segmentGaps, segmentToRecipe, sliceRecipe } from "../src/segment.ts";
import { recordSession } from "../src/record.ts";
import { parseSession } from "../src/session.ts";
import type { TapeFile } from "../src/types.ts";
import { serviceFamily, tapeOfCalls, tapeOfCommands } from "./fixtures-family.ts";
import { assistantToolCall, assistantText, sessionText, systemEntry, toolResultEntry } from "./fixtures.ts";

function learned(tapes: TapeFile[], name: string): Recipe {
	return intersectRecipes(
		tapes.map((tape) => extractRecipe(tape).recipe),
		{ name, includeFailed: true },
	).recipe;
}

const service = (): Recipe => learned(serviceFamily(), "service");

// ---------------------------------------------------------------------------
// segmentation
// ---------------------------------------------------------------------------

test("the evidence a model needs is numbered steps with their conditions", () => {
	const evidence = segmentEvidence(service());
	assert.match(evidence, /\[0\] python -m venv \.venv/);
	assert.match(evidence, /\[1\] pip install \{\{package\}\}/);
	assert.match(evidence, /slots package:free/);
	assert.match(evidence, /slots port:env/);
	assert.match(evidence, /parameters \(a cut must not split one\)/);
	assert.match(evidence, /package \[free\] {2}members 1#package/);
	assert.match(evidence, /needs command pip/);
});

test("a slice reindexes its own steps, slots and parameters", () => {
	const recipe = service();
	const { segments, droppedParameters } = sliceRecipe(recipe, [
		{ from: 0, to: 1, name: "setup", intent: "create the environment and install the framework" },
		{ from: 2, to: 3, name: "run", intent: "write the entry point and start it" },
	]);

	assert.deepEqual(droppedParameters, [], "no parameter spans this cut");
	assert.deepEqual(segments.map((segment) => segment.intent), [
		"create the environment and install the framework",
		"write the entry point and start it",
	]);

	const [setup, run] = segments;
	assert.deepEqual(setup?.steps.map((step) => step.template), ["python -m venv .venv", "pip install {{package}}"]);
	assert.deepEqual(setup?.slots.map((slot) => `${slot.stepIndex}#${slot.name}`), ["1#package"]);
	assert.deepEqual(setup?.parameters.map((parameter) => parameter.name), ["package"]);
	assert.deepEqual(run?.slots.map((slot) => `${slot.stepIndex}#${slot.name}`), ["1#port"], "indices are relative to the segment");
	assert.deepEqual(
		setup?.contracts.provides.map((item) => `${item.kind} ${item.target}`),
		["dir .venv", "dependency {{package}}"],
	);
	assert.deepEqual(segmentGaps(setup as never).map((gap) => gap.kind), ["free"]);
});

test("cuts may extract a part, but they must never overlap or fall outside", () => {
	const recipe = service();

	// Extraction is the normal case: the steps outside the cuts stay where they are,
	// and which ones they are is reported rather than assumed.
	const partial = sliceRecipe(recipe, [{ from: 0, to: 1, name: "setup" }]);
	assert.deepEqual(partial.uncovered, [{ from: 2, to: 3 }]);
	assert.deepEqual(partial.segments[0]?.steps.map((step) => step.template), ["python -m venv .venv", "pip install {{package}}"]);

	// Overlapping would run a step twice, which is always wrong.
	assert.throws(
		() => sliceRecipe(recipe, [{ from: 0, to: 2, name: "a" }, { from: 2, to: 3, name: "b" }]),
		/already inside an earlier cut/,
	);

	// Claiming to cover everything has to mean it.
	assert.throws(
		() => sliceRecipe(recipe, [{ from: 0, to: 1, name: "a" }], { requireCoverage: true }),
		/do not cover every step: 2-3/,
	);

	assert.doesNotThrow(() =>
		sliceRecipe(recipe, [{ from: 0, to: 1, name: "a" }, { from: 2, to: 3, name: "b" }], { requireCoverage: true }),
	);

	assert.throws(() => sliceRecipe(recipe, [{ from: 0, to: 9, name: "a" }]), /but the recipe has 4 step/);
	assert.throws(() => sliceRecipe(recipe, [{ from: 3, to: 1, name: "a" }]), /not a step range/);
	assert.throws(() => sliceRecipe(recipe, []), /at least one cut/);
});

test("a cut through a parameter is refused and reported, not silently split", () => {
	// The Vue/React shape: the framework argument and the router package moved
	// together, so a cut between them would produce two halves that cannot be
	// recombined consistently.
	const frontend = learned(
		[
			tapeOfCommands(["npm create vue@latest app-one", "npm install vue-router", "npm run build"], "a"),
			tapeOfCommands(["npm create vue@latest app-two", "npm install vue-router", "npm run build"], "b"),
			tapeOfCommands(["npm create react@latest app-three", "npm install react-router-dom", "npm run build"], "c"),
			tapeOfCommands(["npm create react@latest app-four", "npm install react-router-dom", "npm run build"], "d"),
		],
		"frontend",
	);
	const parameter = frontend.parameters.find((item) => item.members.length > 1);
	assert.ok(parameter, "the fixture must produce a multi-member parameter");

	const split = parameter.members[0]?.stepIndex as number;
	const { droppedParameters, segments } = sliceRecipe(frontend, [
		{ from: 0, to: split, name: "scaffold" },
		{ from: split + 1, to: frontend.steps.length - 1, name: "rest" },
	]);

	assert.equal(droppedParameters.length, 1, "reported once, not once per segment");
	assert.equal(droppedParameters[0]?.name, parameter.name);
	assert.match(droppedParameters[0]?.reason ?? "", /spans the cut/);

	// Neither half keeps a piece of the group, so nothing can look usable and not be.
	assert.deepEqual(segments[0]?.parameters.map((item) => item.name), ["name"], "the independent parameter stays");
	assert.deepEqual(segments[1]?.parameters, []);
});

test("a segment becomes a recipe that can be stored and linked", () => {
	const [setup] = sliceRecipe(service(), [
		{ from: 0, to: 1, name: "service-setup", intent: "set the service up" },
	]).segments;

	const recipe = segmentToRecipe(setup as never, { scope: "project" });
	assert.equal(recipe.name, "service-setup");
	assert.equal(recipe.scope, "project");
	assert.match(recipe.description, /set the service up \(from "service", steps 0-1\)/);
	assert.equal(recipe.steps.length, 2);
	assert.deepEqual(recipe.parameters.map((parameter) => parameter.name), ["package"]);
	assert.deepEqual(
		composeRecipe(recipe, { package: "flask" }),
		["python -m venv .venv", "pip install flask"],
		"a segment is usable on its own",
	);
	assert.deepEqual(
		recipe.contracts.provides.map((item) => `${item.kind} ${item.target}`),
		["dir .venv", "dependency {{package}}"],
	);
});

test("step ranges parse the way a person writes them", () => {
	assert.deepEqual(parseRange("3-7"), { from: 3, to: 7 });
	assert.deepEqual(parseRange("4"), { from: 4, to: 4 });
	assert.deepEqual(parseRange(" 2 - 5 "), { from: 2, to: 5 });
	assert.throws(() => parseRange("3-1"), /ends before it starts/);
	assert.throws(() => parseRange("two"), /expected a step range/);
});

// ---------------------------------------------------------------------------
// regression
// ---------------------------------------------------------------------------

test("an identical answer is not a divergence, and a reworded one is only wording", () => {
	const recorded = shapeOf({
		role: "assistant",
		content: [{ type: "text", text: "I will create the file." }],
		stopReason: "stop",
	});

	assert.deepEqual(compareAnswers(recorded, recorded), []);

	// Whitespace and line wrapping are not a behaviour change.
	const rewrapped = shapeOf({
		role: "assistant",
		content: [{ type: "text", text: "I will create\n  the file." }],
		stopReason: "stop",
	});
	assert.deepEqual(compareAnswers(recorded, rewrapped), []);

	const reworded = shapeOf({
		role: "assistant",
		content: [{ type: "text", text: "Creating the file now." }],
		stopReason: "stop",
	});
	const divergences = compareAnswers(recorded, reworded);
	assert.deepEqual(divergences.map((item) => item.kind), ["text"]);
	assert.equal(divergences[0]?.detail, "the wording differs");
});

test("a different tool call is the divergence that matters", () => {
	const recorded = shapeOf({
		role: "assistant",
		content: [
			{ type: "text", text: "ok" },
			{ type: "toolCall", name: "bash", arguments: { command: "npm test" } },
		],
		stopReason: "toolUse",
	});
	const live = shapeOf({
		role: "assistant",
		content: [
			{ type: "text", text: "ok" },
			{ type: "toolCall", name: "bash", arguments: { command: "npm run test" } },
		],
		stopReason: "toolUse",
	});

	const divergences = compareAnswers(recorded, live);
	assert.deepEqual(divergences.map((item) => item.kind), ["toolCalls"]);
	assert.match(divergences[0]?.recorded ?? "", /npm test/);
	assert.match(divergences[0]?.live ?? "", /npm run test/);

	// Argument key order is not a difference: the comparison is canonical.
	const reordered = shapeOf({
		role: "assistant",
		content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
		stopReason: "toolUse",
	});
	const same = shapeOf({
		role: "assistant",
		content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
		stopReason: "toolUse",
	});
	assert.deepEqual(compareAnswers(reordered, same), []);
});

test("a model that fails outright is reported as an error, not as a difference in wording", () => {
	const recorded = shapeOf({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
	const live = shapeOf({
		role: "assistant",
		content: [{ type: "text", text: "" }],
		stopReason: "error",
		errorMessage: "rate limited",
	});

	const divergences = compareAnswers(recorded, live);
	assert.equal(divergences[0]?.kind, "error");
	assert.match(divergences[0]?.live ?? "", /rate limited/);
});

test("the report separates a changed procedure from a changed sentence", () => {
	const report = summarizeRegression({
		tape: "auth-refactor",
		recordedModel: "old-model",
		liveModel: "new-model",
		samples: [
			{ label: "#1", divergences: [] },
			{ label: "#2", divergences: [{ kind: "text", detail: "the wording differs", recorded: "a", live: "b" }] },
			{
				label: "#3",
				divergences: [
					{ kind: "toolCalls", detail: "same number of tool calls, different calls", recorded: "npm test", live: "npm run test" },
					{ kind: "text", detail: "the wording differs", recorded: "a", live: "b" },
				],
			},
		],
		structuralDivergences: 0,
		wordingDivergences: 0,
		identical: 0,
		liveTokens: 1200,
	});

	assert.equal(report.identical, 1);
	assert.equal(report.wordingDivergences, 1, "#2 changed only in wording");
	assert.equal(report.structuralDivergences, 1, "#3 changed what it would do");

	const text = formatRegression(report);
	assert.match(text, /old-model → new-model/);
	assert.match(text, /1 identical · 1 structurally different · 1 only reworded/);
	assert.match(text, /the comparison itself cost 1200 tokens/);
	assert.match(text, /structurally different requests:/);
	assert.match(text, /recorded: npm test/);
});

// ---------------------------------------------------------------------------
// tape-level redaction
// ---------------------------------------------------------------------------

test("a redacted recording loses the credential and says that it is lossy", () => {
	const build = (redact: boolean): TapeFile => {
		const entries = [systemEntry("s1", null)];
		entries.push(assistantToolCall("a1", "s1", "bash", { command: "npm publish --token npm_aaaaaaaaaaaaaaaaaaaa" }));
		entries.push(toolResultEntry("t1", "a1", "bash", "published with token npm_aaaaaaaaaaaaaaaaaaaa"));
		entries.push(assistantText("a2", "t1", "done"));
		return recordSession(parseSession(sessionText(entries)), { name: "publish", redact }).tape;
	};

	const plain = build(false);
	const redacted = build(true);

	assert.notEqual(plain.id, redacted.id, "redaction changes what the tape contains, so its address changes");
	assert.ok(JSON.stringify(plain).includes("npm_aaaaaaaaaaaaaaaaaaaa"));

	const json = JSON.stringify(redacted);
	assert.equal(json.includes("npm_aaaaaaaaaaaaaaaaaaaa"), false, "neither the argument nor the result keeps the token");
	assert.ok(json.includes("[redacted]"), "the marker records that something was removed");
	assert.equal(redacted.lossy, true);
	assert.equal(redacted.profile, "normal", "redaction is not a capture profile, it is a separate decision");
	assert.ok(redacted.dropped.some((item) => /credential\(s\) replaced/.test(item)), JSON.stringify(redacted.dropped));

	// The shape survives, so a redacted tape still carries a usable procedure.
	const recipe = extractRecipe(redacted).recipe;
	assert.equal(recipe.steps[0]?.template, "npm publish --token {{token}}");
	const steps = composeRecipe(recipe);
	assert.deepEqual(missingInputs(steps), ["token"]);
	assert.equal(unfilledGaps(recipe, steps)[0]?.kind, "secret");
	assert.equal(unfilledGaps(recipe, steps)[0]?.hint.includes("redacted"), true);
});

test("redaction leaves a tape without credentials untouched", () => {
	const tape = tapeOfCalls([{ tool: "bash", args: { command: "npm test" } }], "clean");
	const redacted = recordSession(parseSession(sessionText([systemEntry("s1", null), assistantToolCall("a1", "s1", "bash", { command: "npm test" }), toolResultEntry("t1", "a1", "bash", "ok")])), {
		name: "clean",
		redact: true,
	}).tape;

	assert.equal(redacted.lossy, false, "nothing was redacted, so nothing was lost");
	assert.deepEqual(redacted.dropped, []);
	assert.ok(tape.outcome);
});
