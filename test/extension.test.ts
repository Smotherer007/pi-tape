/**
 * End-to-end test of the pi extension's logic.
 *
 * It loads the real extension factory and drives it with a fake `pi` and a fake
 * extension context. That exercises the actual replay provider and tool override
 * code paths without starting an agent.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import tape from "../extensions/index.ts";
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
		modelRegistry: fakeRegistry,
	};
}

let capturedNotices: string[] = [];
let capturedStatuses: Array<[string, string | undefined]> = [];

/**
 * The model registry a fork or shadow run reaches for. `undefined` by default,
 * which is the honest state for a plain replay: it never asks a model.
 */
let fakeRegistry: unknown;

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
	fakeRegistry = undefined;
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

// ---------------------------------------------------------------------------
// Fork: asking a model a request the recording does not contain
// ---------------------------------------------------------------------------

/** A registry whose one model answers with a fixed text, reporting real tokens. */
function fakeLiveModel(answer: string) {
	return {
		find: (provider: string, modelId: string) => ({ provider, modelId }),
		streamSimple: () => {
			const final = {
				role: "assistant",
				content: [{ type: "text", text: answer }],
				api: "live",
				provider: "live",
				model: "model-x",
				usage: {
					input: 3,
					output: 4,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 7,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			return (async function* () {
				yield { type: "start", partial: { ...final, content: [], stopReason: "pending" } };
				yield { type: "done", reason: "stop", message: final };
			})();
		},
	};
}

function streamOf(captured: Captured) {
	const provider = captured.providers.get("tape") as Record<string, unknown>;
	return provider.streamSimple as (
		model: unknown,
		context: unknown,
	) => AsyncIterable<Record<string, unknown>> & { result(): Promise<Record<string, unknown>> };
}

test("fork mode asks the live model where the recording ends instead of serving the next event", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record forked", fakeCtx(dir, session.entries));

		fakeRegistry = fakeLiveModel("a genuinely live answer");
		// The `--model=x/y` spelling is accepted too, and must not leak into the file name.
		await handler("fork forked.tape --model=live/model-x", fakeCtx(dir, session.entries));

		const stream = streamOf(captured)(
			{ api: "tape-replay", provider: "tape", id: "test-model" },
			{ messages: [{ role: "user", content: [{ type: "text", text: "a prompt the recording never saw" }] }] },
		);
		for await (const _event of stream) void _event;

		const final = await stream.result();
		const content = final.content as Array<Record<string, unknown>>;
		assert.equal(
			content[0]?.text,
			"a genuinely live answer",
			"a new context must be asked of the model, not answered with the old recording",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fork mode still serves the recorded prefix, for free", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record forked", fakeCtx(dir, session.entries));

		fakeRegistry = fakeLiveModel("should not be reached");
		await handler("fork forked.tape --model live/model-x", fakeCtx(dir, session.entries));

		const stream = streamOf(captured)(
			{ api: "tape-replay", provider: "tape", id: "test-model" },
			{ messages: prefixMessagesForFirstAssistant() },
		);
		for await (const _event of stream) void _event;

		const final = await stream.result();
		const content = final.content as Array<Record<string, unknown>>;
		assert.equal(content[0]?.type, "toolCall", "the recorded turn comes from the tape");
		assert.equal((final.usage as { cost: { total: number } }).cost.total, 0, "the recorded part costs nothing");

		capturedNotices = [];
		await handler("status", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /fork {7}0 request\(s\) the recording lacked/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fork tool call the recording does not cover stops with an explanation", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record forked", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live");
		await handler("fork forked.tape --model live/model-x", fakeCtx(dir, session.entries));

		const tool = captured.tools.get("read") as { execute: (id: string) => Promise<Record<string, unknown>> };
		const result = await tool.execute("call_from_the_live_branch");

		assert.equal(result.isError, true);
		assert.match(String((result.content as Array<Record<string, unknown>>)[0]?.text), /fork went live/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fork without a usable --model prints usage instead of arming", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record forked", fakeCtx(dir, session.entries));
		capturedNotices = [];

		fakeRegistry = fakeLiveModel("live");
		await handler("fork forked.tape --model notamodel", fakeCtx(dir, session.entries));

		assert.match(capturedNotices.join("\n"), /Usage: \/tape fork/);
		assert.equal(captured.providers.has("tape"), false, "half a model name must not arm a fork");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a multi-word --result stays a result and out of the file name", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record multiword", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live");
		capturedNotices = [];

		await handler(
			"fork multiword.tape --model live/model-x --at 1 --result PAYLOAD: 42 golden widgets",
			fakeCtx(dir, session.entries),
		);

		// It armed, so the words were treated as the value and not as a file path.
		assert.equal(captured.providers.has("tape"), true);
		assert.match(capturedNotices.join("\n"), /intervention {2}read turn 1 \(call_a0003\) → "PAYLOAD: 42 golden widgets"/);

		const tool = captured.tools.get("read") as {
			execute: (id: string, params?: unknown) => Promise<Record<string, unknown>>;
		};
		const result = await tool.execute("call_a0003", { path: "a.txt" });
		assert.equal(
			(result.content as Array<Record<string, unknown>>)[0]?.text,
			"PAYLOAD: 42 golden widgets",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fork budget that is not a number is refused, not guessed", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record forked", fakeCtx(dir, session.entries));
		capturedNotices = [];

		fakeRegistry = fakeLiveModel("live");
		await handler("fork forked.tape --model live/model-x --max-live-tokens lots", fakeCtx(dir, session.entries));

		assert.match(capturedNotices.join("\n"), /--max-live-tokens expects a number/);
		assert.equal(captured.providers.has("tape"), false, "an unreadable budget must not arm a fork");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a divergent first prompt is not treated as a hash mismatch", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record plainfork", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live answer");
		await handler("fork plainfork.tape --model live/model-x", fakeCtx(dir, session.entries));
		capturedNotices = [];

		const stream = streamOf(captured)(
			{ api: "tape-replay", provider: "tape", id: "test-model" },
			{ messages: [{ role: "user", content: [{ type: "text", text: "a different prompt" }] }] },
		);
		for await (const _event of stream) void _event;

		assert.doesNotMatch(
			capturedNotices.join("\n"),
			/first request is not in the recording/,
			"sending a different first prompt is how a fork is meant to start",
		);

		// It is still visible in the report, just not as an alarm.
		capturedNotices = [];
		await handler("status", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /diverged at the first request/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("recording a session that ran as a fork links it to the tape it came from", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record origin", fakeCtx(dir, session.entries));
		const origin = readTape(join(dir, "origin.tape"));

		fakeRegistry = fakeLiveModel("live");
		await handler("fork origin.tape --model live/model-x --at 1 --result REPLACED", fakeCtx(dir, session.entries));
		await handler("record forked", fakeCtx(dir, session.entries));

		const forked = readTape(join(dir, "forked.tape"));
		assert.equal(forked.parent?.tapeId, origin.id, "the fork names the recording it was replayed from");
		assert.deepEqual(forked.parent?.forkPoint, {
			toolCallId: "call_a0003",
			toolName: "read",
			turn: 1,
			replacement: "REPLACED",
		});
		assert.equal(forked.parent?.liveRequests, 0, "nothing went live in this run");

		// And a recording taken outside a fork stays clean.
		await handler("stop", fakeCtx(dir, session.entries));
		await handler("record plain-again", fakeCtx(dir, session.entries));
		assert.equal(readTape(join(dir, "plain-again.tape")).parent, undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Intervention, reconnect and live tools
// ---------------------------------------------------------------------------

test("--at and --result replace what a recorded tool call returned", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record intervened", fakeCtx(dir, session.entries));

		fakeRegistry = fakeLiveModel("live");
		await handler("fork intervened.tape --model live/model-x --at 1 --result REPLACED", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /intervention {2}read turn 1 \(call_a0003\)/);

		const tool = captured.tools.get("read") as {
			execute: (id: string, params?: unknown) => Promise<Record<string, unknown>>;
		};
		const result = await tool.execute("call_a0003", { path: "a.txt" });

		assert.equal((result.content as Array<Record<string, unknown>>)[0]?.text, "REPLACED");
		assert.equal((result.details as Record<string, unknown>).tape, "override");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--at by id works too, and a target that does not exist is refused", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record intervened", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live");
		capturedNotices = [];

		await handler("fork intervened.tape --model live/model-x --at call_nope --result x", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /no recorded tool call matches --at call_nope/);
		assert.equal(captured.providers.has("tape"), false, "a bad target must not arm a run");

		capturedNotices = [];
		await handler("fork intervened.tape --model live/model-x --at 1", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /--at needs a --result/);
		assert.equal(captured.providers.has("tape"), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a live branch that repeats a recorded call gets the recorded result", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record reconnected", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live");
		await handler("fork reconnected.tape --model live/model-x", fakeCtx(dir, session.entries));

		const tool = captured.tools.get("read") as {
			execute: (id: string, params?: unknown) => Promise<Record<string, unknown>>;
		};

		// A new id, the same call: this is what a live branch produces, and without the
		// reconnect it would stop the run here.
		const reconnected = await tool.execute("call_from_the_live_branch", { path: "a.txt" });
		assert.equal((reconnected.content as Array<Record<string, unknown>>)[0]?.text, "alpha");
		assert.notEqual(reconnected.isError, true);
		assert.equal((reconnected.details as Record<string, unknown>).tape, "reconnected", "a borrowed answer says so");
		assert.equal((reconnected.details as Record<string, unknown>).from, "call_a0003");

		// A genuinely different request still stops, and says how to allow it.
		const other = await tool.execute("call_something_new", { path: "other.txt" });
		assert.equal(other.isError, true);
		assert.match(String((other.content as Array<Record<string, unknown>>)[0]?.text), /--live-tools read/);

		capturedNotices = [];
		await handler("status", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /1 live call\(s\) reconnected/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a plain replay never reconnects, because nothing has diverged", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record plain", fakeCtx(dir, session.entries));
		await handler("play plain.tape", fakeCtx(dir, session.entries));

		const tool = captured.tools.get("read") as {
			execute: (id: string, params?: unknown) => Promise<Record<string, unknown>>;
		};
		const result = await tool.execute("call_from_nowhere", { path: "a.txt" });

		assert.equal(result.isError, true, "a replay is not allowed to invent a match");
		assert.match(String((result.content as Array<Record<string, unknown>>)[0]?.text), /no recorded result/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("--live-tools serves the recorded prefix and runs only the branch's own calls for real", async () => {
	const { captured, dir } = prepare();
	try {
		writeFileSync(join(dir, "a.txt"), "the file as it is on disk now\n");
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record live", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live");
		await handler("fork live.tape --model live/model-x --live-tools read,write", fakeCtx(dir, session.entries));

		assert.match(capturedNotices.join("\n"), /live tools {4}read, write run for real where the recording has no answer/);
		const tool = captured.tools.get("read") as {
			execute: (id: string, params?: unknown) => Promise<Record<string, unknown>>;
		};
		assert.ok(tool, "a live tool is still overridden, so its recorded calls can be served");

		// The recorded call: served from the tape, the real tool does not run again.
		const recorded = await tool.execute("call_a0003", { path: "a.txt" });
		assert.equal((recorded.content as Array<Record<string, unknown>>)[0]?.text, "alpha");

		// The branch's own call: the real implementation, in the session's directory.
		const live = await tool.execute("call_from_the_live_branch", { path: "a.txt" });
		assert.match(String((live.content as Array<Record<string, unknown>>)[0]?.text), /as it is on disk now/);

		capturedNotices = [];
		await handler("status", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /1 live tool call\(s\) run for real/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fork covers declared tools too, so an unrecorded built-in cannot run unasked", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record declared", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live");
		await handler("fork declared.tape --model live/model-x", fakeCtx(dir, session.entries));

		// `write` is declared by the recording but never called in it.
		const write = captured.tools.get("write") as {
			execute: (id: string, params?: unknown) => Promise<Record<string, unknown>>;
		};
		assert.ok(write, "a declared tool is overridden in a fork");
		const result = await write.execute("call_from_the_live_branch", { path: "b.txt", content: "x" });
		assert.equal(result.isError, true);
		assert.equal(existsSync(join(dir, "b.txt")), false, "nothing was written");
		assert.match(String((result.content as Array<Record<string, unknown>>)[0]?.text), /--live-tools write/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("once a live tool has changed things, nothing reconnects to the recording", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record mutated", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live");
		await handler("fork mutated.tape --model live/model-x --live-tools write", fakeCtx(dir, session.entries));

		const write = captured.tools.get("write") as {
			execute: (id: string, params?: unknown) => Promise<Record<string, unknown>>;
		};
		const read = captured.tools.get("read") as {
			execute: (id: string, params?: unknown) => Promise<Record<string, unknown>>;
		};

		const written = await write.execute("call_live_write", { path: "a.txt", content: "changed by the branch" });
		assert.notEqual(written.isError, true);
		assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "changed by the branch");

		// The recording says a.txt is "alpha"; this branch just made it something else.
		const reread = await read.execute("call_live_read", { path: "a.txt" });
		assert.equal(reread.isError, true, "a stale recorded answer must not be served");
		assert.match(String((reread.content as Array<Record<string, unknown>>)[0]?.text), /changed things in this branch/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a live tool that is not a pi built-in is left alone, and the notice says what that costs", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record external", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live");
		await handler("fork external.tape --model live/model-x --live-tools mcp_search", fakeCtx(dir, session.entries));

		assert.equal(captured.tools.has("mcp_search"), false);
		assert.match(capturedNotices.join("\n"), /not built-in mcp_search/);
		assert.match(capturedNotices.join("\n"), /RECORDED calls run again/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fork has no live budget unless one is asked for", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record unbudgeted", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live answer");
		await handler("fork unbudgeted.tape --model live/model-x", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /no live budget/);

		const stream = streamOf(captured)(
			{ api: "tape-replay", provider: "tape", id: "test-model" },
			{ messages: [{ role: "user", content: [{ type: "text", text: "a diverging prompt" }] }] },
		);
		for await (const _event of stream) void _event;
		const final = await stream.result();
		assert.equal((final.content as Array<Record<string, unknown>>)[0]?.text, "live answer");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an explicit budget is announced, and a spent one stops the next request", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record budgeted", fakeCtx(dir, session.entries));

		fakeRegistry = fakeLiveModel("live answer");
		await handler("fork budgeted.tape --model live/model-x --max-live-tokens 0", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /budget 0 live tokens/, "the arm notice says what may be spent");

		const stream = streamOf(captured)(
			{ api: "tape-replay", provider: "tape", id: "test-model" },
			{ messages: [{ role: "user", content: [{ type: "text", text: "a diverging prompt" }] }] },
		);
		const events: Array<Record<string, unknown>> = [];
		for await (const event of stream) events.push(event);

		const last = events.at(-1) as { type: string; error: { errorMessage: string } };
		assert.equal(last.type, "error", "a spent budget is an error, not a silent live call");
		assert.match(last.error.errorMessage, /live-token budget \(0 of 0 tokens\)/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a miss before the intervention stops the fork without asking the model", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record early", fakeCtx(dir, session.entries));

		let liveCalls = 0;
		const live = fakeLiveModel("must not be asked");
		fakeRegistry = {
			...live,
			streamSimple: () => {
				liveCalls += 1;
				return live.streamSimple();
			},
		};
		await handler("fork early.tape --model live/model-x --at 1 --result REPLACED", fakeCtx(dir, session.entries));

		// Nothing has diverged yet — the intervention is at turn 1 and has not been served —
		// so a request the recording lacks is a broken key, not the experiment.
		const stream = streamOf(captured)(
			{ api: "tape-replay", provider: "tape", id: "test-model" },
			{ messages: [{ role: "user", content: [{ type: "text", text: "not the recorded prompt" }] }] },
		);
		const events: Array<Record<string, unknown>> = [];
		for await (const event of stream) events.push(event);

		const last = events.at(-1) as { type: string; error: { errorMessage: string } };
		assert.equal(last.type, "error");
		assert.match(last.error.errorMessage, /has not reached its intervention/);
		assert.match(last.error.errorMessage, /Nothing was sent to live\/model-x/);
		assert.equal(liveCalls, 0, "the model is never asked before the fork has diverged");

		capturedNotices = [];
		await handler("status", fakeCtx(dir, session.entries));
		assert.match(capturedNotices.join("\n"), /stopped unsent/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("after the intervention has been served, a miss goes live as it should", async () => {
	const { captured, dir } = prepare();
	try {
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record served", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live after the intervention");
		await handler("fork served.tape --model live/model-x --at 1 --result REPLACED", fakeCtx(dir, session.entries));

		const tool = captured.tools.get("read") as {
			execute: (id: string, params?: unknown) => Promise<Record<string, unknown>>;
		};
		const replaced = await tool.execute("call_a0003", { path: "a.txt" });
		assert.equal((replaced.content as Array<Record<string, unknown>>)[0]?.text, "REPLACED");

		const stream = streamOf(captured)(
			{ api: "tape-replay", provider: "tape", id: "test-model" },
			{ messages: [{ role: "user", content: [{ type: "text", text: "a context with the replacement in it" }] }] },
		);
		for await (const _event of stream) void _event;
		const final = await stream.result();
		assert.equal((final.content as Array<Record<string, unknown>>)[0]?.text, "live after the intervention");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a live read the recording can answer comes from the recording, not today's disk", async () => {
	const { captured, dir } = prepare();
	try {
		writeFileSync(join(dir, "a.txt"), "the file as it is on disk now\n");
		writeFileSync(join(dir, "other.txt"), "only on disk\n");
		const session = parseSession(buildFixture().text);
		const handler = captured.commands.get("tape") as (args: string, ctx: unknown) => Promise<void>;
		await handler("record order", fakeCtx(dir, session.entries));
		fakeRegistry = fakeLiveModel("live");
		await handler("fork order.tape --model live/model-x --live-tools read", fakeCtx(dir, session.entries));

		const tool = captured.tools.get("read") as {
			execute: (id: string, params?: unknown) => Promise<Record<string, unknown>>;
		};

		// The recording read a.txt and nothing changed it since: that answer is the world
		// at the fork point, even though `read` may run for real.
		const recorded = await tool.execute("call_live_1", { path: "a.txt" });
		assert.equal((recorded.content as Array<Record<string, unknown>>)[0]?.text, "alpha");
		assert.equal((recorded.details as Record<string, unknown>).tape, "reconnected");

		// What the recording never read goes to the real tool.
		const real = await tool.execute("call_live_2", { path: "other.txt" });
		assert.match(String((real.content as Array<Record<string, unknown>>)[0]?.text), /only on disk/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
