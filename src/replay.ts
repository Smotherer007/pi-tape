/**
 * The replay engine: the part that decides what to serve instead of asking a
 * provider or running a tool. Pure logic, no pi dependency, so it is testable
 * without starting an agent.
 *
 * Lookup strategy
 * ---------------
 * 1. *Hash*: recorded assistant answers and tool results are indexed by a prefix
 *    hash (see hash.ts). If the incoming request hashes to a recorded prefix,
 *    serve that. This is what makes a fork possible: change one tool result and
 *    only the affected subtree misses.
 * 2. *Cursor*: when the hash misses — a fork changed the context, or prefix
 *    normalisation stripped something the provider cared about — fall back to the
 *    next unconsumed recorded event of the right kind. This keeps a straight
 *    replay working even with imperfect hashes.
 *
 * A miss is never silent: misses land in `diagnostics` so a debugging session can
 * explain why a run diverged from its recording.
 */

import type { ReplayOutcome, SessionEntry, TapeFile } from "./types.ts";
import { messageOf, parseSession, toolCallsOf, type SessionFile } from "./session.ts";
import { hashPrefix, type HashContext } from "./hash.ts";
import { resolveEntries } from "./tape.ts";

export interface ReplayDiagnostic {
	kind: "assistant" | "tool";
	detail: string;
	hash: string;
	consumedSoFar: number;
	timestamp: string;
}

export interface ReplayStatus {
	assistantTotal: number;
	assistantConsumed: number;
	toolTotal: number;
	toolConsumed: number;
	misses: number;
	finished: boolean;
}

interface RecordedEvent {
	index: number;
	hash: string;
	toolName: string;
	entry: SessionEntry;
}

export interface ReplayEngineOptions {
	/** Restrict hashing to the last N messages. 0 (default) means the whole prefix. */
	windowMessages?: number;
	includeThinking?: boolean;
	/**
	 * Include the model/provider/thinking level in the hash. Off by default: a
	 * replay serves answers through a synthetic provider whose identity differs
	 * from the recorded one, so binding the model to the key would make every
	 * lookup miss. Turn it on when comparing two recordings of the same
	 * conversation across different models.
	 */
	bindModelContext?: boolean;
}

interface ResolvedOptions {
	windowMessages: number;
	includeThinking: boolean;
	bindModelContext: boolean;
}

export class ReplayEngine {
	readonly tape: TapeFile;
	readonly entries: SessionEntry[];
	readonly diagnostics: ReplayDiagnostic[] = [];

	private readonly options: ResolvedOptions;
	private readonly assistants: RecordedEvent[] = [];
	private readonly toolResults: RecordedEvent[] = [];
	private readonly consumedAssistants = new Set<number>();
	private readonly consumedTools = new Set<number>();
	private assistantCursor = 0;
	private toolCursor = 0;

	constructor(tape: TapeFile, options: ReplayEngineOptions = {}) {
		this.tape = tape;
		this.options = {
			windowMessages: options.windowMessages ?? 0,
			includeThinking: options.includeThinking ?? true,
			bindModelContext: options.bindModelContext ?? false,
		};
		this.entries = resolveEntries(tape);

		const prefix: SessionEntry[] = [];
		for (const entry of this.entries) {
			const message = messageOf(entry);
			if (!message) {
				prefix.push(entry);
				continue;
			}

			const context = contextOf(prefix.concat(entry));

			if (message.role === "assistant") {
				this.assistants.push({
					index: this.assistants.length,
					hash: this.hashOf(prefix, context),
					toolName: "",
					entry,
				});
			} else if (message.role === "toolResult") {
				this.toolResults.push({
					index: this.toolResults.length,
					hash: this.hashOf(prefix, context),
					toolName: typeof message.toolName === "string" ? message.toolName : "",
					entry,
				});
			}
			prefix.push(entry);
		}
	}

	/** Recorded assistant message whose request prefix matches `prefixEntries`. */
	nextAssistant(prefixEntries: SessionEntry[], context: HashContext = {}): ReplayOutcome {
		const hash = this.hashOf(prefixEntries, context);
		const byHash = this.assistants.find((item) => item.hash === hash && !this.consumedAssistants.has(item.index));
		if (byHash) {
			this.markAssistant(byHash.index);
			return { kind: "hit", via: "hash", entry: byHash.entry };
		}

		const next = this.assistants.find((item) => !this.consumedAssistants.has(item.index));
		if (next) {
			this.markAssistant(next.index);
			this.recordMiss("assistant", hash, next.index);
			return { kind: "hit", via: "cursor", entry: next.entry };
		}

		this.recordMiss("assistant", hash, -1);
		return { kind: "miss", reason: "no recorded assistant response left" };
	}

