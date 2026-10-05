import assert from "node:assert/strict";
import { test } from "node:test";
import { recordSession } from "../src/record.ts";
import { diffTapes, entryFingerprint, formatDiff } from "../src/diff.ts";
import { hashPrefix, stableStringify } from "../src/hash.ts";
import { inspectTape } from "../src/inspect.ts";
import { ReplayEngine, contextOf, verifyRecording } from "../src/replay.ts";
import { parseSession, pathToLeaf, activeLeaf, branchPoints } from "../src/session.ts";
import { buildDictionary, packTape, resolveEntries, unpackTape, validateTape, TapeFormatError } from "../src/tape.ts";
import { computeStats } from "../src/stats.ts";
import { buildFixture, entry, sessionText, systemEntry, userEntry, assistantText, toolResultEntry, assistantToolCall } from "./fixtures.ts";

// ---------------------------------------------------------------------------
// session parsing and tree navigation
// ---------------------------------------------------------------------------

test("parses a session into a tree and finds its leaf", () => {
	const fixture = buildFixture();
	const session = parseSession(fixture.text);

	assert.equal(session.header.id, "test-session-0001");
	assert.equal(session.entries.length, 8);
	assert.equal(activeLeaf(session), fixture.ids.a2b, "last written branch wins");
	assert.equal(session.leaves.length, 2);
});

test("walking to a leaf yields the root-to-leaf ancestry in order", () => {
	const fixture = buildFixture();
	const session = parseSession(fixture.text);
	const path = pathToLeaf(session, fixture.ids.a2);

	assert.deepEqual(
		path.map((item) => item.id),
		[fixture.ids.system, fixture.ids.u1, fixture.ids.a1, fixture.ids.t1, fixture.ids.a2],
	);
});

test("branch points are entries with more than one child", () => {
	const fixture = buildFixture();
	const session = parseSession(fixture.text);
	const forks = branchPoints(session, fixture.ids.a2b);

	assert.deepEqual(
		forks.map((item) => item.id),
		[fixture.ids.t1],
		"the tool result is where the two arms separate",
	);
});

test("a session without a header is rejected, including the line number", () => {
	assert.throws(() => parseSession('{"type":"message","id":"x","parentId":null}'), /missing session header/);
	assert.throws(() => parseSession('{"type":"session","id":"h","cwd":"/x"}\nnot json'), /line 2/);
});

// ---------------------------------------------------------------------------
// hashing
// ---------------------------------------------------------------------------

test("stableStringify sorts keys so equal objects hash equally", () => {
	assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
	assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test("volatile metadata does not change the prefix hash", () => {
	const fixture = buildFixture();
	const session = parseSession(fixture.text);
	const path = pathToLeaf(session, fixture.ids.a2);

	const baseline = hashPrefix(path.slice(0, 3));

	const changed = structuredClone(path.slice(0, 3));
	const assistant = changed[2] as Record<string, unknown>;
	const message = assistant.message as Record<string, unknown>;
	message.timestamp = 999_999;
	message.responseId = "different";
	message.usage = { input: 1, output: 1, totalTokens: 2, cost: { total: 0.5 } };
	assistant.timestamp = "2030-01-01T00:00:00.000Z";

	assert.equal(hashPrefix(changed), baseline, "timestamps, usage and ids are not part of the request");
});

test("changing message content changes the prefix hash", () => {
	const fixture = buildFixture();
	const session = parseSession(fixture.text);
	const path = pathToLeaf(session, fixture.ids.a2);
	const baseline = hashPrefix(path.slice(0, 3));

	const changed = structuredClone(path.slice(0, 3));
	const user = changed[1] as Record<string, unknown>;
	(user.message as Record<string, unknown>).content = [{ type: "text", text: "something else" }];

	assert.notEqual(hashPrefix(changed), baseline);
});

// ---------------------------------------------------------------------------
// the .tape format
// ---------------------------------------------------------------------------

test("capture produces a self-consistent tape", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { name: "unit-test" });

	assert.equal(tape.magic, "pi-tape");
	assert.equal(tape.version, 1);
	assert.equal(tape.profile, "normal");
	assert.equal(tape.lossy, false);
	assert.equal(tape.name, "unit-test");
	assert.equal(tape.source.sessionId, "test-session-0001");
	assert.equal(tape.entries.length, 5, "only the active branch is captured by default");
	assert.ok(tape.id.startsWith("sha256:"));
	assert.equal(tape.stats.userMessages, 1);
});

