/**
 * Rule packs: the core must not know about anybody's toolchain.
 *
 * The request that produced this file was "no system dependencies in there", and
 * the test that matters most is the first one: it reads the engine's own source and
 * fails if an ecosystem name appears in it. A rule pack is knowledge about a tool,
 * not a dependency on it — and the way to keep that true is to make it checkable,
 * not to remember it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { contractsOfSteps, stepConditions } from "../src/contract.ts";
import { BUILTIN_PACKS, describePacks, deriveConditions, packFor, positionals, type RulePack } from "../src/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string): string => readFileSync(join(here, "..", "src", name), "utf8");
const testSource = (name: string): string => readFileSync(join(here, name), "utf8");

/**
 * Source with comments removed.
 *
 * The guard is about *code*: a doc comment may use Docker as an example of what a
 * pack looks like, while a branch that knows what `docker build` is may not. Both
 * would match a plain text search, and a guard that fires on prose is a guard
 * somebody deletes.
 */
function code(name: string): string {
	return (
		source(name)
			// Only a block comment that *starts* its line, because a glob such as
			// `src/**/*.ts` contains `/**/` and a blanked-out glob is a blanked-out
			// guard: the check would pass on code it never read.
			.replace(/^\s*\/\*[\s\S]*?\*\//gm, "")
			.replace(/^\s*\/\/.*$/gm, "")
	);
}

/** Every ecosystem noun that must not appear in the engine. */
const ECOSYSTEM_NOUNS =
	/\b(docker|podman|kubectl|helm|terraform|aws|gcloud|npm|pnpm|yarn|bun|npx|pip|python|cargo|compose)\b/i;

test("the contract engine contains no ecosystem of its own", () => {
	const engine = code("contract.ts");
	const offenders = engine.match(new RegExp(ECOSYSTEM_NOUNS, "gi")) ?? [];
	assert.deepEqual(
		offenders,
		[],
		`contract.ts must not name an ecosystem, found: ${[...new Set(offenders)].join(", ")}. ` +
			`It belongs in a rule pack in rules.ts, where it can be dropped or replaced.`,
	);

	// The modules that use the engine must not smuggle a reading in either.
	for (const name of ["run.ts", "recipe-query.ts", "recipe-types.ts", "segment.ts"]) {
		assert.doesNotMatch(
			code(name),
			/docker build|kubectl apply|npm install/,
			`${name} reads a command line it should not know about`,
		);
	}
});

test("dropping the docker pack drops every docker claim with it", () => {
	const all = contractsOfSteps(["docker build -t api:latest ."]);
	assert.deepEqual(
		all.provides.map((item) => `${item.kind} ${item.target}`),
		["image api:latest"],
	);
	assert.deepEqual(
		all.requires.map((item) => `${item.kind} ${item.target}`),
		["file Dockerfile", "command docker"],
	);

	// With the pack removed, the same line is just an unknown command: still probed,
	// claiming nothing about Dockerfiles or images.
	const withoutDocker = contractsOfSteps(["docker build -t api:latest ."], {
		packs: BUILTIN_PACKS.filter((pack) => pack.name !== "docker"),
	});
	assert.deepEqual(withoutDocker.provides, [], "nothing knows what a build produces any more");
	assert.deepEqual(
		withoutDocker.requires.map((item) => `${item.kind} ${item.target}`),
		["command docker"],
		"an unknown command is still a command, and still worth probing",
	);
});

test("a repository can bring its own pack instead of editing the core", () => {
	// Something the built-ins have never heard of, added from outside.
	const uv: RulePack = {
		name: "uv",
		description: "uv: virtual environments and installs",
		commands: ["uv"],
		derive(segment) {
			const tool = { kind: "command" as const, target: "uv", note: segment.text };
			if (segment.argv[0] === "venv") {
				return { requires: [tool], provides: [{ kind: "dir", target: ".venv", note: segment.text }] };
			}
			if (segment.argv[0] === "add") {
				return {
					requires: [tool],
					provides: [{ kind: "dependency", target: segment.argv[1] as string, note: segment.text }],
				};
			}
			return undefined;
		},
	};

	const options = { packs: [uv, ...BUILTIN_PACKS] };
	const venv = contractsOfSteps(["uv venv"], options);
	assert.deepEqual(
		venv.provides.map((item) => `${item.kind} ${item.target}`),
		["dir .venv"],
	);
	assert.deepEqual(
		contractsOfSteps(["uv add fastapi"], options).provides.map((item) => `${item.kind} ${item.target}`),
		["dependency fastapi"],
		"and the built-ins still work alongside it",
	);
	assert.equal(packFor("uv", options)?.name, "uv");
	assert.equal(packFor("docker", options)?.name, "docker");
	assert.equal(packFor("some-unknown-thing", options)?.name, "generic");
});

test("an unknown command is probed and claims nothing else", () => {
	const derived = deriveConditions({ verb: "claude", argv: ["-p", "hi"], text: "claude -p hi" });
	assert.deepEqual(derived.provides, []);
	assert.deepEqual(
		derived.requires.map((item) => `${item.kind} ${item.target}`),
		["command claude"],
	);

	// Common utilities are not worth asking about; that is the only judgement here.
	const ubiquitous = deriveConditions({ verb: "cd", argv: ["src"], text: "cd src" });
	assert.deepEqual(ubiquitous.requires, []);
	assert.deepEqual(ubiquitous.provides, []);
});

test("a flag that takes a value is the pack's business, not a global setting", () => {
	// `-p` is `--parents` to one tool and `--publish` to another, which is exactly why
	// the value-flag sets live with the packs.
	assert.deepEqual(positionals(["-p", "out", ">", "/dev/null"], new Set()), ["out"]);
	assert.deepEqual(positionals(["-p", "8080:8080", "api:latest"], new Set(["-p"])), ["api:latest"]);

	assert.deepEqual(
		contractsOfSteps(["mkdir -p out"]).provides.map((item) => `${item.kind} ${item.target}`),
		["dir out"],
	);
	assert.deepEqual(
		contractsOfSteps(["docker run -p 8080:8080 api:latest"]).requires.map((item) => `${item.kind} ${item.target}`),
		["image api:latest", "command docker"],
		"the port mapping never becomes an argument",
	);
});

test("describePacks answers what pi-tape assumes, exactly", () => {
	const packs = describePacks();
	assert.deepEqual(packs.map((pack) => pack.name), ["filesystem", "node", "python", "docker", "orchestration", "generic"]);
	assert.ok(packs.every((pack) => pack.description.length > 0));
});

test("stepConditions reads a tool call without a pack knowing the tool", () => {
	// A tool name no pack has ever been told about, written the way a recording
	// writes it: the identity of the step is enough.
	assert.deepEqual(
		stepConditions("write src/main.ts").provides.map((item) => `${item.kind} ${item.target}`),
		["file src/main.ts"],
	);
	assert.deepEqual(
		stepConditions("read src/main.ts").requires.map((item) => `${item.kind} ${item.target}`),
		["file src/main.ts"],
	);
});

test("no test reaches for the real shell", () => {
	// The probes and the execution paths take an injected executor, which is why the
	// suite can assert what `run` would do without a toolchain being present. A test
	// that used `shellExecutor` would be the first system dependency in here, and it
	// would make the suite pass or fail depending on what is installed.
	// This file is left out because it names the thing it is guarding against, which
	// is exactly how a self-check like this trips over itself.
	const files = ["run.test.ts", "pipeline.test.ts", "segment.test.ts", "recipes.test.ts", "recipes-store.test.ts"];
	for (const file of files) {
		assert.doesNotMatch(testSource(file), /shellExecutor/, `${file} must inject an executor, not use the real one`);
	}
	assert.match(testSource("run.test.ts"), /fakeExec/, "and it does use a fake shell");
});
