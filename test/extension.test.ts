/**
 * End-to-end test of the pi extension's logic.
 *
 * It loads the real extension factory and drives it with a fake `pi` and a fake
 * extension context. That exercises the actual replay provider and tool override
 * code paths without starting an agent.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import tape from "../extension/index.ts";
import { recordSession } from "../src/record.ts";
import { parseSession, pathToLeaf } from "../src/session.ts";
import { readTape } from "../src/tape.ts";
import { buildFixture } from "./fixtures.ts";

interface Captured {
	commands: Map<string, (args: string, ctx: unknown) => Promise<void> | void>;
	tools: Map<string, Record<string, unknown>>;
	providers: Map<string, Record<string, unknown>>;
	statuses: Array<[string, string | undefined]>;
	notices: string[];
	unregistered: string[];
}

function fakePi() {
	const captured: Captured = {
		commands: new Map(),
		tools: new Map(),
		providers: new Map(),
		statuses: [],
		notices: [],
		unregistered: [],
	};

	const pi = {
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> | void }) {
			captured.commands.set(name, options.handler);
		},
		registerTool(definition: Record<string, unknown>) {
			captured.tools.set(String(definition.name), definition);
		},
		registerProvider(name: string, config: Record<string, unknown>) {
			captured.providers.set(name, config);
		},
		unregisterProvider(name: string) {
			captured.unregistered.push(name);
			captured.providers.delete(name);
		},
		on() {
			return () => {};
		},
		registerEntryRenderer() {},
		registerToolRenderer() {},
	};

	return { pi, captured };
}

function fakeCtx(cwd: string, branch: unknown[], sessionFile?: string) {
	return {
		cwd,
		mode: "tui" as const,
		hasUI: true,
		ui: {
			notify(message: string) {
				capturedNotices.push(message);
			},
			setStatus(key: string, value: string | undefined) {
				capturedStatuses.push([key, value]);
			},
		},
		sessionManager: {
			getBranch: () => branch,
			getSessionFile: () => sessionFile,
			getSessionId: () => "test-session-0001",
		},
	};
}

let capturedNotices: string[] = [];
let capturedStatuses: Array<[string, string | undefined]> = [];

/**
 * The extension keeps its armed state at module scope, so a test that arms a
 * replay must disarm it again or every later test sees "already armed".
 */
let activeHandler: ((args: string, ctx: unknown) => Promise<void> | void) | undefined;

afterEach(async () => {
	if (activeHandler) {
		try {
			await activeHandler("stop", fakeCtx(process.cwd(), []));
		} catch {
			// Nothing to disarm.
		}
	}
	activeHandler = undefined;
});

function prepare(): { captured: Captured; dir: string } {
	capturedNotices = [];
	capturedStatuses = [];
	const { pi, captured } = fakePi();
	tape(pi as never);
	activeHandler = captured.commands.get("tape");
	const dir = mkdtempSync(join(tmpdir(), "tape-"));
	return { captured, dir };
}

/** The messages a provider would receive for the prefix ending before `a1`. */
function prefixMessagesForFirstAssistant() {
	const session = parseSession(buildFixture().text);
	const path = pathToLeaf(session, "a0008");
	return path.slice(0, 2).map((entry) => (entry.message as Record<string, unknown>) ?? {});
}

