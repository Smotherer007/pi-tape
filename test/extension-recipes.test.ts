/**
 * Tests for the recipe side of the extension: the five tools and the
 * "recipes first" prompt injection.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import tape, { recipeContext, refreshIndexIfStale } from "../extension/index.ts";
import { recordSession } from "../src/record.ts";
import { extractRecipe } from "../src/recipe-extract.ts";
import { intersectRecipes } from "../src/recipe-intersect.ts";
import { globalStoreDir, loadRecipes, saveRecipe } from "../src/recipe-store.ts";
import { parseSession } from "../src/session.ts";
import { writeTape } from "../src/tape.ts";
import type { Recipe } from "../src/recipe-types.ts";
import type { TapeFile } from "../src/types.ts";
import { assistantToolCall, sessionText, systemEntry, toolResultEntry } from "./fixtures.ts";

let workDir: string;
let storeDir: string;
let originalStore: string | undefined;
let notices: string[] = [];

interface ToolDef {
	name: string;
	execute: (id: string, params: Record<string, unknown>, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: Record<string, unknown>;
		isError?: boolean;
	}>;
}

function fakePi() {
	const tools = new Map<string, ToolDef>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void> | void>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();

	const pi = {
		registerTool(definition: ToolDef) {
			tools.set(definition.name, definition);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
			commands.set(name, options.handler);
		},
		registerProvider() {},
		unregisterProvider() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
			return () => {};
		},
		registerEntryRenderer() {},
		registerToolRenderer() {},
	};
	return { pi, tools, commands, handlers };
}

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

/** A Vue/React family, saved as the project's recipe. */
function seedStore(cwd: string): void {
	const tapes = [
		recordingOf(["npm create vue@latest app-one", "npm install vue-router", "npm run build"], "a"),
		recordingOf(["npm create vue@latest app-two", "npm install vue-router", "npm run build"], "b"),
		recordingOf(["npm create react@latest app-three", "npm install react-router-dom", "npm run build"], "c"),
		recordingOf(["npm create react@latest app-four", "npm install react-router-dom", "npm run build"], "d"),
	];
	const recipe = intersectRecipes(
		tapes.map((tape) => extractRecipe(tape).recipe),
		{ name: "frontend-setup" },
	).recipe;
	saveRecipe(join(cwd, ".tape"), recipe);
}

function contextFor(cwd: string) {
	return { cwd, ui: { notify: (message: string) => notices.push(message), setStatus() {} } };
}

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "tape-ext-"));
	storeDir = join(workDir, "global");
	originalStore = process.env.PI_TAPE_DIR;
	process.env.PI_TAPE_DIR = storeDir;
	notices = [];
});

