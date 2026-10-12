/**
 * Cache keys for deterministic replay.
 *
 * An LLM call is a pure function of its prefix: messages + tool declarations +
 * model + sampling settings. If we hash exactly that, we can serve the recorded
 * answer instead of calling a provider.
 *
 * The hard part is deciding what is *semantically* part of the prefix. Anything
 * volatile (timestamps, usage counters, response ids) must be stripped or every
 * hash misses. Anything that changes model behaviour must be kept.
 */

import { createHash } from "node:crypto";
import type { ContentBlock, SessionEntry, SessionMessage } from "./types.ts";
import { contentBlocks, messageOf } from "./session.ts";

/** JSON with lexicographically sorted object keys, so hashes are stable. */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).filter((key) => obj[key] !== undefined).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
	}
	// undefined, functions, symbols never appear in parsed session JSON.
	return "null";
}

/**
 * Fields that do not change what the model is asked, and therefore must not
 * change the hash.
 *
 * `api`, `model` and `provider` belong here even though they name a real thing:
 * they record who *wrote* an earlier assistant turn, and a provider never sees
 * them in the request. Leaving them in made every replay miss, because a replayed
 * turn is served through pi-tape's synthetic provider (`api: "tape-replay"`,
 * `provider: "tape"`) while the recording says `openai-completions`. When model
 * identity *should* be part of the key, `bindModelContext` adds it deliberately
 * from `contextOf`, which reads these fields off the messages.
 */
const VOLATILE_MESSAGE_KEYS = new Set([
	"timestamp",
	"usage",
	"cost",
	"responseId",
	"responseModel",
	"providerThinkingLevel",
	"diagnostics",
	"errorMessage",
	"rawStopReason",
	"endTurn",
	"details",
	"nestedCalls",
	"toolCallId",
	"isError",
	"api",
	"model",
	"provider",
	// How long an earlier turn or tool took, and which thinking level pi asked for when
	// it produced an earlier answer. Both describe how a past turn came about, not what
	// the next request contains, and both differ on every replay: a replayed tool takes
	// 0 ms where the recorded one took 1, a replayed answer takes no time where the
	// model took seconds, and a replay at a different `/thinking` level stamps every
	// served answer with that level. Found by running a fork in a real pi, where each
	// one turned every request after the first into a miss. The thinking level of the
	// request itself is still bindable through `HashContext.thinkingLevel`.
	"durationMs",
	"thinkingLevel",
]);

const VOLATILE_BLOCK_KEYS = new Set([
	"textSignature",
	"thinkingSignature", // signature is opaque and provider-specific
]);

export interface HashOptions {
	/**
	 * Include `thinking` blocks. Providers differ on whether reasoning is re-sent;
	 * keep it by default so a replay of the same request is exact.
	 */
	includeThinking?: boolean;
	/** Include tool-call arguments. Almost always yes. */
	includeToolCalls?: boolean;
	/** Include images (base64 payload dominates the hash otherwise). */
	includeImages?: boolean;
	/** Restrict the hash to the last N messages. 0 or undefined means all of them. */
	windowMessages?: number;
}

function normalizeBlock(block: ContentBlock, opts: Required<HashOptions>): unknown {
	if (block.type === "thinking" && !opts.includeThinking) return null;
	if (block.type === "image" && !opts.includeImages) {
		return { type: "image", mimeType: block.mimeType ?? null };
	}
	if (block.type === "toolCall" && !opts.includeToolCalls) return null;

	const out: Record<string, unknown> = {};
	for (const key of Object.keys(block).sort()) {
		if (VOLATILE_BLOCK_KEYS.has(key)) continue;
		const value = block[key];
		if (value === undefined) continue;
		if (key === "arguments" && typeof value === "object" && value !== null) {
			out.arguments = normalizeValue(value);
			continue;
		}
		out[key] = value;
	}
	return out;
}

function normalizeValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeValue);
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) {
			if (obj[key] === undefined) continue;
			out[key] = normalizeValue(obj[key]);
		}
		return out;
	}
	return value;
}