test("a tape survives a pack/unpack round trip", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session);

	const restored = unpackTape(packTape(tape));
	assert.deepEqual(restored.entries, tape.entries);
	assert.deepEqual(restored.stats, tape.stats);
	assert.equal(restored.id, tape.id);
});

test("unpack accepts plain JSON so a tape is hand-editable", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session);
	const restored = unpackTape(JSON.stringify(tape));
	assert.equal(restored.id, tape.id);
});

test("the validator rejects foreign files with a useful message", () => {
	assert.throws(() => validateTape({ magic: "something-else" }), /not a tape/);
	assert.throws(() => validateTape({ magic: "pi-tape", version: 99 }), /unsupported tape version/);
	assert.throws(() => validateTape({ magic: "pi-tape", version: 1 }), /`entries` must be an array/);
});

test("large repeated strings are pooled once and restored on read", () => {
	const big = "x".repeat(600);
	const entries = [
		entry({ type: "message", id: "1", parentId: null, message: { role: "toolResult", content: [{ type: "text", text: big }] } }),
		entry({ type: "message", id: "2", parentId: "1", message: { role: "toolResult", content: [{ type: "text", text: big }] } }),
	];
	const { value, dict } = buildDictionary(entries);

	assert.equal(dict.length, 1, "identical strings share one pool slot");
	assert.equal(dict[0], big);

	// The first occurrence becomes a reference rather than an inline copy.
	const first = (value as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
	const firstMessage = first.message as Record<string, unknown>;
	const firstBlock = (firstMessage.content as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
	assert.deepEqual(firstBlock.text, { $d: 0 });

	// The pool is transparent to everything downstream.
	const restored = resolveEntries({ dict } as never, value as never) as Array<Record<string, unknown>>;
	const restoredMessage = restored[0]?.message as Record<string, unknown>;
	const restoredBlock = (restoredMessage.content as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
	assert.equal(restoredBlock.text, big);
});

test("minimal profile is marked lossy and reports what it dropped", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { profile: "minimal" });

	assert.equal(tape.lossy, true);
	assert.ok(
		tape.dropped.some((item) => item.includes("thinking")),
		`expected thinking to be dropped, got ${JSON.stringify(tape.dropped)}`,
	);
});

test("normal profile keeps thinking and stays lossless", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { profile: "normal" });
	const resolved = resolveEntries(tape);
	const withThinking = resolved.some((item) => {
		const blocks = (item.message as Record<string, unknown> | undefined)?.content;
		return Array.isArray(blocks) && blocks.some((block) => (block as Record<string, unknown>).type === "thinking");
	});

	assert.equal(tape.lossy, false);
	assert.equal(withThinking, true);
});

test("minimal profile truncates oversized tool results", () => {
	const huge = "a".repeat(9000);
	const text = sessionText([
		systemEntry("s1", null),
		userEntry("u1", "s1", "go"),
		assistantToolCall("a1", "u1", "read", { path: "big.txt" }),
		toolResultEntry("t1", "a1", "read", huge),
	]);
	const { tape } = recordSession(parseSession(text), { profile: "minimal" });
	const resolved = resolveEntries(tape);
	const result = resolved.find((item) => item.id === "t1") as Record<string, unknown>;
	const message = result.message as Record<string, unknown>;
	const block = (message.content as Array<Record<string, unknown>>)[0] as Record<string, unknown>;

	assert.ok(typeof block.text === "string" && (block.text as string).includes("truncated"));
	assert.ok((block.text as string).length < huge.length);
	assert.ok(tape.dropped.some((item) => item.includes("truncated")));
});

// ---------------------------------------------------------------------------
// replay engine
// ---------------------------------------------------------------------------

test("replay serves every recorded event of a straight run by hash", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session);

	const result = verifyRecording(tape);
	assert.equal(result.ok, true, `expected no misses, got ${JSON.stringify(result.misses)}`);
	assert.equal(result.assistantHits, 2, "both assistant turns are servable");
	assert.equal(result.toolHits, 1, "the tool result is servable");
});

test("the engine returns the recorded assistant message for a known prefix", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { leafId: session.entries.at(-1)?.id ?? null });
	const engine = new ReplayEngine(tape);
	const resolved = resolveEntries(tape);

	// Prefix up to but excluding the first assistant message.
	const prefix = resolved.slice(0, 2);
	const outcome = engine.nextAssistant(prefix, contextOf(resolved.slice(0, 3)));

	assert.equal(outcome.kind, "hit");
	if (outcome.kind === "hit") {
		assert.equal(outcome.via, "hash");
		assert.equal(outcome.entry.id, resolved[2]?.id);
	}
});