	/** Recorded tool result for `toolName` given the current prefix. */
	nextToolResult(toolName: string, prefixEntries: SessionEntry[], context: HashContext = {}): ReplayOutcome {
		const hash = this.hashOf(prefixEntries, context);
		const byHash = this.toolResults.find(
			(item) => item.hash === hash && item.toolName === toolName && !this.consumedTools.has(item.index),
		);
		if (byHash) {
			this.markTool(byHash.index);
			return { kind: "hit", via: "hash", entry: byHash.entry };
		}

		const next = this.toolResults.find(
			(item) => item.toolName === toolName && !this.consumedTools.has(item.index),
		);
		if (next) {
			this.markTool(next.index);
			this.recordMiss("tool", hash, next.index);
			return { kind: "hit", via: "cursor", entry: next.entry };
		}

		this.recordMiss("tool", hash, -1);
		return { kind: "miss", reason: `no recorded result left for tool "${toolName}"` };
	}

	/**
	 * Serve the recorded result for a specific tool call.
	 *
	 * In a straight replay the assistant message comes from the recording, so its
	 * tool call ids are the recorded ones; matching by id is exact and needs no
	 * hashing. Use `nextToolResult` when replaying a fork whose ids may differ.
	 */
	nextToolResultById(toolCallId: string): ReplayOutcome {
		const match = this.toolResults.find(
			(item) => !this.consumedTools.has(item.index) && toolCallIdOf(item.entry) === toolCallId,
		);
		if (match) {
			this.markTool(match.index);
			return { kind: "hit", via: "hash", entry: match.entry };
		}
		return { kind: "miss", reason: `no recorded result for tool call ${toolCallId}` };
	}

	/** Convenience wrapper: serve an assistant answer for a provider's message list. */
	nextAssistantFromMessages(messages: unknown[]): ReplayOutcome {
		return this.nextAssistant(entriesFromMessages(messages), {});
	}

	status(): ReplayStatus {
		return {
			assistantTotal: this.assistants.length,
			assistantConsumed: this.assistantCursor,
			toolTotal: this.toolResults.length,
			toolConsumed: this.toolCursor,
			misses: this.diagnostics.length,
			finished: this.assistantCursor >= this.assistants.length && this.toolCursor >= this.toolResults.length,
		};
	}

	/** All tool names that appear in the recording, in first-seen order. */
	toolNames(): string[] {
		const names: string[] = [];
		const add = (name: unknown) => {
			if (typeof name === "string" && name && !names.includes(name)) names.push(name);
		};
		for (const entry of this.entries) {
			for (const call of toolCallsOf(entry)) add(call.name);
			const message = messageOf(entry);
			if (message?.role === "toolResult") add(message.toolName);
		}
		return names;
	}

	/** The recorded tool declaration for `name`, used to re-register the tool. */
	toolDeclaration(name: string): Record<string, unknown> | undefined {
		for (const entry of this.entries) {
			const message = messageOf(entry);
			if (message?.role !== "system") continue;
			// The prompt and tool loadout live on the *message*, not the entry:
			// {"type":"message",...,"message":{"role":"system","sections":{...},"toolsAdded":[...]}}
			const list = message.toolsAdded;
			if (!Array.isArray(list)) continue;
			for (const tool of list as Array<Record<string, unknown>>) {
				if (tool.name === name) return tool;
			}
		}
		return undefined;
	}

	/** Tool names declared in the recording's system messages. */
	declaredToolNames(): string[] {
		const names: string[] = [];
		for (const entry of this.entries) {
			const message = messageOf(entry);
			if (message?.role !== "system") continue;
			const list = message.toolsAdded;
			if (!Array.isArray(list)) continue;
			for (const tool of list as Array<Record<string, unknown>>) {
				if (typeof tool.name === "string" && !names.includes(tool.name)) names.push(tool.name);
			}
		}
		return names;
	}

	/** Conversation entries in recorded order, for a transcript view. */
	recordedTranscript(): SessionEntry[] {
		return this.entries.filter((entry) => {
			const role = messageOf(entry)?.role;
			return role === "user" || role === "assistant" || role === "toolResult";
		});
	}

