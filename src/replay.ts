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
 * 3. *Fork*: with `onMiss: "miss"` the cursor is switched off, so a hash miss is
 *    reported instead of answered from the recording. The caller can then ask a
 *    real provider for that request — which is the only honest way to serve a
 *    context the recording never contained. A miss consumes nothing either way.
 *
 * A miss is never silent: misses land in `diagnostics` so a debugging session can
 * explain why a run diverged from its recording.
 */

import type { ReplayOutcome, SessionEntry, SessionFile, TapeFile } from "./types.ts";
import { contentBlocks, messageOf, parseSession, toolCallsOf } from "./session.ts";
import { compactionSummaryOf, hashPrefix, stableStringify, type HashContext } from "./hash.ts";
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
	/** Hash of the full recorded history before this event. */
	hash: string;
	/**
	 * Hash of what the model actually saw, when a compaction came before this event:
	 * the summary plus the kept messages. A replay that compacts at the same point
	 * sends that; one that does not sends the full history. Either is a match.
	 */
	altHash?: string;
	toolName: string;
	entry: SessionEntry;
}

/** A compaction in the recording, so a replay can serve its summary instead of asking. */
export interface RecordedCompaction {
	summary: string;
	details?: unknown;
	/** How many recorded answers came before it — where in the run it happened. */
	assistantsBefore: number;
	consumed?: boolean;
}

/** One tool call in the recording, linked to the result that answers it. */
export interface RecordedToolCall {
	/** 1-based position among the recording's tool calls, so a human can name one. */
	turn: number;
	toolCallId: string;
	toolName: string;
	arguments: unknown;
	/** Index into the recorded tool results, when the recording has one for this call. */
	resultIndex?: number;
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
	/**
	 * Include the tool loadout in the hash. Off by default.
	 *
	 * A recording keeps its tools on the system message (`toolsAdded`); a live
	 * request carries them as `context.tools`. Including them makes the key what the
	 * design says it is — messages plus tool declarations — but it is only sound when
	 * both sides agree, and a tool whose description differs by a byte turns every
	 * lookup into a miss. Off unless the loadout is known to be stable.
	 */
	bindToolContext?: boolean;
	/**
	 * What a prefix-hash miss means.
	 *
	 * - `"cursor"` (default): serve the next unconsumed recorded event of the right
	 *   kind. A straight replay survives an imperfect hash this way.
	 * - `"miss"`: report the miss and consume nothing, so the caller can ask a real
	 *   provider. This is the switch that makes a fork a fork: without it a changed
	 *   context would silently be answered with the old recording.
	 */
	onMiss?: "cursor" | "miss";
}

interface ResolvedOptions {
	windowMessages: number;
	includeThinking: boolean;
	bindModelContext: boolean;
	bindToolContext: boolean;
	onMiss: "cursor" | "miss";
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
	private readonly calls: RecordedToolCall[] = [];
	private readonly compactions: RecordedCompaction[] = [];
	private readonly overrides = new Map<string, unknown>();

	constructor(tape: TapeFile, options: ReplayEngineOptions = {}) {
		this.tape = tape;
		this.options = {
			windowMessages: options.windowMessages ?? 0,
			includeThinking: options.includeThinking ?? true,
			bindModelContext: options.bindModelContext ?? false,
			bindToolContext: options.bindToolContext ?? false,
			onMiss: options.onMiss ?? "cursor",
		};
		this.entries = resolveEntries(tape);

		const prefix: SessionEntry[] = [];
		// What the model saw after a compaction: the summary, then the kept entries.
		let effective: SessionEntry[] | undefined;
		for (const entry of this.entries) {
			const message = messageOf(entry);
			if (!message) {
				if (entry.type === "compaction" && typeof entry.summary === "string") {
					const base = effective ?? prefix;
					let kept = base.findIndex((item) => item.id === entry.firstKeptEntryId);
					let from = base;
					if (kept < 0) {
						kept = prefix.findIndex((item) => item.id === entry.firstKeptEntryId);
						from = prefix;
					}
					effective = [compactionSummaryEntry(entry), ...(kept >= 0 ? from.slice(kept) : [])];
					this.compactions.push({
						summary: entry.summary,
						...(entry.details === undefined ? {} : { details: entry.details }),
						assistantsBefore: this.assistants.length,
					});
				}
				prefix.push(entry);
				effective?.push(entry);
				continue;
			}

			const context = contextOf(prefix.concat(entry));
			const altHash = effective ? this.hashOf(effective, context) : undefined;

			if (message.role === "assistant") {
				this.assistants.push({
					index: this.assistants.length,
					hash: this.hashOf(prefix, context),
					...(altHash === undefined ? {} : { altHash }),
					toolName: "",
					entry,
				});
			} else if (message.role === "toolResult") {
				this.toolResults.push({
					index: this.toolResults.length,
					hash: this.hashOf(prefix, context),
					...(altHash === undefined ? {} : { altHash }),
					toolName: typeof message.toolName === "string" ? message.toolName : "",
					entry,
				});
			}
			prefix.push(entry);
			effective?.push(entry);
		}

		// A second pass links each call to the result that answers it. A fork needs this
		// twice over: to name where to intervene, and to reconnect a live branch that
		// asks for something the recording already did.
		const resultIndexById = new Map<string, number>();
		this.toolResults.forEach((event, index) => {
			const id = toolCallIdOf(event.entry);
			if (id !== undefined) resultIndexById.set(id, index);
		});
		for (const entry of this.entries) {
			for (const call of toolCallsOf(entry)) {
				const resultIndex = resultIndexById.get(call.id);
				this.calls.push({
					turn: this.calls.length + 1,
					toolCallId: call.id,
					toolName: call.name,
					arguments: call.arguments,
					...(resultIndex === undefined ? {} : { resultIndex }),
				});
			}
		}
	}

