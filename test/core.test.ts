import assert from "node:assert/strict";
import { test } from "node:test";
import { recordSession } from "../src/record.ts";
import { diffTapes, entryFingerprint, formatDiff } from "../src/diff.ts";
import { hashPrefix, stableStringify } from "../src/hash.ts";
import { inspectTape } from "../src/inspect.ts";
import { ReplayEngine, contextOf, verifyRecording } from "../src/replay.ts";
import { parseSession, pathToLeaf, activeLeaf, branchPoints, messageOf } from "../src/session.ts";
import { buildDictionary, packTape, resolveEntries, unpackTape, validateTape, TapeFormatError } from "../src/tape.ts";
import { computeStats } from "../src/stats.ts";
import { buildFixture, entry, sessionText, systemEntry, userEntry, assistantText, toolResultEntry, assistantToolCall, compactedSession, compactionMessage } from "./fixtures.ts";
import { compactionSummaryOf } from "../src/hash.ts";
import { entriesFromMessages } from "../src/replay.ts";

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

test("how long a turn took, and the thinking level it ran at, do not change the hash", () => {
	// Both differ on every real replay: a replayed tool takes 0 ms, a replayed answer
	// takes no time, and a replay at another /thinking level stamps every served answer
	// with it. Hashing them turned every request after the first into a miss in real pi.
	const entries = [
		systemEntry("s1", null),
		userEntry("u1", "s1", "read it"),
		assistantToolCall("a1", "u1", "read", { path: "a.txt" }),
		toolResultEntry("t1", "a1", "read", "alpha"),
	];
	const baseline = hashPrefix(entries);

	const replayed = structuredClone(entries);
	const answer = (replayed[2] as Record<string, unknown>).message as Record<string, unknown>;
	answer.durationMs = 0;
	answer.thinkingLevel = "high";
	((replayed[3] as Record<string, unknown>).message as Record<string, unknown>).durationMs = 0;

	const recorded = structuredClone(entries);
	const original = (recorded[2] as Record<string, unknown>).message as Record<string, unknown>;
	original.durationMs = 4_210;
	original.thinkingLevel = "off";
	((recorded[3] as Record<string, unknown>).message as Record<string, unknown>).durationMs = 1;

	assert.equal(hashPrefix(recorded), hashPrefix(replayed));
	assert.equal(hashPrefix(recorded), baseline);

	// The guarantee stays narrow: the tool result's content still counts.
	((replayed[3] as Record<string, unknown>).message as Record<string, unknown>).content = [
		{ type: "text", text: "something else" },
	];
	assert.notEqual(hashPrefix(replayed), baseline);
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

test("fork mode reports a miss instead of answering a new context with the old answer", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { leafId: session.entries.at(-1)?.id ?? null });
	const engine = new ReplayEngine(tape, { onMiss: "miss" });
	const resolved = resolveEntries(tape);

	// The same counterfactual as above: one tool result was edited, so every request
	// after it describes a context the recording never contained.
	const prefix = structuredClone(resolved.slice(0, 2));
	const toolResult = prefix[1] as Record<string, unknown>;
	(toolResult.message as Record<string, unknown>).content = [{ type: "text", text: "EDITED" }];

	const outcome = engine.nextAssistant(prefix, { model: "test-model", provider: "test-provider" });

	assert.equal(outcome.kind, "miss", "a fork must not be served the next recorded answer");
	assert.match(engine.diagnostics[0]?.detail ?? "", /fork mode asks the provider/);
	const status = engine.status();
	assert.equal(status.assistantConsumed, 0, "a miss consumes nothing, so the caller can still fork");
	assert.equal(status.finished, false);

	// The recorded prefix is still reachable, so a fork can serve the untouched part.
	assert.ok(engine.lookupAssistant(resolved.slice(0, 2)));
	assert.equal(engine.lookupAssistant(prefix), undefined);
});

test("lookupAssistant finds only an exact prefix and consumes nothing", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { leafId: session.entries.at(-1)?.id ?? null });
	const engine = new ReplayEngine(tape);
	const resolved = resolveEntries(tape);

	const found = engine.lookupAssistant(resolved.slice(0, 2), contextOf(resolved.slice(0, 3)));
	assert.equal(found?.id, resolved[2]?.id);
	assert.equal(engine.status().assistantConsumed, 0, "peeking is not consuming");
	assert.equal(engine.lookupAssistant(resolved.slice(0, 1)), undefined, "one entry short is a different request");
});

