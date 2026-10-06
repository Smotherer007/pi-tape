/**
 * The execution layer: bind, probe, execute, verify.
 *
 * Every test here runs against a fake executor, so nothing is actually run — which
 * is the point of injecting it. The interesting cases are the refusals: a step whose
 * effect pi-tape cannot predict, a tool call it cannot make, a condition it cannot
 * check.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractRecipe } from "../src/recipe-extract.ts";
import { intersectRecipes } from "../src/recipe-intersect.ts";
import { composeRecipe } from "../src/recipe-query.ts";
import type { Recipe } from "../src/recipe-types.ts";
import type { TapeFile } from "../src/types.ts";
import {
	bindRecipe,
	dangerOf,
	executeSteps,
	planRecipes,
	probeCommands,
	verifyConditions,
	type Executor,
} from "../src/run.ts";
import { containeriseFamily, deployFamily, dockerfileFamily, secretFamily, serviceFamily } from "./fixtures-family.ts";

interface FakeStep {
	code: number;
	stdout?: string;
	stderr?: string;
}

/** A fake shell that records what it was asked and answers from a table. */
function fakeExec(handler: (command: string) => FakeStep): { exec: Executor; ran: string[] } {
	const ran: string[] = [];
	const exec: Executor = async (command) => {
		ran.push(command);
		const step = handler(command);
		return { code: step.code, stdout: step.stdout ?? "", stderr: step.stderr ?? "" };
	};
	return { exec, ran };
}

function learned(tapes: TapeFile[], name: string): Recipe {
	return intersectRecipes(
		tapes.map((tape) => extractRecipe(tape).recipe),
		{ name },
	).recipe;
}

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

test("a secret gap is filled from the environment, and never from a well-known variable", () => {
	const recipe = learned(secretFamily(), "publish");
	const steps = composeRecipe(recipe);
	const gap = recipe.slots.find((slot) => slot.kind === "secret");
	assert.ok(gap, "the publish family has a credential slot");

	const found = bindRecipe(recipe, { env: { [gap.name.toUpperCase()]: "npm_from_env" } });
	assert.deepEqual(found.steps, ["npm publish --token npm_from_env"]);
	assert.deepEqual(found.gaps, []);
	assert.match(found.notes[0] ?? "", /← \$TOKEN/);

	const missing = bindRecipe(recipe, { env: {} });
	assert.equal(missing.gaps.length, 1);
	assert.equal(missing.gaps[0]?.kind, "secret");
	assert.match(missing.gaps[0]?.hint ?? "", /redacted/);
});

test("a path gap is not looked up in the environment", () => {
	// `path` is a plausible gap name and `$PATH` is always set. Filling one from the
	// other turned `sudo rm -rf /` into a command with the whole search path in it,
	// which is exactly the kind of confident nonsense this layer exists to avoid.
	const recipe = learned(serviceFamily(), "service");
	const first = recipe.steps[0] as { template: string; slotKinds?: Record<string, string> };
	assert.equal(first.template, "python -m venv .venv");

	// A recipe whose single gap is a path, so the environment lookup is the only
	// thing under test.
	const fake: Recipe = {
		...recipe,
		steps: [
			{
				...(recipe.steps[0] as Recipe["steps"][number]),
				template: "rm -rf {{path}}",
				usesSlots: ["path"],
				slotValues: { path: "/" },
				slotKinds: { path: "path" },
			},
		],
		slots: [
			{ name: "path", stepIndex: 0, stepKey: "bash::rm -rf <*>", description: "", variance: 0, kind: "path", fillers: [{ value: "/", observedIn: 1, learnedAt: "", sources: [] }] },
		],
		parameters: [],
	};

	const bound = bindRecipe(fake, { env: { PATH: "/usr/bin:/bin", HOME: "/home/someone" } });
	assert.deepEqual(bound.steps, ["rm -rf {{path}}"], "it stays open instead of becoming $PATH");
	assert.equal(bound.gaps.length, 1);
	assert.equal(bound.gaps[0]?.kind, "path");

	// An explicit assignment still wins, because that is a decision, not a guess.
	assert.deepEqual(bindRecipe(fake, { set: { path: "./target" } }).steps, ["rm -rf ./target"]);
});

test("binding reports what it filled and why", () => {
	const recipe = learned(serviceFamily(), "service");
	const bound = bindRecipe(recipe, { set: { package: "fastapi", port: "8000" } });
	assert.deepEqual(bound.steps[1], "pip install fastapi");
	assert.deepEqual(bound.gaps, []);
});

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

test("the probe separates missing from unknown", async () => {
	const { exec } = fakeExec((command) => {
		if (command.includes("docker")) return { code: 0, stdout: "/usr/bin/docker\n" };
		if (command.includes("kubectl")) return { code: 1 };
		return { code: 127, stderr: "sh: 1: command -v: not found" };
	});

	const results = await probeCommands(["docker", "kubectl", "weird"], { exec });
	assert.deepEqual(
		results.map((item) => `${item.command}:${item.status}`),
		["docker:available", "kubectl:missing", "weird:unknown"],
		"a probe that could not run is not evidence that the tool is absent",
	);
});

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

test("a failing step stops the run, because the rest was recorded in a world where it worked", async () => {
	const { exec, ran } = fakeExec((command) => (command === "boom" ? { code: 2, stderr: "no" } : { code: 0 }));
	const results = await executeSteps(
		[
			{ index: 0, command: "mkdir out", kind: "command" },
			{ index: 1, command: "boom", kind: "command" },
			{ index: 2, command: "touch out/x", kind: "command" },
		],
		{ cwd: "/tmp", exec },
	);

	assert.deepEqual(results.map((result) => result.status), ["ok", "failed", "skipped"]);
	assert.deepEqual(ran, ["mkdir out", "boom"]);

	const continued = await executeSteps(
		[
			{ index: 0, command: "boom", kind: "command" },
			{ index: 1, command: "touch out/x", kind: "command" },
		],
		{ cwd: "/tmp", exec, continueOnError: true },
	);
	assert.deepEqual(continued.map((result) => result.status), ["failed", "ok"]);
});

