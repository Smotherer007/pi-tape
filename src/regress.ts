/**
 * Regression across a model change: what does a different model do with the same
 * requests?
 *
 * This is the question a recorded run is uniquely able to answer, and the one a
 * replay cannot: replay serves the recorded answers, so it proves the recording is
 * intact, not that the new model behaves. The missing half is asking the *new*
 * model the *same* request and comparing.
 *
 * Comparison is a pure function of two answers, deliberately fuzzy about wording
 * and strict about structure. A different sentence is a curiosity; a different tool
 * call is a different procedure. Anything finer than that — "is this answer
 * better?" — is a judgement no diff can make, and this module does not pretend
 * otherwise.
 */

import { contentBlocks, messageOf } from "./session.ts";
import type { SessionEntry } from "./types.ts";
import { stableStringify } from "./hash.ts";
import { analyzeCommand, isNoiseCommand } from "./normalize.ts";
import { splitSequence } from "./recipe-extract.ts";
import { isReadOnlyTool } from "./replay.ts";

export interface ToolCallShape {
	name: string;
	/** Arguments, canonically stringified so key order cannot fake a difference. */
	arguments: string;
}

export interface AnswerShape {
	text: string;
	toolCalls: ToolCallShape[];
	stopReason?: string;
	/** Set when the live model failed outright. */
	error?: string;
}

/**
 * `inspection`: the calls differ, but only in what was looked at — `ls -la` against
 * `ls`, a `read` of one file more. A model words its reconnaissance differently every
 * time; counting that as a different procedure made every comparison noisy.
 */
export type DivergenceKind = "text" | "inspection" | "toolCalls" | "stopReason" | "error";

export interface Divergence {
	kind: DivergenceKind;
	detail: string;
	recorded: string;
	live: string;
}

/** The comparable shape of an assistant answer, from an entry or a bare message. */
export function shapeOf(source: SessionEntry | Record<string, unknown> | undefined): AnswerShape {
	const message = (source && "type" in (source as SessionEntry) ? messageOf(source as SessionEntry) : source) as
		| Record<string, unknown>
		| undefined;
	if (!message) return { text: "", toolCalls: [] };

	const blocks = contentBlocks(message as never);
	const text = blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => (block.text as string).trim())
		.filter(Boolean)
		.join("\n");
	const toolCalls = blocks
		.filter((block) => block.type === "toolCall")
		.map((block) => ({
			name: String(block.name ?? ""),
			// pi records unset optional parameters as null; a model leaves them out.
			arguments: stableStringify(dropEmpty(block.arguments ?? {}) as never),
		}));

	const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	const error = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
	return error === undefined ? { text, toolCalls, stopReason } : { text, toolCalls, stopReason, error };
}

/** Collapse whitespace so a re-wrapped sentence is not called a difference. */
function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function describeCalls(calls: ToolCallShape[]): string {
	if (!calls.length) return "(no tool call)";
	return calls.map((call) => `${call.name}(${call.arguments})`).join(", ");
}

/**
 * Compare two answers, structurally.
 *
 * Ordered so the most consequential difference is reported first: a different tool
 * call changes what will happen, a different sentence usually does not.
 */
export function compareAnswers(recorded: AnswerShape, live: AnswerShape): Divergence[] {
	const divergences: Divergence[] = [];

	if (live.error && !recorded.error) {
		divergences.push({
			kind: "error",
			detail: "the new model failed where the recording succeeded",
			recorded: "(answered)",
			live: live.error,
		});
	}

	const recordedCalls = describeCalls(recorded.toolCalls);
	const liveCalls = describeCalls(live.toolCalls);
	if (recordedCalls !== liveCalls && effectiveActions(recorded.toolCalls) === effectiveActions(live.toolCalls)) {
		divergences.push({
			kind: "inspection",
			detail: "only what it looked at differs; the actions are the same",
			recorded: recordedCalls,
			live: liveCalls,
		});
	} else if (recordedCalls !== liveCalls) {
		divergences.push({
			kind: "toolCalls",
			detail:
				live.toolCalls.length !== recorded.toolCalls.length
					? `different number of tool calls (${recorded.toolCalls.length} → ${live.toolCalls.length})`
					: "same number of tool calls, different calls",
			recorded: recordedCalls,
			live: liveCalls,
		});
	}

	const recordedText = normalizeText(recorded.text);
	const liveText = normalizeText(live.text);
	if (recordedText !== liveText) {
		divergences.push({
			kind: "text",
			detail: "the wording differs",
			recorded: excerpt(recordedText),
			live: excerpt(liveText),
		});
	}

	if (recorded.stopReason !== live.stopReason && (recorded.stopReason || live.stopReason)) {
		divergences.push({
			kind: "stopReason",
			detail: "the turn ended differently",
			recorded: recorded.stopReason ?? "(none)",
			live: live.stopReason ?? "(none)",
		});
	}

	return divergences;
}

