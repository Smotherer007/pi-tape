/**
 * Hash fidelity against a real pi run.
 *
 * The replay tests in core.test.ts build their messages by hand, which is exactly
 * how a mismatch hides: they agree with the recording because the same person wrote
 * both sides. This fixture is not hand-made — it is captured from a real session
 * (deepseek-flash, one `read` call, then a text answer) together with the message
 * list pi actually sent while replaying that session.
 *
 * The two sides differ in fields that name who wrote an earlier turn — `api`,
 * `model`, `provider` — because a replayed turn is served through pi-tape's
 * synthetic provider. Those fields are not sent to a provider, so they must not be
 * part of the key. When they were, every replay of a real run missed on the second
 * request and silently fell back to position; in fork mode it would have called a
 * real model for a request the recording already answered.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { hashPrefix, normalizePrefix } from "../src/hash.ts";
import { recordSession } from "../src/record.ts";
import { ReplayEngine, entriesFromMessages } from "../src/replay.ts";
import { parseSession } from "../src/session.ts";
import type { SessionEntry } from "../src/types.ts";
import { sessionText } from "./fixtures.ts";

interface RealSessionFixture {
	note: string;
	recorded: SessionEntry[];
	live: SessionEntry[];
}

const fixture = JSON.parse(
	readFileSync(join(import.meta.dirname, "fixtures", "real-session.json"), "utf8"),
) as RealSessionFixture;

const textOf = (entry: SessionEntry) =>
	contentOf(entry)
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join(" ");

const messageOfEntry = (entry: SessionEntry) => entry.message as Record<string, unknown> | undefined;
const contentOf = (entry: SessionEntry) => (messageOfEntry(entry)?.content ?? []) as Array<Record<string, unknown>>;

test("the fixture really is two different renderings of one run", () => {
	assert.equal(fixture.recorded.length, 4, "user, tool call, tool result, answer");
	assert.equal(fixture.live.length, 3, "the request prefix: everything before the answer");

	// If these ever agree the test below stops proving anything, so say so loudly.
	const recordedAssistant = fixture.recorded[1] as SessionEntry;
	const liveAssistant = fixture.live[1] as SessionEntry;
	assert.equal(messageOfEntry(recordedAssistant)?.api, "openai-completions");
	assert.equal(messageOfEntry(liveAssistant)?.api, "tape-replay");
	assert.deepEqual(
		contentOf(recordedAssistant),
		contentOf(liveAssistant),
		"the part a provider actually sees is identical — only the provenance differs",
	);
});

test("a real live request finds its recorded answer", () => {
	const { tape } = recordSession(parseSession(sessionText(fixture.recorded)));
	const engine = new ReplayEngine(tape);

	const found = engine.lookupAssistant(entriesFromMessages(fixture.live.map((entry) => messageOfEntry(entry))));

	assert.ok(found, "the request pi sent must hash to the recorded prefix");
	assert.equal(found.id, (fixture.recorded.at(-1) as SessionEntry).id, "and to the answer, not some other event");
	assert.match(textOf(found), /hello probe/, "the recorded answer is the one that mentions the file");
});

test("provenance fields do not change the hash, but content does", () => {
	const recorded = fixture.recorded.slice(0, 3);
	const live = fixture.live;
	const options = { includeThinking: true, includeToolCalls: true, includeImages: false, windowMessages: 0 };

	assert.equal(
		hashPrefix(recorded, {}, options),
		hashPrefix(live, {}, options),
		"api/model/provider describe the writer, not the request",
	);

	// The guarantee is narrow: it must not have made the hash blind to content.
	const edited = structuredClone(live) as SessionEntry[];
	(contentOf(edited[2] as SessionEntry)[0] as Record<string, unknown>).text = "something else";
	assert.notEqual(hashPrefix(edited, {}, options), hashPrefix(live, {}, options));

	const withDifferentUser = structuredClone(live) as SessionEntry[];
	(contentOf(withDifferentUser[0] as SessionEntry)[0] as Record<string, unknown>).text = "a different question";
	assert.notEqual(hashPrefix(withDifferentUser, {}, options), hashPrefix(live, {}, options));
});

test("a full replay of the real run serves every recorded event by hash", () => {
	const { tape } = recordSession(parseSession(sessionText(fixture.recorded)));
	const engine = new ReplayEngine(tape);

	// The first request is the prefix before the tool call; the second is the prefix
	// before the answer, which is the one that used to miss.
	const firstRequest = entriesFromMessages(fixture.recorded.slice(0, 1).map((entry) => messageOfEntry(entry)));
	const secondRequest = entriesFromMessages(fixture.live.map((entry) => messageOfEntry(entry)));

	assert.equal(engine.nextAssistant(firstRequest).kind, "hit");
	assert.equal(engine.nextAssistant(secondRequest).kind, "hit");
	assert.deepEqual(engine.diagnostics, [], `expected no misses, got ${JSON.stringify(engine.diagnostics)}`);

	// The tool result is served by id, which is how a straight replay resolves it.
	const call = contentOf(fixture.recorded[1] as SessionEntry).find((block) => block.type === "toolCall");
	assert.equal(engine.nextToolResultById(String(call?.id)).kind, "hit");
	assert.equal(engine.status().finished, true);
});

test("normalising the live prefix drops exactly the provenance fields", () => {
	const normalized = normalizePrefix(fixture.live, {}, {
		includeThinking: true,
		includeToolCalls: true,
		includeImages: false,
		windowMessages: 0,
	}) as { messages: Array<Record<string, unknown>> };

	for (const message of normalized.messages) {
		for (const key of ["api", "model", "provider", "usage", "timestamp"]) {
			assert.equal(key in message, false, `${key} must not survive into the hash`);
		}
	}
});