	/**
	 * The recording's tool calls, in order, so a human or a flag can name one.
	 *
	 * `turn` is what `--at 2` means; `toolCallId` is what `--at call_abc` means. Both
	 * exist because one is readable and the other is exact.
	 */
	toolCallPoints(): Array<{
		turn: number;
		toolCallId: string;
		toolName: string;
		arguments: unknown;
		hasResult: boolean;
	}> {
		return this.calls.map((call) => ({
			turn: call.turn,
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			arguments: call.arguments,
			hasResult: call.resultIndex !== undefined,
		}));
	}

	/**
	 * Replace what a recorded tool call returned.
	 *
	 * This is the intervention a fork exists for — "what if the tool had said something
	 * else here". The replacement feeds the *next* request, so the prefix stops
	 * matching and a real model is asked, which is the whole point rather than a
	 * side effect.
	 */
	setToolResultOverride(toolCallId: string, content: unknown): void {
		this.overrides.set(toolCallId, content);
	}

	/** The replacement armed for this tool call, if any. */
	toolResultOverride(toolCallId: string): unknown | undefined {
		return this.overrides.get(toolCallId);
	}

	/** Every intervention this run was armed with, for the report. */
	toolResultOverrides(): Array<{ toolCallId: string; content: unknown }> {
		return [...this.overrides].map(([toolCallId, content]) => ({ toolCallId, content }));
	}

	/**
	 * Serve a live tool call from the recording when it is the call the recording
	 * made: same tool, same arguments — and only when the recorded answer is still
	 * evidence of what the call would return here.
	 *
	 * Without this, a fork dies at the first live tool call: the live branch's call ids
	 * are new, so `nextToolResultById` cannot know the call is the same one the
	 * recording already answered. Matching on the call itself is what lets a run
	 * continue past its divergence instead of stopping one thought later.
	 *
	 * Two rules keep it from lying:
	 *
	 * - Only read-only tools reconnect (`READ_ONLY_TOOLS`). `bash npm test` with the same
	 *   arguments is not the same call when the world differs; serving its recorded
	 *   output would be a plausible answer to a question nobody asked.
	 * - Only a recorded call that happened *before the next recorded change* is a
	 *   candidate. The recorded run kept going after the fork point and changed things —
	 *   a `read` of `a.txt` recorded after a `write` to it describes a file this branch
	 *   never produced. The horizon is the first recorded call that is not read-only and
	 *   has not been served yet.
	 *
	 * A call that repeats an intervened one gets the replacement, not the recording:
	 * the counterfactual is that the tool said something else, and asking twice must
	 * not undo it.
	 */
	matchRecordedCall(toolName: string, args: unknown): ReplayOutcome {
		if (!isReadOnlyTool(toolName)) {
			return {
				kind: "miss",
				reason: `${toolName} can change what it looks at, so a recorded ${toolName} result is not evidence of what it would return in this branch`,
			};
		}

		const wanted = comparableArguments(args ?? {});
		const horizon = this.calls.find(
			(call) =>
				!isReadOnlyTool(call.toolName) &&
				(call.resultIndex === undefined || !this.consumedTools.has(call.resultIndex)),
		);

		for (const call of this.calls) {
			if (horizon && call.turn >= horizon.turn) break;
			if (call.toolName !== toolName) continue;
			if (comparableArguments(call.arguments ?? {}) !== wanted) continue;

			const replacement = this.overrides.get(call.toolCallId);
			if (replacement !== undefined) {
				return { kind: "hit", via: "reconnect", entry: overrideEntry(call, replacement) };
			}

			if (call.resultIndex === undefined) continue;
			if (this.consumedTools.has(call.resultIndex)) continue;
			const event = this.toolResults[call.resultIndex] as RecordedEvent;
			this.markTool(call.resultIndex);
			return { kind: "hit", via: "reconnect", entry: event.entry };
		}

		return {
			kind: "miss",
			reason: horizon
				? `the recording has no unconsumed ${toolName} call with these arguments before ${horizon.toolName} at turn ${horizon.turn} changed things`
				: `the recording has no unconsumed ${toolName} call with these arguments`,
		};
	}