test("the extension registers the /tape command and shows help by default", async () => {
	const { captured, dir } = prepare();
	try {
		assert.equal(captured.commands.has("tape"), true);

		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("", fakeCtx(dir, []));

		assert.match(capturedNotices.join("\n"), /tape/);
		assert.match(capturedNotices.join("\n"), /\/tape record/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("capture writes a readable tape next to the working directory", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record my run", fakeCtx(dir, session.entries));

		const files = readdirSync(dir).filter((name) => name.endsWith(".tape"));
		assert.deepEqual(files, ["my-run.tape"]);

		const tape = readTape(join(dir, "my-run.tape"));
		assert.equal(tape.name, "my run");
		assert.equal(tape.stats.assistantMessages, 2);
		assert.match(capturedNotices.join("\n"), /tape recorded/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("load arms a provider and overrides exactly the recorded tools", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const capture = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await capture("record armed", fakeCtx(dir, session.entries));

		const load = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await load("play armed.tape", fakeCtx(dir, session.entries));

		assert.equal(captured.providers.has("tape"), true);
		const provider = captured.providers.get("tape") as Record<string, unknown>;
		assert.equal(provider.api, "tape-replay");
		assert.equal(typeof provider.streamSimple, "function");

		// Only tools that appear in the recording are replaced. The recipe tools are
		// registered separately and are not overrides of recorded tools.
		const replayOverrides = [...captured.tools.keys()].filter((name) => !name.startsWith("tape_"));
		assert.deepEqual(replayOverrides, ["read"]);

		const notice = capturedNotices.join("\n");
		assert.match(notice, /tape armed/);
		assert.match(notice, /\/model tape\/test-model/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the replay provider serves the recorded assistant message with zero cost", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record replay-me", fakeCtx(dir, session.entries));
		await handler("play replay-me.tape", fakeCtx(dir, session.entries));

		const provider = captured.providers.get("tape") as Record<string, unknown>;
		const streamSimple = provider.streamSimple as (
			model: unknown,
			context: unknown,
			options?: unknown,
		) => AsyncIterable<Record<string, unknown>> & { result(): Promise<Record<string, unknown>> };

		const stream = streamSimple(
			{ api: "tape-replay", provider: "tape", id: "test-model" },
			{ messages: prefixMessagesForFirstAssistant() },
			undefined,
		);

		const events: Array<Record<string, unknown>> = [];
		for await (const event of stream) events.push(event);

		const kinds = events.map((event) => event.type);
		assert.equal(kinds[0], "start", "a stream must begin with start");
		assert.equal(kinds.at(-1), "done", "a stream must end with done");
		assert.ok(kinds.includes("toolcall_end"), `expected a tool call event, got ${kinds.join(",")}`);

		const final = await stream.result();
		const content = final.content as Array<Record<string, unknown>>;
		const call = content.find((block) => block.type === "toolCall");
		assert.ok(call, "the recorded tool call is reproduced");
		assert.equal(call?.name, "read");
		assert.deepEqual(call?.arguments, { path: "a.txt" });

		const usage = final.usage as { cost: { total: number }; totalTokens: number };
		assert.equal(usage.cost.total, 0, "a replay never claims to have cost money");
		assert.ok(usage.totalTokens > 0, "but it keeps the recorded token counts");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the overridden tool returns the recorded result for its tool call id", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record tools", fakeCtx(dir, session.entries));
		await handler("play tools.tape", fakeCtx(dir, session.entries));

		const tool = captured.tools.get("read") as { execute: (id: string) => Promise<Record<string, unknown>> };
		const result = await tool.execute("call_a0003");

		const content = result.content as Array<Record<string, unknown>>;
		assert.equal(content[0]?.text, "alpha");
		assert.notEqual(result.isError, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unknown tool call id fails loudly instead of inventing a result", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record miss", fakeCtx(dir, session.entries));
		await handler("play miss.tape", fakeCtx(dir, session.entries));

		const tool = captured.tools.get("read") as { execute: (id: string) => Promise<Record<string, unknown>> };
		const result = await tool.execute("call_never_recorded");

		assert.equal(result.isError, true);
		assert.match(String((result.content as Array<Record<string, unknown>>)[0]?.text), /no recorded result/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a replay that runs past its recording emits an error event", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record short", fakeCtx(dir, session.entries));
		await handler("play short.tape", fakeCtx(dir, session.entries));

		const provider = captured.providers.get("tape") as Record<string, unknown>;
		const streamSimple = provider.streamSimple as (model: unknown, context: unknown) => AsyncIterable<unknown>;

		// Exhaust the two recorded assistant answers.
		for (let i = 0; i < 2; i++) {
			const stream = streamSimple({ api: "a", provider: "p", id: "m" }, { messages: prefixMessagesForFirstAssistant() });
			for await (const _event of stream) void _event;
		}

		const events: Array<Record<string, unknown>> = [];
		const stream = streamSimple({ api: "a", provider: "p", id: "m" }, { messages: prefixMessagesForFirstAssistant() });
		for await (const event of stream) events.push(event as Record<string, unknown>);

		assert.equal(events.at(-1)?.type, "error");
		assert.match(String(events.at(-1)?.error && (events.at(-1)?.error as Record<string, unknown>).errorMessage), /left the recording/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("status reports progress, and off disarms the provider", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record lifecycle", fakeCtx(dir, session.entries));
		await handler("play lifecycle.tape", fakeCtx(dir, session.entries));

		await handler("status", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /assistant {2}0\/2 served/);

		// Consume one answer and check the counter moves.
		const provider = captured.providers.get("tape") as Record<string, unknown>;
		const streamSimple = provider.streamSimple as (model: unknown, context: unknown) => AsyncIterable<unknown>;
		for await (const _event of streamSimple({ api: "a", provider: "p", id: "m" }, { messages: prefixMessagesForFirstAssistant() })) {
			void _event;
		}

		capturedNotices = [];
		await handler("status", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /assistant {2}1\/2 served/);

		await handler("stop", fakeCtx(dir, session.entries));
		assert.deepEqual(captured.unregistered, ["tape"]);
		assert.equal(captured.providers.has("tape"), false);

		// The tool override now refuses rather than silently running for real.
		const tool = captured.tools.get("read") as { execute: (id: string) => Promise<Record<string, unknown>> };
		const result = await tool.execute("call_a0003");
		assert.equal(result.isError, true);
		assert.match(String((result.content as Array<Record<string, unknown>>)[0]?.text), /disarmed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("load rejects a file that is not a tape", async () => {
	const { captured, dir } = prepare();
	try {
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("play does-not-exist.tape", fakeCtx(dir, []));
		assert.match(capturedNotices.join("\n"), /Could not load/);
		assert.equal(captured.providers.has("tape"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