test("a fork that changes the prefix misses the hash and falls back to position", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { leafId: session.entries.at(-1)?.id ?? null });
	const engine = new ReplayEngine(tape);
	const resolved = resolveEntries(tape);

	// Pretend a tool result was edited, which is exactly what a counterfactual does.
	const prefix = structuredClone(resolved.slice(0, 2));
	const toolResult = prefix[1] as Record<string, unknown>;
	(toolResult.message as Record<string, unknown>).content = [{ type: "text", text: "EDITED" }];

	const outcome = engine.nextAssistant(prefix, { model: "test-model", provider: "test-provider" });

	assert.equal(outcome.kind, "hit");
	if (outcome.kind === "hit") assert.equal(outcome.via, "cursor", "falls back rather than stalling");
	assert.equal(engine.diagnostics.length, 1);
	assert.match(engine.diagnostics[0]?.detail ?? "", /hash missed/);
});

test("a replay that runs past its recording reports a miss instead of inventing data", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { leafId: session.entries.at(-1)?.id ?? null });
	const engine = new ReplayEngine(tape);
	const resolved = resolveEntries(tape);

	for (let i = 0; i < resolved.length; i++) {
		engine.nextAssistant(resolved.slice(0, i), {});
	}
	const outcome = engine.nextAssistant(resolved, {});
	assert.equal(outcome.kind, "miss");
});

test("the engine exposes the recorded tool declarations for re-registration", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session);
	const engine = new ReplayEngine(tape);

	const declaration = engine.toolDeclaration("read");
	assert.ok(declaration, "the system message's toolsAdded list is the source of truth");
	assert.equal(declaration?.name, "read");
	assert.deepEqual(
		engine.declaredToolNames(),
		["read", "write"],
		"declarations survive capture so a replay is self-contained",
	);
	assert.ok(engine.toolNames().includes("read"));
});

test("status tracks consumption and completion", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session);
	const engine = new ReplayEngine(tape);
	const before = engine.status();
	assert.equal(before.assistantConsumed, 0);
	assert.equal(before.finished, false);
});

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------

test("stats aggregate tokens, cost, tools and models", () => {
	const session = parseSession(buildFixture().text);
	const path = pathToLeaf(session, "a0008");
	const stats = computeStats(path);

	assert.equal(stats.assistantMessages, 2);
	assert.equal(stats.toolResults, 1);
	assert.equal(stats.tools.includes("read"), true);
	assert.equal(stats.models.includes("test-model"), true);
	assert.ok(stats.costUsd > 0);
	assert.ok(stats.totalTokens > 0);
});

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test("fingerprints ignore volatile fields so two equal turns compare equal", () => {
	const a = assistantText("a1", "u1", "hello");
	const b = structuredClone(a);
	const message = b.message as Record<string, unknown>;
	message.timestamp = 12_345;
	message.usage = { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } };
	assert.equal(entryFingerprint(a), entryFingerprint(b));
});

test("diff finds the first diverging turn and the tool divergence", () => {
	const base = [
		systemEntry("s1", null),
		userEntry("u1", "s1", "do it"),
		assistantToolCall("a1", "u1", "read", { path: "x" }),
		toolResultEntry("t1", "a1", "read", "same"),
		assistantText("a2", "t1", "answer A"),
	];
	const left = recordSession(parseSession(sessionText(base))).tape;
	const right = recordSession(
		parseSession(
			sessionText([
				...base.slice(0, 4),
				assistantText("a2", "t1", "answer B"),
			]),
		),
	).tape;

	const report = diffTapes(left, right);
	assert.equal(report.commonPrefix, 3, "system entries are not conversation turns");
	assert.equal(report.firstDivergence?.index, 3);
	assert.equal(report.firstDivergence?.reason, "content");

	const text = formatDiff(report);
	assert.match(text, /first divergence at turn 3/);
});

test("diff reports identical runs as identical", () => {
	const session = parseSession(buildFixture().text);
	const a = recordSession(session).tape;
	const b = recordSession(parseSession(sessionText(resolveEntries(a)))).tape;
	const report = diffTapes(a, b);

	assert.equal(report.firstDivergence, undefined);
	assert.match(formatDiff(report), /identical/);
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

test("inspect renders a report with run stats and a self-test", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { name: "inspect-me" });
	const text = inspectTape(tape, { timeline: true, bytes: 1024 });

	assert.match(text, /inspect-me/);
	assert.match(text, /Run/);
	assert.match(text, /Self-test/);
	assert.match(text, /Timeline/);
	assert.match(text, /tape is complete/);
});