	private hashOf(prefix: SessionEntry[], context: HashContext): string {
		return hashPrefix(prefix, this.options.bindModelContext ? context : {}, {
			windowMessages: this.options.windowMessages,
			includeThinking: this.options.includeThinking,
		});
	}

	private markAssistant(index: number): void {
		this.consumedAssistants.add(index);
		this.assistantCursor = Math.max(this.assistantCursor, index + 1);
	}

	private markTool(index: number): void {
		this.consumedTools.add(index);
		this.toolCursor = Math.max(this.toolCursor, index + 1);
	}

	private recordMiss(kind: "assistant" | "tool", hash: string, index: number): void {
		this.diagnostics.push({
			kind,
			hash,
			consumedSoFar: kind === "assistant" ? this.assistantCursor : this.toolCursor,
			detail:
				index < 0
					? `no recorded ${kind} event matched; the replay left the recording`
					: `hash missed; served recorded ${kind} #${index} by position instead`,
			timestamp: new Date().toISOString(),
		});
	}
}

/** The tool call id a recorded tool result answers. */
export function toolCallIdOf(entry: SessionEntry): string | undefined {
	const message = messageOf(entry);
	if (message?.role !== "toolResult") return undefined;
	return typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}

/**
 * Wrap a provider's message list as session entries so it can run through the
 * same prefix hashing as a recording. Order is preserved; ids are synthetic.
 */
export function entriesFromMessages(messages: unknown[]): SessionEntry[] {
	return messages.map((message, index) => ({
		type: "message",
		id: `m${index}`,
		parentId: index === 0 ? null : `m${index - 1}`,
		timestamp: "",
		message,
	}) as SessionEntry);
}

/** Model/thinking settings in effect at the end of `entries`. */
export function contextOf(entries: SessionEntry[]): HashContext {	const context: HashContext = {};
	for (const entry of entries) {
		if (entry.type === "model_change") {
			if (typeof entry.provider === "string") context.provider = entry.provider;
			if (typeof entry.modelId === "string") context.model = entry.modelId;
		}
		if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
			context.thinkingLevel = entry.thinkingLevel;
		}
		const message = messageOf(entry);
		if (message?.role === "assistant") {
			if (typeof message.provider === "string") context.provider = message.provider;
			if (typeof message.model === "string") context.model = message.model;
			if (typeof message.thinkingLevel === "string") context.thinkingLevel = message.thinkingLevel;
		}
	}
	return context;
}

/** Build a replay engine directly from a loaded tape. */
export function openTape(tape: TapeFile, options: ReplayEngineOptions = {}): ReplayEngine {
	return new ReplayEngine(tape, options);
}

export interface VerifyResult {
	ok: boolean;
	assistantHits: number;
	toolHits: number;
	misses: ReplayDiagnostic[];
}

/**
 * Walk the recording with the replay engine and report whether every recorded
 * event can be served. This is the self-test of a tape: it proves the
 * capture is complete before you trust a replay.
 */
export function verifyRecording(tape: TapeFile, options: ReplayEngineOptions = {}): VerifyResult {
	const engine = new ReplayEngine(tape, options);
	const entries = resolveEntries(tape);

	const prefix: SessionEntry[] = [];
	let assistantHits = 0;
	let toolHits = 0;

	for (const entry of entries) {
		const message = messageOf(entry);
		if (!message) {
			prefix.push(entry);
			continue;
		}
		const context = contextOf(prefix.concat(entry));

		if (message.role === "assistant") {
			if (engine.nextAssistant(prefix, context).kind === "hit") assistantHits++;
		} else if (message.role === "toolResult") {
			const name = typeof message.toolName === "string" ? message.toolName : "";
			if (engine.nextToolResult(name, prefix, context).kind === "hit") toolHits++;
		}
		prefix.push(entry);
	}

	return { ok: engine.diagnostics.length === 0, assistantHits, toolHits, misses: engine.diagnostics };
}

/** Re-parse a tape as if it were a session file. Useful for tests and tooling. */
export function tapeToSession(tape: TapeFile): SessionFile {
	const resolved = resolveEntries(tape);
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: tape.source.sessionId,
			timestamp: tape.created,
			cwd: tape.source.cwd,
			tape: tape.id,
		}),
		...resolved.map((entry) => JSON.stringify(entry)),
	];
	return parseSession(lines.join("\n"), tape.source.sessionFile);
}
