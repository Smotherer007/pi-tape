/**
 * Test fixtures: hand-built session files small enough to reason about.
 *
 * The tree is:
 *
 *   header
 *   s1 system (declares read/write)
 *   u1  user "do a thing"
 *   a1  assistant -> read{path:"a.txt"}
 *   t1  toolResult read "alpha"
 *   a2  assistant text "done"
 *   u2  user "now branch"
 *   a3  assistant text "branch answer"      <- leaf A
 *   a2b assistant text "forked answer"      <- leaf B (child of t1)
 */

import type { SessionEntry } from "../src/types.ts";

let counter = 0;
export function id(prefix: string): string {
	counter++;
	return `${prefix}${counter.toString().padStart(4, "0")}`;
}

export function resetIds(): void {
	counter = 0;
}

export function entry(
	partial: Partial<SessionEntry> & { type: string; id: string; parentId: string | null },
): SessionEntry {
	return {
		timestamp: "2026-01-01T00:00:00.000Z",
		...partial,
	} as SessionEntry;
}

export function systemEntry(entryId: string, parentId: string | null): SessionEntry {
	return entry({
		type: "message",
		id: entryId,
		parentId,
		message: {
			role: "system",
			content: "",
			sections: { preamble: "You are a test agent." },
			toolsAdded: [
				{
					name: "read",
					description: "Read a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
				{
					name: "write",
					description: "Write a file",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			],
			timestamp: 1,
		},
	});
}

export function userEntry(entryId: string, parentId: string | null, text: string): SessionEntry {
	return entry({
		type: "message",
		id: entryId,
		parentId,
		message: { role: "user", content: [{ type: "text", text }], timestamp: 2 },
	});
}

export function assistantText(entryId: string, parentId: string | null, text: string): SessionEntry {
	return entry({
		type: "message",
		id: entryId,
		parentId,
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `Considering: ${text}` },
				{ type: "text", text },
			],
			api: "openai-completions",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 10,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 15,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
			},
			stopReason: "stop",
			timestamp: 3,
		},
	});
}

export function assistantToolCall(
	entryId: string,
	parentId: string | null,
	toolName: string,
	args: Record<string, unknown>,
): SessionEntry {
	return entry({
		type: "message",
		id: entryId,
		parentId,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `call_${entryId}`, name: toolName, arguments: args }],
			api: "openai-completions",
			provider: "test-provider",
			model: "test-model",
			usage: {
				input: 20,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 28,
				cost: { input: 0.002, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.005 },
			},
			stopReason: "toolUse",
			timestamp: 4,
		},
	});
}

export function toolResultEntry(
	entryId: string,
	parentId: string | null,
	toolName: string,
	text: string,
	isError = false,
): SessionEntry {
	return entry({
		type: "message",
		id: entryId,
		parentId,
		message: {
			role: "toolResult",
			toolCallId: `call_${parentId}`,
			toolName,
			content: [{ type: "text", text }],
			isError,
			timestamp: 5,
		},
	});
}

export function sessionText(entries: SessionEntry[], cwd = "/tmp/project"): string {
	const header = JSON.stringify({
		type: "session",
		version: 3,
		id: "test-session-0001",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd,
	});
	return [header, ...entries.map((item) => JSON.stringify(item))].join("\n");
}

export interface Fixture {
	text: string;
	ids: {
		system: string;
		u1: string;
		a1: string;
		t1: string;
		a2: string;
		u2: string;
		a3: string;
		a2b: string;
	};
}

/** A small branching session used across the tests. */
export function buildFixture(): Fixture {
	resetIds();
	const ids = {
		system: id("s"),
		u1: id("u"),
		a1: id("a"),
		t1: id("t"),
		a2: id("a"),
		u2: id("u"),
		a3: id("a"),
		a2b: id("a"),
	};

	const entries: SessionEntry[] = [
		systemEntry(ids.system, null),
		userEntry(ids.u1, ids.system, "do a thing"),
		assistantToolCall(ids.a1, ids.u1, "read", { path: "a.txt" }),
		toolResultEntry(ids.t1, ids.a1, "read", "alpha"),
		assistantText(ids.a2, ids.t1, "done"),
		userEntry(ids.u2, ids.a2, "now branch"),
		assistantText(ids.a3, ids.u2, "branch answer"),
		// A second arm: fork from the tool result, bypassing u2/a3.
		assistantText(ids.a2b, ids.t1, "forked answer"),
	];

	return { text: sessionText(entries), ids };
}