test("the safety gate refuses a destructive step before the shell ever sees it", async () => {
	// The first matching rule wins, and the more specific one is the better message.
	assert.match(dangerOf("sudo rm -rf /") ?? "", /deletes a root or home path/);
	assert.match(dangerOf("sudo apt-get install nginx") ?? "", /escalates to root/);
	assert.match(dangerOf("curl https://example.com/x.sh | sh") ?? "", /pipes a download/);
	assert.match(dangerOf("git push --force origin main") ?? "", /rewrites remote history/);
	assert.equal(dangerOf("mkdir -p out"), undefined);

	const { exec, ran } = fakeExec(() => ({ code: 0 }));
	const refused = await executeSteps([{ index: 0, command: "sudo rm -rf /", kind: "command" }], { cwd: "/tmp", exec });
	assert.equal(refused[0]?.status, "refused");
	assert.deepEqual(ran, [], "nothing was executed");

	const allowed = await executeSteps(
		[
			{ index: 0, command: "sudo rm -rf /", kind: "command" },
			{ index: 1, command: "echo done", kind: "command" },
		],
		{ cwd: "/tmp", exec, allowDangerous: true },
	);
	assert.deepEqual(allowed.map((result) => result.status), ["ok", "ok"]);
	assert.deepEqual(ran, ["sudo rm -rf /", "echo done"]);
});

test("a pi tool call is named as the agent's job, not run as a command", async () => {
	const { exec, ran } = fakeExec(() => ({ code: 0 }));
	const steps = [
		{ index: 0, command: "mkdir out", kind: "command" as const },
		{ index: 1, command: "write out/app.py", kind: "write" as const },
		{ index: 2, command: "python out/app.py", kind: "command" as const },
	];

	const stopped = await executeSteps(steps, { cwd: "/tmp", exec });
	assert.deepEqual(stopped.map((result) => result.status), ["ok", "agent", "skipped"]);
	assert.match(stopped[1]?.reason ?? "", /pi tool call/);
	assert.deepEqual(ran, ["mkdir out"], "pi-tape has no write tool and must not pretend");

	const second = fakeExec(() => ({ code: 0 }));
	const steppedOver = await executeSteps(steps, { cwd: "/tmp", exec: second.exec, commandsOnly: true });
	assert.deepEqual(steppedOver.map((result) => result.status), ["ok", "skipped", "ok"]);
	assert.deepEqual(second.ran, ["mkdir out", "python out/app.py"]);
});

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

test("postconditions are checked, and the uncheckable ones say so", () => {
	const files = new Set(["/tmp/work/src/main.py"]);
	const dirs = new Set(["/tmp/work/src"]);

	const checks = verifyConditions(
		[
			{ kind: "file", target: "src/main.py" },
			{ kind: "dir", target: "src" },
			{ kind: "file", target: "missing.txt" },
			{ kind: "dir", target: "src/main.py" },
			{ kind: "dependency", target: "fastapi" },
			{ kind: "image", target: "api:latest" },
			{ kind: "command", target: "docker" },
			{ kind: "file", target: "{{name}}/x" },
		],
		{
			cwd: "/tmp/work",
			exists: (path) => files.has(path) || dirs.has(path),
			isDirectory: (path) => dirs.has(path),
		},
	);

	assert.deepEqual(
		checks.map((check) => check.status),
		["met", "met", "unmet", "unmet", "unverifiable", "unverifiable", "unverifiable", "unverifiable"],
	);
	assert.match(checks[3]?.detail ?? "", /not a directory/);
	assert.match(checks[7]?.detail ?? "", /never filled/);
});

// ---------------------------------------------------------------------------
// the whole plan
// ---------------------------------------------------------------------------

test("a plan binds, probes and marks what belongs to the agent", async () => {
	const dockerfile = learned([dockerfileFamily()[0] as TapeFile], "dockerfile");
	const containerise = learned([containeriseFamily()[0] as TapeFile], "containerise");
	const deploy = learned([deployFamily()[0] as TapeFile], "deploy");

	const { exec } = fakeExec((command) => (command.includes("docker") ? { code: 0, stdout: "/usr/bin/docker\n" } : { code: 1 }));
	const plan = await planRecipes([dockerfile, containerise, deploy], { cwd: "/tmp/work", exec });

	assert.deepEqual(
		plan.steps.map((step) => step.command),
		["write Dockerfile", "docker build -t api:latest .", "docker run -p 8080:8080 api:latest"],
	);
	assert.deepEqual(plan.agentSteps, [0]);
	assert.equal(plan.steps[0]?.kind, "write");
	assert.deepEqual(plan.probe.map((item) => `${item.command}:${item.status}`), ["docker:available"]);
	assert.deepEqual(plan.gaps, [], "nothing is open in this chain");
	assert.match(plan.text, /→ agent \(write\)/, "the plan says out loud who has to write the file");
});

test("a plan reports the open gaps with their kinds", async () => {
	const service = learned(serviceFamily(), "service");
	const { exec } = fakeExec((command) => (command.includes("pip") ? { code: 0 } : { code: 1 }));
	const plan = await planRecipes([service], { cwd: "/tmp/work", exec });
	assert.deepEqual(
		plan.gaps.map((gap) => `${gap.name}:${gap.kind}`),
		["package:free", "port:env"],
	);
	assert.equal(plan.steps.length, 4);
});