/**
 * The calls that act, in order: read-only tools and reconnaissance commands (`ls`,
 * `cat`, `echo`…) left out, a shell line split into its commands. Values are kept
 * verbatim — deploying `billing` instead of `web` is a different action.
 */
function effectiveActions(calls: ToolCallShape[]): string {
	const actions: string[] = [];
	for (const call of calls) {
		if (isReadOnlyTool(call.name)) continue;
		let args: Record<string, unknown> = {};
		try {
			args = JSON.parse(call.arguments) as Record<string, unknown>;
		} catch {}
		if (call.name === "bash" && typeof args.command === "string") {
			for (const segment of splitSequence(args.command)) {
				if (isNoiseCommand(analyzeCommand(segment).key)) continue;
				actions.push(`bash ${segment.replace(/\s+/g, " ").trim()}`);
			}
			continue;
		}
		actions.push(`${call.name} ${call.arguments}`);
	}
	return actions.join("\n");
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

function excerpt(text: string, limit = 120): string {
	const collapsed = normalizeText(text);
	return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed || "(empty)";
}

export interface RegressionSample {
	/** Which request this was, for a report a human can navigate. */
	label: string;
	divergences: Divergence[];
}

export interface RegressionReport {
	tape: string;
	recordedModel: string;
	/** The model the requests were replayed against. */
	liveModel: string;
	samples: RegressionSample[];
	/** Requests whose answers differ in structure. */
	structuralDivergences: number;
	/** Requests whose answers differ only in wording. */
	wordingDivergences: number;
	identical: number;
	/** Tokens the comparison cost, i.e. what the new model was actually asked. */
	liveTokens: number;
}

const SURFACE: ReadonlySet<DivergenceKind> = new Set(["text", "inspection"]);

export function summarizeRegression(report: RegressionReport): RegressionReport {
	report.structuralDivergences = report.samples.filter((sample) =>
		sample.divergences.some((divergence) => !SURFACE.has(divergence.kind)),
	).length;
	report.wordingDivergences = report.samples.filter(
		(sample) => sample.divergences.length > 0 && sample.divergences.every((divergence) => SURFACE.has(divergence.kind)),
	).length;
	report.identical = report.samples.filter((sample) => sample.divergences.length === 0).length;
	return report;
}

/**
 * Format the report so the interesting number is impossible to miss.
 *
 * "How many turns changed" is the question, and the answer is only meaningful
 * split into structural (a different action) and wording (the same action, said
 * otherwise), because the first is a different procedure and the second is not.
 */
export function formatRegression(report: RegressionReport): string {
	const lines: string[] = [];
	lines.push(`${report.tape}: ${report.recordedModel} → ${report.liveModel}`);
	lines.push(
		`  ${report.samples.length} request(s) · ${report.identical} identical · ` +
			`${report.structuralDivergences} structurally different · ${report.wordingDivergences} only reworded or inspected differently`,
	);
	if (report.liveTokens > 0) lines.push(`  the comparison itself cost ${report.liveTokens} tokens`);

	const interesting = report.samples.filter((sample) =>
		sample.divergences.some((divergence) => !SURFACE.has(divergence.kind)),
	);
	if (interesting.length) {
		lines.push("");
		lines.push("structurally different requests:");
		for (const sample of interesting) {
			lines.push(`  ${sample.label}`);
			for (const divergence of sample.divergences) {
				lines.push(`    [${divergence.kind}] ${divergence.detail}`);
				if (!SURFACE.has(divergence.kind)) {
					lines.push(`      recorded: ${divergence.recorded}`);
					lines.push(`      new:      ${divergence.live}`);
				}
			}
		}
	}

	const reworded = report.samples.filter(
		(sample) => sample.divergences.length > 0 && sample.divergences.every((divergence) => SURFACE.has(divergence.kind)),
	);
	if (reworded.length) {
		lines.push("");
		lines.push(`${reworded.length} request(s) differ only in wording: ${reworded.map((s) => s.label).join(", ")}`);
	}

	return lines.join("\n");
}
