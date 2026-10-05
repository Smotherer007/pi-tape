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
 * Reduce a message to the fields that influence the model's answer.
 * Unknown keys are kept, because a provider sees them too.
 */
export function normalizeMessage(message: SessionMessage, opts: Required<HashOptions>): unknown {
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