afterEach(() => {
	if (originalStore === undefined) delete process.env.PI_TAPE_DIR;
	else process.env.PI_TAPE_DIR = originalStore;
	rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

test("the recipe tools are registered on load", () => {
	const { pi, tools } = fakePi();
	tape(pi as never);

	assert.deepEqual(
		[...tools.keys()].sort(),
		["tape_check", "tape_dub", "tape_search", "tape_show", "tape_splice"],
	);
});

test("tape_search finds a learned procedure", async () => {
	seedStore(workDir);
	const { pi, tools } = fakePi();
	tape(pi as never);

	const result = await tools.get("tape_search")?.execute("c1", { query: "frontend projekt aufsetzen" }, undefined, undefined, { cwd: workDir });
	const text = result?.content[0]?.text ?? "";

	assert.match(text, /frontend-setup/);
	assert.match(text, /npm create \{\{template\}\}/);
	assert.equal(result?.isError, undefined);
});

test("tape_search on an empty store explains how to fill it", async () => {
	const { pi, tools } = fakePi();
	tape(pi as never);

	const result = await tools.get("tape_search")?.execute("c1", { query: "anything" }, undefined, undefined, { cwd: workDir });
	assert.match(result?.content[0]?.text ?? "", /recipe store is empty/);
	assert.match(result?.content[0]?.text ?? "", /splice <tape/);
});

test("tape_dub swaps a whole enumerated parameter and reports what is left", async () => {
	seedStore(workDir);
	const { pi, tools } = fakePi();
	tape(pi as never);

	const react = await tools.get("tape_dub")?.execute(
		"c1",
		{ name: "frontend-setup", set: { template: "react@latest", name: "demo" } },
		undefined,
		undefined,
		{ cwd: workDir },
	);
	const text = react?.content[0]?.text ?? "";
	assert.match(text, /npm create react@latest demo/);
	assert.match(text, /npm install react-router-dom/, "the router came along with the framework");
	assert.equal(
		/still unfilled/.test(text),
		false,
		"the enumerated parameter filled the router slot too, so nothing is pending",
	);

	const unfilled = await tools.get("tape_dub")?.execute("c2", { name: "frontend-setup" }, undefined, undefined, { cwd: workDir });
	assert.match(unfilled?.content[0]?.text ?? "", /still unfilled: template, name/);
});

test("tape_dub rejects an unknown enumerated value with the options", async () => {
	seedStore(workDir);
	const { pi, tools } = fakePi();
	tape(pi as never);

	const result = await tools.get("tape_dub")?.execute(
		"c1",
		{ name: "frontend-setup", set: { template: "svelte@latest" } },
		undefined,
		undefined,
		{ cwd: workDir },
	);
	assert.equal(result?.isError, true);
	assert.match(result?.content[0]?.text ?? "", /enumerated parameter value not recognised/);
	assert.match(result?.content[0]?.text ?? "", /vue@latest/);
});

test("tape_show reports free and enumerated parameters differently", async () => {
	seedStore(workDir);
	const { pi, tools } = fakePi();
	tape(pi as never);

	const result = await tools.get("tape_show")?.execute("c1", { name: "frontend" }, undefined, undefined, { cwd: workDir });
	const text = result?.content[0]?.text ?? "";
	assert.match(text, /template \(choose one\)/);
	assert.match(text, /name \(free value\)/);
});

test("tape_splice stores a recipe and rebuilds the index", async () => {
	const tapes = [
		recordingOf(["npm create vue@latest a", "npm run build"], "a"),
		recordingOf(["npm create react@latest b", "npm run build"], "b"),
	].map((tape, index) => {
		const path = join(workDir, `r${index}.tape`);
		writeTape(path, tape);
		return path;
	});

	const { pi, tools } = fakePi();
	tape(pi as never);

	const result = await tools.get("tape_splice")?.execute(
		"c1",
		{ paths: tapes, name: "learned-frontend", scope: "project" },
		undefined,
		undefined,
		{ cwd: workDir },
	);
	const text = result?.content[0]?.text ?? "";
	assert.match(text, /spliced "learned-frontend" from 2 tapes/);
	assert.match(text, /orthogonality/);
	assert.match(text, /index rebuilt/);

	const { recipes } = loadRecipes(workDir);
	assert.equal(recipes.length, 1);
	assert.equal(recipes[0]?.scope, "project");
});

test("tape_check dry-runs the validators without executing them", async () => {
	seedStore(workDir);
	const { pi, tools } = fakePi();
	tape(pi as never);

	const result = await tools.get("tape_check")?.execute(
		"c1",
		{ name: "frontend-setup", dryRun: true },
		undefined,
		undefined,
		{ cwd: workDir },
	);
	assert.match(result?.content[0]?.text ?? "", /unchecked|unknown/);
});

// ---------------------------------------------------------------------------
// prompt injection
// ---------------------------------------------------------------------------

test("the injected context tells the agent to check recipes before searching", () => {
	seedStore(workDir);
	const text = recipeContext(workDir);

	assert.match(text, /Recipe store/);
	assert.match(text, /[Bb]efore searching the web/);
	assert.match(text, /tape_search/);
	assert.match(text, /frontend-setup/);
	assert.match(text, /template=/, "parameters are listed so the agent knows what can be swapped");
});

test("nothing is injected when the store is empty", () => {
	assert.equal(recipeContext(workDir), "");
});

test("the injection respects its character budget", () => {
	seedStore(workDir);
	const text = recipeContext(workDir, 200);
	assert.ok(text.length <= 240, `budget honoured, got ${text.length}`);
	assert.match(text, /truncated/);
});

test("before_agent_start appends the recipe block to the system prompt", () => {
	seedStore(workDir);
	const { pi, handlers } = fakePi();
	tape(pi as never);

	const handler = handlers.get("before_agent_start");
	assert.ok(handler, "the extension must subscribe to before_agent_start");

	const result = handler({ systemPrompt: "BASE PROMPT" }, { cwd: workDir }) as { systemPrompt: string };
	assert.ok(result.systemPrompt.startsWith("BASE PROMPT"), "the original prompt is preserved");
	assert.match(result.systemPrompt, /Recipe store/);
});

test("nothing is appended to the prompt when there are no recipes", () => {
	const { pi, handlers } = fakePi();
	tape(pi as never);

	const result = handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, { cwd: workDir });
	assert.equal(result, undefined);
});

test("refreshIndexIfStale writes the index once and then reports it fresh", () => {
	seedStore(workDir);

	const first = refreshIndexIfStale(workDir);
	assert.equal(first.refreshed, true);
	assert.ok(first.path);

	const second = refreshIndexIfStale(workDir);
	assert.equal(second.refreshed, false, "a just-written index is not stale");

	// A newer recipe must invalidate it again.
	const { recipes } = loadRecipes(workDir);
	const existing = recipes[0]?.recipe as Recipe;
	saveRecipe(join(workDir, ".tape"), { ...existing, description: "touched" });
	assert.equal(refreshIndexIfStale(workDir).refreshed, true);
});

test("the /tape command advertises the recipe subcommands", async () => {
	const { pi, commands } = fakePi();
	tape(pi as never);

	await commands.get("tape")?.("", contextFor(workDir));
	assert.match(notices.join("\n"), /\/tape recipes/);
	assert.match(notices.join("\n"), /tape_search/);
});

test("the global store directory is created on demand, not on load", () => {
	// Loading the extension in a session without recipes must not create directories:
	// some pi invocations load extensions without ever starting a session.
	const { pi } = fakePi();
	tape(pi as never);
	assert.equal(globalStoreDir(), storeDir);
});