	/**
	 * The recorded answer for exactly this prefix, or `undefined` if the recording
	 * has none. Consumes nothing and does not fall back to position, so a caller can
	 * decide what a miss means before committing to it.
	 */
	lookupAssistant(prefixEntries: SessionEntry[], context: HashContext = {}): SessionEntry | undefined {
		const hash = this.hashOf(prefixEntries, context);
		return this.assistants.find((item) => matches(item, hash))?.entry;
	}

	/**
	 * The recorded answer a request would be served, *without* consuming it.
	 *
	 * This exists so a shadow run can compare the recording with what a different
	 * model says about the same request, while the recording is still served as
	 * usual: the run has to follow the recorded trajectory, or the later requests
	 * would stop lining up with it. On a miss it reports the next unconsumed event,
	 * that being what a cursor replay would serve.
	 */
	peekAssistant(prefixEntries: SessionEntry[], context: HashContext = {}): SessionEntry | undefined {
		const exact = this.lookupAssistant(prefixEntries, context);
		if (exact) return exact;
		return this.assistants.find((item) => !this.consumedAssistants.has(item.index))?.entry;
	}

	/**
	 * The recorded compaction for this point in the run, consumed — or `undefined` when
	 * the recording did not compact here.
	 *
	 * "Here" is the number of recorded answers served so far: a summary written after
	 * eight answers describes those eight, and handing it to a run at another point
	 * would summarise a history that run does not have.
	 */
	takeCompaction(assistantsServed: number): RecordedCompaction | undefined {
		const next = this.compactions.find((item) => !item.consumed);
		if (!next || next.assistantsBefore !== assistantsServed) return undefined;
		next.consumed = true;
		return next;
	}

	/** Compactions in the recording. */
	get compactionCount(): number {
		return this.compactions.length;
	}

	/** How many recorded answers came before the next compaction not yet served, if any. */
	nextCompactionPoint(): number | undefined {
		return this.compactions.find((item) => !item.consumed)?.assistantsBefore;
	}

	/**
	 * What the user typed, in the order it was sent — the prompts a run replays.
	 * A compaction summary is pi's, not the user's, and is left out.
	 */
	recordedPrompts(): string[] {
		const prompts: string[] = [];
		for (const entry of this.entries) {
			const message = messageOf(entry);
			if (message?.role !== "user") continue;
			if (compactionSummaryOf(message) !== undefined) continue;
			const text = contentBlocks(message)
				.map((block) => (typeof block.text === "string" ? block.text : ""))
				.join("")
				.trim();
			if (text) prompts.push(text);
		}
		return prompts;
	}

	/** Total recorded assistant events, for progress reporting. */
	get assistantCount(): number {
		return this.assistants.length;
	}

