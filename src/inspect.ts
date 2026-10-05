/**
 * Human-readable inspection of a tape. This is the "what happened, what did
 * it cost, what ate my context" view that a plain session dump does not give you.
 */

import type { TapeFile, SessionEntry } from "./types.ts";
import { contextHogs, toolWeights } from "./stats.ts";
import { formatBytes, resolveEntries } from "./tape.ts";
import { verifyRecording } from "./replay.ts";
import { contentBlocks, messageOf, toolCallsOf } from "./session.ts";

function preview(entry: SessionEntry, width = 72): string {
	const message = messageOf(entry);
	if (!message) return entry.type;
	const blocks = contentBlocks(message);
	const parts: string[] = [];
	for (const block of blocks) {
		if (typeof block.text === "string" && block.text) parts.push(block.text.replace(/\s+/g, " "));
		else if (block.type === "thinking") parts.push("[thinking]");
		else if (block.type === "image") parts.push("[image]");
		else if (block.type === "toolCall") parts.push(`→ ${String(block.name)}`);
	}
	if (!parts.length && message.role === "toolResult") {
		parts.push(String(message.toolName ?? "tool"));
	}
	const text = parts.join(" ").trim();
	return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

export interface InspectOptions {
	/** Include a per-turn timeline. */
	timeline?: boolean;
	/** Max timeline entries to print. */
	limit?: number;
	/** Verify the recording while inspecting. */
	verify?: boolean;
	/** Compressed size on disk, for the size report. */
	bytes?: number;
}

export function inspectTape(tape: TapeFile, options: InspectOptions = {}): string {
	const lines: string[] = [];
	const add = (text = "") => lines.push(text);

	const resolved = resolveEntries(tape);

	add(`╭─ tape ${tape.name ? `"${tape.name}" ` : ""}${tape.id.slice(0, 19)}`);
	add(`│ format      pi-tape v${tape.version} (profile: ${tape.profile}${tape.lossy ? ", LOSSY" : ""})`);
	add(`│ created     ${tape.created}`);
	add(`│ source      ${tape.source.sessionFile}`);
	add(`│ session     ${tape.source.sessionId}  cwd: ${tape.source.cwd}`);
	if (tape.source.piVersion) add(`│ pi          v${tape.source.piVersion}`);
	if (options.bytes !== undefined) {
		const poolChars = tape.dict.reduce((sum, item) => sum + item.length, 0);
		add(
			`│ size        ${formatBytes(options.bytes)} on disk · ${tape.dict.length} pooled strings (${formatBytes(poolChars)} raw) · ${tape.entries.length} entries`,
		);
	}
	add(`╰─`);
	add();

	if (tape.lossy && tape.dropped.length) {
		add("Dropped while recording (playback is not bit-faithful):");
		for (const item of tape.dropped) add(`  · ${item}`);
		add();
	}

	const s = tape.stats;
	add("Run");
	add(`  messages    ${s.messages} (${s.userMessages} user, ${s.assistantMessages} assistant, ${s.toolResults} tool results)`);
	add(`  tokens      ${s.totalTokens.toLocaleString("en-US")} (${s.inputTokens.toLocaleString("en-US")} in / ${s.outputTokens.toLocaleString("en-US")} out)`);
	add(`  cost        $${s.costUsd.toFixed(4)}`);
	if (s.models.length) add(`  models      ${s.models.join(", ")}`);
	add(`  tools       ${s.tools.length ? s.tools.join(", ") : "(none)"}`);
	add();

	const weights = toolWeights(resolved).filter((item) => item.resultChars > 0);
	if (weights.length) {
		add("Context cost per tool (result characters)");
		const max = weights[0]?.resultChars ?? 1;
		for (const item of weights) {
			const bar = "█".repeat(Math.max(1, Math.round((item.resultChars / max) * 24)));
			add(
				`  ${item.tool.padEnd(14)} ${String(item.calls).padStart(3)} calls  ${bar} ${item.resultChars.toLocaleString("en-US")} chars (~${item.tokensApprox.toLocaleString("en-US")} tok)`,
			);
		}
		add();
	}

	const hogs = contextHogs(resolved, 10).filter((hog) => hog.chars > 0);
	if (hogs.length) {
		add("Biggest single context contributors");
		for (const hog of hogs) {
			add(
				`  ${hog.entryId.padEnd(9)} ${hog.label.padEnd(14)} ${hog.chars.toLocaleString("en-US").padStart(9)} chars  ~${hog.tokensApprox.toLocaleString("en-US")} tok   ${preview(resolved.find((e) => e.id === hog.entryId) as SessionEntry, 40)}`,
			);
		}
		add();
	}

	if (options.verify !== false) {
		const result = verifyRecording(tape);
		add("Self-test");
		add(`  ${result.ok ? "✓ tape is complete" : "✗ tape has gaps"}`);
		add(`    assistant events served: ${result.assistantHits}`);
		add(`    tool result events served: ${result.toolHits}`);
		if (result.misses.length) {
			add(`    ${result.misses.length} miss(es):`);
			for (const miss of result.misses.slice(0, 5)) add(`      · [${miss.kind}] ${miss.detail}`);
			if (result.misses.length > 5) add(`      · … and ${result.misses.length - 5} more`);
		}
		add();
	}

	if (options.timeline) {
		const limit = options.limit ?? 40;
		const transcript = resolved.filter((entry) => {
			const role = messageOf(entry)?.role;
			return role === "user" || role === "assistant" || role === "toolResult";
		});
		add(`Timeline (${transcript.length} turns${transcript.length > limit ? `, showing last ${limit}` : ""})`);
		const shown = transcript.slice(-limit);
		for (const entry of shown) {
			const role = messageOf(entry)?.role ?? entry.type;
			const calls = toolCallsOf(entry);
			const suffix = calls.length ? ` [${calls.map((call) => call.name).join(", ")}]` : "";
			add(`  ${entry.id}  ${role.padEnd(10)} ${preview(entry, 56)}${suffix}`);
		}
		add();
	}

	return lines.join("\n");
}
