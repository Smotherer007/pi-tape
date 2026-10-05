/** Session and tape statistics: what a run cost, what it touched, where it forked. */

import type { SessionEntry, SessionFile, TapeFile, TapeStats } from "./types.ts";
import { contentBlocks, messageOf, pathToLeaf, toolCallsOf } from "./session.ts";

interface UsageLike {
	input?: number;
	output?: number;
	totalTokens?: number;
	cost?: { total?: number };
}

function usageOf(entry: SessionEntry): UsageLike | undefined {
	if (entry.type === "usage") return entry.usage as UsageLike | undefined;
	const message = messageOf(entry);
	return message?.usage as UsageLike | undefined;
}

/** Aggregate token/cost/tool/model statistics over a set of entries. */
export function computeStats(entries: SessionEntry[]): TapeStats {
	const stats: TapeStats = {
		entries: entries.length,
		messages: 0,
		userMessages: 0,
		assistantMessages: 0,
		toolResults: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costUsd: 0,
		tools: [],
		models: [],
	};

	const tools = new Set<string>();
	const models = new Set<string>();

	for (const entry of entries) {
		const message = messageOf(entry);
		if (message) {
			stats.messages++;
			if (message.role === "user") stats.userMessages++;
			if (message.role === "assistant") {
				stats.assistantMessages++;
				const model = message.model;
				if (typeof model === "string" && model) models.add(model);
			}
			if (message.role === "toolResult") {
				stats.toolResults++;
				if (typeof message.toolName === "string" && message.toolName) tools.add(message.toolName);
			}
		}

		for (const call of toolCallsOf(entry)) {
			if (call.name) tools.add(call.name);
		}

		if (entry.type === "model_change" && typeof entry.modelId === "string" && entry.modelId) {
			models.add(entry.modelId);
		}

		const usage = usageOf(entry);
		if (usage) {
			stats.inputTokens += usage.input ?? 0;
			stats.outputTokens += usage.output ?? 0;
			stats.totalTokens += usage.totalTokens ?? 0;
			stats.costUsd += usage.cost?.total ?? 0;
		}
	}

	stats.tools = [...tools].sort();
	stats.models = [...models].sort();
	return stats;
}

/**
 * The largest context contributors on a path, measured as the character count of
 * each entry's model-visible payload. This is the "what is eating my context"
 * view that a moment-in-time `/context` cannot give you across a whole run.
 */
export interface ContextHog {
	entryId: string;
	role: string;
	label: string;
	chars: number;
	tokensApprox: number;
}

export function contextHogs(entries: SessionEntry[], limit = 15): ContextHog[] {
	const hogs: ContextHog[] = [];

	for (const entry of entries) {
		const message = messageOf(entry);
		if (!message) continue;

		let chars = 0;
		if (typeof message.content === "string") {
			chars = message.content.length;
		} else {
			for (const block of contentBlocks(message)) {
				if (typeof block.text === "string") chars += block.text.length;
				else if (typeof block.thinking === "string") chars += block.thinking.length;
				else if (typeof block.data === "string") chars += block.data.length;
				else if (block.type === "toolCall") {
					chars += JSON.stringify(block.arguments ?? {}).length;
				}
			}
		}

		const name = typeof message.toolName === "string" ? message.toolName : "";
		hogs.push({
			entryId: entry.id,
			role: message.role,
			label: name || message.role,
			chars,
			// ~4 characters per token is the usual rough conversion.
			tokensApprox: Math.round(chars / 4),
		});
	}

	return hogs.sort((a, b) => b.chars - a.chars).slice(0, limit);
}

/** Per-tool aggregate cost in characters/tokens over a path. */
export interface ToolWeight {
	tool: string;
	calls: number;
	resultChars: number;
	tokensApprox: number;
}

export function toolWeights(entries: SessionEntry[]): ToolWeight[] {
	const byTool = new Map<string, ToolWeight>();

	for (const entry of entries) {
		for (const call of toolCallsOf(entry)) {
			if (!call.name) continue;
			const current = byTool.get(call.name) ?? { tool: call.name, calls: 0, resultChars: 0, tokensApprox: 0 };
			current.calls++;
			byTool.set(call.name, current);
		}
	}

	for (const entry of entries) {
		const message = messageOf(entry);
		if (!message || message.role !== "toolResult") continue;
		const name = typeof message.toolName === "string" ? message.toolName : "unknown";
		const current = byTool.get(name) ?? { tool: name, calls: 0, resultChars: 0, tokensApprox: 0 };
		let chars = 0;
		for (const block of contentBlocks(message)) {
			if (typeof block.text === "string") chars += block.text.length;
			else if (typeof block.data === "string") chars += block.data.length;
		}
		current.resultChars += chars;
		current.tokensApprox = Math.round(current.resultChars / 4);
		byTool.set(name, current);
	}

	return [...byTool.values()].sort((a, b) => b.resultChars - a.resultChars);
}

export function statsOfSession(session: SessionFile, leafId?: string | null): TapeStats {
	const leaf = leafId === undefined ? (session.leaves[session.leaves.length - 1] ?? null) : leafId;
	return computeStats(pathToLeaf(session, leaf));
}

export function statsOfTape(tape: TapeFile): TapeStats {
	return tape.stats;
}