test("progress counts events served, not the highest index touched", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { leafId: session.entries.at(-1)?.id ?? null });
	const engine = new ReplayEngine(tape);
	const resolved = resolveEntries(tape);

	// Serve the *second* assistant turn first. Its prefix contains the first, which
	// this does not serve — exactly the out-of-order case a fork produces.
	const assistantIndexes = resolved
		.map((item, index) => ({ item, index }))
		.filter(({ item }) => messageOf(item)?.role === "assistant")
		.map(({ index }) => index);
	const secondAssistant = assistantIndexes[1];
	assert.ok(secondAssistant !== undefined, "the fixture has two assistant turns");
	const outcome = engine.nextAssistant(resolved.slice(0, secondAssistant), contextOf(resolved.slice(0, secondAssistant + 1)));
	assert.equal(outcome.kind, "hit");

	assert.equal(engine.status().assistantConsumed, 1, "one event was served, whatever its index");
});

test("tool declarations can be bound into the key, and a tape still replays against itself", () => {
	const session = parseSession(buildFixture().text);
	const { tape } = recordSession(session, { leafId: session.entries.at(-1)?.id ?? null });
	const resolved = resolveEntries(tape);

	const plain = new ReplayEngine(tape);
	const bound = new ReplayEngine(tape, { bindToolContext: true });

	assert.ok(bound.lookupAssistant(resolved.slice(0, 2)), "the recording's own tools are in the key and still match");
	assert.equal(verifyRecording(tape, { bindToolContext: true }).ok, true, "still self-consistent");

	// The same messages with a different tool loadout are a different request, and
	// that only shows once the declarations are part of the key.
	const stripped = structuredClone(resolved.slice(0, 2));
	delete ((stripped[0] as Record<string, unknown>).message as Record<string, unknown>).toolsAdded;
	assert.ok(plain.lookupAssistant(stripped), "without tool binding the loadout is invisible");
	assert.equal(bound.lookupAssistant(stripped), undefined, "with it, a changed loadout misses");
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

test("the engine exposes the recorded tool calls as addressable turn points", () => {
	const { tape } = recordSession(parseSession(buildFixture().text));
	const engine = new ReplayEngine(tape);

	const points = engine.toolCallPoints();
	assert.equal(points.length, 1, "the fixture records one tool call");
	assert.equal(points[0]?.turn, 1, "turns are 1-based, because `--at 1` is what a person types");
	assert.equal(points[0]?.toolName, "read");
	assert.deepEqual(points[0]?.arguments, { path: "a.txt" });
	assert.equal(points[0]?.hasResult, true);
});

test("a tool result can be replaced, and the replacement is what a fork sees", () => {
	const { tape } = recordSession(parseSession(buildFixture().text));
	const engine = new ReplayEngine(tape);
	const call = engine.toolCallPoints()[0];
	assert.ok(call);

	assert.equal(engine.toolResultOverride(call.toolCallId), undefined, "nothing is replaced until asked");
	engine.setToolResultOverride(call.toolCallId, [{ type: "text", text: "REPLACED" }]);

	assert.deepEqual(engine.toolResultOverride(call.toolCallId), [{ type: "text", text: "REPLACED" }]);
	assert.deepEqual(engine.toolResultOverrides(), [
		{ toolCallId: call.toolCallId, content: [{ type: "text", text: "REPLACED" }] },
	]);
	assert.equal(engine.toolResultOverride("call_never_recorded"), undefined);
});

test("a live tool call that repeats the recorded one is served from the recording", () => {
	const { tape } = recordSession(parseSession(buildFixture().text));
	const engine = new ReplayEngine(tape);
	const call = engine.toolCallPoints()[0];
	assert.ok(call);

	// What a fork's live branch produces: the same tool, the same arguments, a new id.
	const reconnected = engine.matchRecordedCall(call.toolName, call.arguments);
	assert.equal(reconnected.kind, "hit");
	if (reconnected.kind === "hit") {
		assert.equal(reconnected.via, "reconnect");
		assert.equal(
			String((messageOf(reconnected.entry)?.content as Array<{ text?: string }> | undefined)?.[0]?.text),
			"alpha",
			"the recorded result is what a live branch gets back",
		);
	}

	// Consumed once, and only for the call it actually was.
	assert.equal(engine.matchRecordedCall(call.toolName, call.arguments).kind, "miss");
	const other = new ReplayEngine(tape);
	assert.equal(other.matchRecordedCall(call.toolName, { path: "somewhere-else.txt" }).kind, "miss");
	assert.equal(other.matchRecordedCall("bash", call.arguments).kind, "miss");
});

test("a tool the recording never used can never reconnect", () => {
	const { tape } = recordSession(parseSession(buildFixture().text));
	const engine = new ReplayEngine(tape);
	assert.equal(engine.matchRecordedCall("write", { path: "a.txt" }).kind, "miss");
});

/**
 * read a.txt → "v1", then bash rewrites it, then read a.txt → "v2".
 * The second read describes a world the recording changed after the first one.
 */
function changingWorldTape() {
	const entries = [
		systemEntry("s1", null),
		userEntry("u1", "s1", "update a.txt"),
		assistantToolCall("a1", "u1", "read", { path: "a.txt" }),
		toolResultEntry("t1", "a1", "read", "v1"),
		assistantToolCall("a2", "t1", "bash", { command: "echo v2 > a.txt" }),
		toolResultEntry("t2", "a2", "bash", ""),
		assistantToolCall("a3", "t2", "read", { path: "a.txt" }),
		toolResultEntry("t3", "a3", "read", "v2"),
		assistantText("a4", "t3", "done"),
	];
	return recordSession(parseSession(sessionText(entries))).tape;
}

const textOfEntry = (entry: unknown) =>
	String(
		(messageOf(entry as never)?.content as Array<{ text?: string }> | undefined)?.[0]?.text,
	);

test("a tool that can change things never reconnects, even with identical arguments", () => {
	const engine = new ReplayEngine(changingWorldTape());
	const outcome = engine.matchRecordedCall("bash", { command: "echo v2 > a.txt" });
	assert.equal(outcome.kind, "miss");
	if (outcome.kind === "miss") assert.match(outcome.reason, /bash can change what it looks at/);
});

test("reconnect stops at the recording's next change", () => {
	const engine = new ReplayEngine(changingWorldTape());

	const first = engine.matchRecordedCall("read", { path: "a.txt" });
	assert.equal(first.kind, "hit");
	if (first.kind === "hit") assert.equal(textOfEntry(first.entry), "v1");

	// The only other recorded read of a.txt comes after bash rewrote it: that answer
	// describes the recording's world, not this branch's.
	const second = engine.matchRecordedCall("read", { path: "a.txt" });
	assert.equal(second.kind, "miss");
	if (second.kind === "miss") assert.match(second.reason, /before bash at turn 2 changed things/);

	// Once the change itself has been served, the later read is fair game again.
	assert.equal(engine.nextToolResultById("call_a2").kind, "hit");
	const third = engine.matchRecordedCall("read", { path: "a.txt" });
	assert.equal(third.kind, "hit");
	if (third.kind === "hit") assert.equal(textOfEntry(third.entry), "v2");
});

test("repeating an intervened call returns the intervention, not the recording", () => {
	const engine = new ReplayEngine(changingWorldTape());
	engine.setToolResultOverride("call_a1", [{ type: "text", text: "REPLACED" }]);

	const outcome = engine.matchRecordedCall("read", { path: "a.txt" });
	assert.equal(outcome.kind, "hit");
	if (outcome.kind === "hit") {
		assert.equal(textOfEntry(outcome.entry), "REPLACED", "asking twice must not undo the counterfactual");
		assert.equal((messageOf(outcome.entry)?.details as Record<string, unknown>).tape, "override");
	}
});

test("a forked recording carries where it came from, and diff says so", () => {
	const session = parseSession(buildFixture().text);
	const origin = recordSession(session, { name: "origin" });

	const forked = recordSession(session, {
		name: "forked",
		parent: {
			tapeId: origin.tape.id,
			forkPoint: { toolCallId: "call_a0003", toolName: "read", turn: 1, replacement: "REPLACED" },
			liveRequests: 2,
			reconnected: 1,
		},
	});

	assert.equal(forked.tape.parent?.tapeId, origin.tape.id);
	assert.equal(forked.tape.parent?.forkPoint?.replacement, "REPLACED");
	assert.equal(origin.tape.parent, undefined, "a recording that is not a fork says nothing about a parent");

	const report = diffTapes(origin.tape, forked.tape);
	assert.equal(report.parent?.tapeId, origin.tape.id, "the fork relation is reported, not inferred by the reader");

	const text = formatDiff(report);
	assert.match(text, /right was forked from left/);
	assert.match(text, /fork point {2}read turn 1 \(call_a0003\)/);
	assert.match(text, /replaced {4}"REPLACED"/);
	assert.match(text, /2 request\(s\) asked of a provider · 1 live call\(s\) answered from the recording/);
});

test("a diff of two unrelated recordings claims no parent", () => {
	const session = parseSession(buildFixture().text);
	const left = recordSession(session, { name: "left" });
	const right = recordSession(session, { name: "right" });

	assert.equal(diffTapes(left.tape, right.tape).parent, undefined);
	assert.doesNotMatch(formatDiff(diffTapes(left.tape, right.tape)), /forked/);

	// A parent pointing at some *other* tape is not a relation to this one.
	const elsewhere = recordSession(session, { name: "elsewhere", parent: { tapeId: "sha256:nothing-to-do-with-us" } });
	assert.equal(diffTapes(left.tape, elsewhere.tape).parent, undefined);
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

// ---------------------------------------------------------------------------
// compaction
// ---------------------------------------------------------------------------

const messagesOf = (entries: ReturnType<typeof compactedSession>["entries"], ids: string[]) =>
	ids.map((id) => (entries.find((item) => item.id === id) as Record<string, unknown>).message);

test("a request after a compaction matches whether or not the replay compacted", () => {
	const { text, entries } = compactedSession();
	const engine = new ReplayEngine(recordSession(parseSession(text)).tape);

	// Without compacting, a replay sends the whole history.
	const full = engine.lookupAssistant(entriesFromMessages(messagesOf(entries, ["u1", "a1", "t1", "a2", "u2"])));
	assert.equal(full?.id, "a3");

	// Compacting at the same point, it sends what the model saw: the summary, then the kept answer.
	const compacted = engine.lookupAssistant(
		entriesFromMessages([
			compactionMessage("The user had a.txt read; it says alpha."),
			...messagesOf(entries, ["a2", "u2"]),
		]),
	);
	assert.equal(compacted?.id, "a3", "the summary stands in for what it replaced");

	// A different summary is a different request.
	const other = engine.lookupAssistant(
		entriesFromMessages([compactionMessage("Something else entirely."), ...messagesOf(entries, ["a2", "u2"])]),
	);
	assert.equal(other, undefined);
});

test("a recorded compaction is served only at the point it happened", () => {
	const { text } = compactedSession();
	const engine = new ReplayEngine(recordSession(parseSession(text)).tape);
	assert.equal(engine.compactionCount, 1);
	assert.equal(engine.takeCompaction(1), undefined, "after one answer the recording had not compacted yet");
	const served = engine.takeCompaction(2);
	assert.equal(served?.summary, "The user had a.txt read; it says alpha.");
	assert.deepEqual(served?.details, { readFiles: ["a.txt"], modifiedFiles: [] });
	assert.equal(engine.takeCompaction(2), undefined, "and only once");
});

test("pi's compaction message is read back to its summary, and nothing else is", () => {
	assert.equal(compactionSummaryOf(compactionMessage("SUM") as never), "SUM");
	assert.equal(compactionSummaryOf({ role: "user", content: [{ type: "text", text: "<summary>x</summary>" }] } as never), undefined);
	assert.equal(compactionSummaryOf({ role: "compactionSummary", summary: "S" } as never), "S");
	assert.equal(compactionSummaryOf({ role: "assistant", content: [] } as never), undefined);
});