	/** Recorded assistant message whose request prefix matches `prefixEntries`. */
	nextAssistant(prefixEntries: SessionEntry[], context: HashContext = {}): ReplayOutcome {
		const hash = this.hashOf(prefixEntries, context);
		const byHash = this.assistants.find((item) => matches(item, hash) && !this.consumedAssistants.has(item.index));
		if (byHash) {
			this.markAssistant(byHash.index);
			return { kind: "hit", via: "hash", entry: byHash.entry };
		}

		if (this.options.onMiss === "miss") {
			this.recordMiss("assistant", hash, -1, "hash miss; fork mode asks the provider instead of falling back");
			return { kind: "miss", reason: "hash miss; fork mode does not fall back to position" };
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
			(item) => matches(item, hash) && item.toolName === toolName && !this.consumedTools.has(item.index),
		);
		if (byHash) {
			this.markTool(byHash.index);
			return { kind: "hit", via: "hash", entry: byHash.entry };
		}

		if (this.options.onMiss === "miss") {
			this.recordMiss(
				"tool",
				hash,
				-1,
				`hash miss for tool "${toolName}"; fork mode asks the provider instead of falling back`,
			);
			return { kind: "miss", reason: `hash miss for tool "${toolName}"; fork mode does not fall back to position` };
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
	nextAssistantFromMessages(messages: unknown[], context: HashContext = {}): ReplayOutcome {
		return this.nextAssistant(entriesFromMessages(messages), context);
	}

	status(): ReplayStatus {
		return {
			assistantTotal: this.assistants.length,
			assistantConsumed: this.consumedAssistants.size,
			toolTotal: this.toolResults.length,
			toolConsumed: this.consumedTools.size,
			misses: this.diagnostics.length,
			finished:
				this.consumedAssistants.size >= this.assistants.length && this.consumedTools.size >= this.toolResults.length,
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
		const resolved: HashContext = this.options.bindModelContext ? { ...context } : {};
		if (this.options.bindToolContext) resolved.tools = toolsForHash(prefix, context.tools);
		return hashPrefix(prefix, resolved, {
			windowMessages: this.options.windowMessages,
			includeThinking: this.options.includeThinking,
		});
	}

	private markAssistant(index: number): void {
		this.consumedAssistants.add(index);
	}

	private markTool(index: number): void {
		this.consumedTools.add(index);
	}

	private recordMiss(kind: "assistant" | "tool", hash: string, index: number, detail?: string): void {
		this.diagnostics.push({
			kind,
			hash,
			consumedSoFar: kind === "assistant" ? this.consumedAssistants.size : this.consumedTools.size,
			detail:
				detail ??
				(index < 0
					? `no recorded ${kind} event matched; the replay left the recording`
					: `hash missed; served recorded ${kind} #${index} by position instead`),
			timestamp: new Date().toISOString(),
		});
	}
}

function matches(item: RecordedEvent, hash: string): boolean {
	return item.hash === hash || item.altHash === hash;
}

/** A recorded compaction as the message the model was given in its place. */
function compactionSummaryEntry(entry: SessionEntry): SessionEntry {
	return {
		type: "message",
		id: `compaction-${entry.id}`,
		parentId: null,
		timestamp: "",
		message: { role: "compactionSummary", summary: entry.summary, content: [] },
	} as SessionEntry;
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

/**
 * Tools that only look. Reconnecting a live call to its recording is sound for these
 * and nothing else: a tool that can change the world may answer differently the
 * second time, and an unknown tool (an MCP server, an extension) is assumed to be
 * one that can.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

export function isReadOnlyTool(name: string): boolean {
	return READ_ONLY_TOOLS.has(name);
}

/** A recorded tool call answered with its intervention, shaped like a recorded result. */
function overrideEntry(call: RecordedToolCall, content: unknown): SessionEntry {
	return {
		type: "message",
		id: `override-${call.toolCallId}`,
		parentId: null,
		timestamp: "",
		message: {
			role: "toolResult",
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			content,
			details: { tape: "override" },
		},
	} as SessionEntry;
}

/**
 * Tool arguments reduced to what the caller actually meant.
 *
 * pi fills optional parameters with `null` before the call reaches the recording —
 * `{path: "probe-input.txt", offset: null, limit: null}` — while a live model sends
 * only the fields it set: `{path: "probe-input.txt"}`. Comparing the raw JSON would
 * never match the same call, so empty fields are dropped first. That is a deliberate
 * guess: an argument whose value is genuinely `null` is indistinguishable from one
 * that was never given, and for a tool call the second reading is by far the likelier.
 */
function comparableArguments(value: unknown): string {
	return stableStringify(dropEmpty(value));
}

function dropEmpty(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(dropEmpty);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (item === null || item === undefined) continue;
			out[key] = dropEmpty(item);
		}
		return out;
	}
	return value;
}

/** Build a replay engine directly from a loaded tape. */
export function openTape(tape: TapeFile, options: ReplayEngineOptions = {}): ReplayEngine {
	return new ReplayEngine(tape, options);
}

/**
 * The tool loadout to hash, in a stable order.
 *
 * Prefers what the prefix itself declares (`toolsAdded` on a system message), so a
 * recording is self-describing, and falls back to declarations handed in by the
 * caller. `undefined` when there are none, which leaves the hash of a message list
 * without tools exactly as it was.
 */
function toolsForHash(prefix: SessionEntry[], supplied: unknown): unknown {
	const declared: Array<Record<string, unknown>> = [];
	for (const entry of prefix) {
		const message = messageOf(entry);
		if (message?.role !== "system") continue;
		const list = message.toolsAdded;
		if (!Array.isArray(list)) continue;
		for (const tool of list as Array<Record<string, unknown>>) {
			if (!declared.some((item) => item.name === tool.name)) declared.push(tool);
		}
	}
	const tools = declared.length ? declared : Array.isArray(supplied) ? supplied : undefined;
	if (!tools?.length) return undefined;
	return [...tools].sort((a, b) =>
		String((a as { name?: unknown }).name ?? "").localeCompare(String((b as { name?: unknown }).name ?? "")),
	);
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
