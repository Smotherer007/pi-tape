/**
 * Compare two tapes: where do two runs of the same task diverge?
 *
 * This is the answer to "why did it work yesterday and not today". It aligns the
 * two recordings on a shared prefix, then reports the first entry whose content
 * differs and how the tool sequences differ afterwards.
 */

import type { TapeFile, SessionEntry } from "./types.ts";
import { resolveEntries } from "./tape.ts";
import { contentBlocks, messageOf, toolCallsOf } from "./session.ts";
import { stableStringify } from "./hash.ts";

/** Content fingerprint of an entry, ignoring volatile metadata. */
export function entryFingerprint(entry: SessionEntry): string {
	const message = messageOf(entry);
	if (!message) return `${entry.type}:${stableStringify(entry.data ?? null)}`;
	const blocks = contentBlocks(message).map((block) => {
		if (block.type === "text") return `text:${String(block.text ?? "")}`;
		if (block.type === "thinking") return `thinking:${String(block.thinking ?? "")}`;
		if (block.type === "toolCall") return `call:${String(block.name)}:${stableStringify(block.arguments ?? {})}`;
		if (block.type === "image") return `image:${String(block.mimeType ?? "")}`;
		return `${block.type}:${stableStringify(block)}`;
	});
	return `${message.role}:${blocks.join("|")}`;
}

export interface Divergence {
	index: number;
	left?: SessionEntry;
	right?: SessionEntry;
	reason: "content" | "left-only" | "right-only";
}

export interface DiffReport {
	leftId: string;
	rightId: string;
	commonPrefix: number;
	leftTurns: number;
	rightTurns: number;
	firstDivergence?: Divergence;
	toolSequenceLeft: string[];
	toolSequenceRight: string[];
	costLeft: number;
	costRight: number;
}

function conversationEntries(tape: TapeFile): SessionEntry[] {
	return resolveEntries(tape).filter((entry) => {
		const role = messageOf(entry)?.role;
		return role === "user" || role === "assistant" || role === "toolResult";
	});
}

/** Tool name sequence, for structural comparison of two runs. */
export function toolSequence(entries: SessionEntry[]): string[] {
	const names: string[] = [];
	for (const entry of entries) {
		for (const call of toolCallsOf(entry)) names.push(call.name);
	}
	return names;
}

export function diffTapes(left: TapeFile, right: TapeFile): DiffReport {
	const leftTurns = conversationEntries(left);
	const rightTurns = conversationEntries(right);

	let commonPrefix = 0;
	while (commonPrefix < leftTurns.length && commonPrefix < rightTurns.length) {
		const a = leftTurns[commonPrefix] as SessionEntry;
		const b = rightTurns[commonPrefix] as SessionEntry;
		if (entryFingerprint(a) !== entryFingerprint(b)) break;
		commonPrefix++;
	}

	let firstDivergence: Divergence | undefined;
	if (commonPrefix < leftTurns.length || commonPrefix < rightTurns.length) {
		const a = leftTurns[commonPrefix];
		const b = rightTurns[commonPrefix];
		firstDivergence = {
			index: commonPrefix,
			left: a,
			right: b,
			reason: a === undefined ? "right-only" : b === undefined ? "left-only" : "content",
		};
	}

	return {
		leftId: left.id,
		rightId: right.id,
		commonPrefix,
		leftTurns: leftTurns.length,
		rightTurns: rightTurns.length,
		firstDivergence,
		toolSequenceLeft: toolSequence(leftTurns),
		toolSequenceRight: toolSequence(rightTurns),
		costLeft: left.stats.costUsd,
		costRight: right.stats.costUsd,
	};
}

function describe(entry: SessionEntry | undefined): string {
	if (!entry) return "(nothing)";
	const message = messageOf(entry);
	if (!message) return entry.type;
	const parts = contentBlocks(message)
		.map((block) => {
			if (block.type === "text") return String(block.text ?? "").replace(/\s+/g, " ").slice(0, 120);
			if (block.type === "thinking") return "[thinking]";
			if (block.type === "toolCall") return `→ ${String(block.name)} ${JSON.stringify(block.arguments ?? {}).slice(0, 80)}`;
			return `[${block.type}]`;
		})
		.filter(Boolean);
	return `${message.role}: ${parts.join(" ")}`;
}

export function formatDiff(report: DiffReport): string {
	const lines: string[] = [];
	const add = (text = "") => lines.push(text);

	add(`left  ${report.leftId.slice(0, 19)}  ${report.leftTurns} turns  $${report.costLeft.toFixed(4)}`);
	add(`right ${report.rightId.slice(0, 19)}  ${report.rightTurns} turns  $${report.costRight.toFixed(4)}`);
	add();

	const identical = !report.firstDivergence;
	if (identical) {
		add(`✓ the two runs are identical across all ${report.commonPrefix} turns`);
		return lines.join("\n");
	}

	add(`shared prefix: ${report.commonPrefix} turns`);
	add(`first divergence at turn ${report.firstDivergence?.index} (${report.firstDivergence?.reason})`);
	add();

	const divergence = report.firstDivergence as Divergence;
	add(`  left  #${divergence.index}  ${describe(divergence.left)}`);
	add(`  right #${divergence.index}  ${describe(divergence.right)}`);
	add();

	// Report the first structural tool divergence, which is usually the real cause.
	const leftTools = report.toolSequenceLeft;
	const rightTools = report.toolSequenceRight;
	let toolDivergence = 0;
	while (toolDivergence < leftTools.length && toolDivergence < rightTools.length) {
		if (leftTools[toolDivergence] !== rightTools[toolDivergence]) break;
		toolDivergence++;
	}
	if (toolDivergence < leftTools.length || toolDivergence < rightTools.length) {
		add(`tool sequences diverge at call #${toolDivergence}`);
		add(`  left  ${leftTools[toolDivergence] ?? "(end)"}`);
		add(`  right ${rightTools[toolDivergence] ?? "(end)"}`);
		add();
		add(`  left  sequence: ${leftTools.join(" → ") || "(none)"}`);
		add(`  right sequence: ${rightTools.join(" → ") || "(none)"}`);
	}

	return lines.join("\n");
}