/**
 * How pi hands a compaction summary to the model: a user message that starts with this
 * sentence and carries the summary between `<summary>` tags. The wording is pi's, not
 * an API, so it is matched loosely — the sentence and the tags, not the whitespace.
 */
const COMPACTION_PREFIX = "The conversation history before this point was compacted into the following summary:";

/**
 * The compaction summary a message stands for, or `undefined` when it is not one.
 *
 * A recording keeps a compaction as an entry (`{type: "compaction", summary}`), and the
 * replay engine turns it into `{role: "compactionSummary", summary}`; a live request
 * carries the same summary wrapped in a user message. Both reduce to the summary text,
 * so a request after a compaction hashes the same on both sides.
 */
export function compactionSummaryOf(message: SessionMessage): string | undefined {
	if (message.role === "compactionSummary" && typeof message.summary === "string") return message.summary;
	if (message.role !== "user") return undefined;
	const text = contentBlocks(message)
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("");
	if (!text.startsWith(COMPACTION_PREFIX)) return undefined;
	const open = text.indexOf("<summary>");
	const close = text.lastIndexOf("</summary>");
	if (open < 0 || close < open) return undefined;
	return text.slice(open + "<summary>".length, close).trim();
}

/**
 * Reduce a message to the fields that influence the model's answer.
 * Unknown keys are kept, because a provider sees them too.
 */
export function normalizeMessage(message: SessionMessage, opts: Required<HashOptions>): unknown {
	const summary = compactionSummaryOf(message);
	if (summary !== undefined) return { role: "compactionSummary", summary: summary.trim() };

	const out: Record<string, unknown> = { role: message.role };

	for (const key of Object.keys(message).sort()) {
		if (key === "role" || key === "content") continue;
		if (VOLATILE_MESSAGE_KEYS.has(key)) continue;
		const value = message[key];
		if (value === undefined) continue;
		out[key] = normalizeValue(value);
	}

	const blocks = contentBlocks(message)
		.map((block) => normalizeBlock(block, opts))
		.filter((block) => block !== null);
	// An assistant turn whose only content was a stripped thinking block carries no
	// information; representing it as an empty array keeps the shape stable.
	out.content = blocks;
	return out;
}

/** Fallback for settings that are not recoverable from the messages alone. */
export interface HashContext {
	model?: string;
	provider?: string;
	thinkingLevel?: string;
	tools?: unknown;
}

/** Normalized, hashable representation of a request prefix. */
export function normalizePrefix(
	entries: SessionEntry[],
	context: HashContext = {},
	options: HashOptions = {},
): unknown {
	const opts: Required<HashOptions> = {
		includeThinking: options.includeThinking ?? true,
		includeToolCalls: options.includeToolCalls ?? true,
		includeImages: options.includeImages ?? false,
		windowMessages: options.windowMessages ?? 0,
	};

	const messages: unknown[] = [];
	for (const entry of entries) {
		const message = messageOf(entry);
		if (!message) continue;
		if (message.role === "system") continue; // system is hashed via `tools`/prompt below
		messages.push(normalizeMessage(message, opts));
	}

	const selected = opts.windowMessages > 0 ? messages.slice(-opts.windowMessages) : messages;

	const result: Record<string, unknown> = { messages: selected };
	if (context.model !== undefined) result.model = context.model;
	if (context.provider !== undefined) result.provider = context.provider;
	if (context.thinkingLevel !== undefined) result.thinkingLevel = context.thinkingLevel;
	if (context.tools !== undefined) result.tools = normalizeValue(context.tools);
	return result;
}

export function hashPrefix(
	entries: SessionEntry[],
	context: HashContext = {},
	options: HashOptions = {},
): string {
	return shortHash(normalizePrefix(entries, context, options));
}

export function shortHash(value: unknown, length = 16): string {
	const digest = createHash("sha256").update(stableStringify(value)).digest("hex");
	return digest.slice(0, length);
}

/** sha256 of an arbitrary string, in `sha256:<hex>` form. */
export function checksum(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
