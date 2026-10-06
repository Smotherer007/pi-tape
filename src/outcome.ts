/**
 * How a run ended.
 *
 * Without this, a family of recordings cannot be told apart: intersecting three
 * successful runs and one that failed halfway produces a skeleton of the failure,
 * and the recipe looks exactly as confident either way. So the outcome is derived
 * at record time, carried into the recipe, and used to keep failed recordings out
 * of the skeleton while still counting them.
 *
 * The rule is the same one the freshness check uses: silence is never success.
 * A run with no verification and no error is `unknown`, not `success`, because
 * "nothing complained" is not evidence that anything was achieved.
 */

import type { SessionEntry, TapeOutcome, TapeOutcomeStatus } from "./types.ts";
import type { OutcomeStatus } from "./recipe-types.ts";
import { messageOf, toolCallsOf } from "./session.ts";
import { redactText } from "./redact.ts";

/**
 * Commands that assert something about the result rather than producing it.
 *
 * `npm run build` counts: a green build is the closest thing to a verification
 * many repositories have, and a red one is unambiguous.
 */
const VERIFY_COMMAND =
	/^(npm|pnpm|yarn|bun)\s+(test|run\s+(test|tests|build|lint|typecheck|check|verify))(\s|$)|^(pytest|jest|vitest|rspec|ctest|gotestsum)(\s|$)|^(cargo|go)\s+(test|build|check|vet)(\s|$)|^make(\s|$)|^tsc(\s|$)|^(mvn|gradle|\.\/gradlew)\s+(test|verify|build)(\s|$)|^dotnet\s+test(\s|$)/;

const MAX_EVIDENCE = 6;
const MAX_EVIDENCE_CHARS = 140;

interface ObservedResult {
	toolName: string;
	isError: boolean;
	/** The command this result answered, when it answered a bash call. */
	command?: string;
}

function summarize(text: string): string {
	const line = redactText(text.trim().split("\n")[0] ?? "");
	return line.length > MAX_EVIDENCE_CHARS ? `${line.slice(0, MAX_EVIDENCE_CHARS)}…` : line;
}

/** Pair every tool call with its result, in recording order. */
export function observeResults(entries: SessionEntry[]): ObservedResult[] {
	const commandByCallId = new Map<string, string>();
	const results: ObservedResult[] = [];

	for (const entry of entries) {
		for (const call of toolCallsOf(entry)) {
			const args = (call.arguments ?? {}) as Record<string, unknown>;
			if (call.name === "bash" && typeof args.command === "string") commandByCallId.set(call.id, args.command);
		}

		const message = messageOf(entry);
		if (!message || message.role !== "toolResult") continue;
		const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
		results.push({
			toolName: typeof message.toolName === "string" ? message.toolName : "tool",
			isError: message.isError === true,
			command: callId ? commandByCallId.get(callId) : undefined,
		});
	}

	return results;
}

/**
 * Decide how a recording ended.
 *
 * A human's declaration always wins: a run can be successful for a reason no
 * command in it expresses.
 */
export function deriveOutcome(entries: SessionEntry[], declared?: TapeOutcomeStatus): TapeOutcome {
	const results = observeResults(entries);
	const failed = results.filter((result) => result.isError);

	if (declared) {
		return { status: declared, evidence: [`declared ${declared} by the caller`], declared: true };
	}

	// The *last* verification is what counts: a failed step that was then fixed and
	// followed by a green build is a successful run, and calling it failed would
	// throw away the retry that made it work.
	const verification = [...results].reverse().find((result) => result.command && VERIFY_COMMAND.test(result.command.trim()));

	if (verification) {
		const earlier = failed.length ? [`${failed.length} tool error(s) earlier in the run`] : [];
		return verification.isError
			? { status: "failed", evidence: [`verification failed: ${summarize(verification.command as string)}`, ...earlier] }
			: { status: "success", evidence: [`verification succeeded: ${summarize(verification.command as string)}`, ...earlier] };
	}

	if (failed.length) {
		const tools = [...new Set(failed.map((result) => result.toolName))].slice(0, 3);
		return {
			status: "failed",
			evidence: [
				`${failed.length} tool error(s), nothing verified afterwards`,
				...tools.map((tool) => `${tool} returned an error`),
			].slice(0, MAX_EVIDENCE),
		};
	}

	return {
		status: "unknown",
		evidence: ["no verification command and no tool error — absence of errors is not success"],
	};
}

/** True when a status should be kept out of a skeleton. */
export function isFailure(status: TapeOutcomeStatus | undefined): boolean {
	return status === "failed";
}

/** An input to the combined outcome: a tape's or a recipe's own verdict. */
export interface OutcomeLike {
	status: OutcomeStatus;
	evidence?: string[];
}

export interface CombinedOutcome {
	status: OutcomeStatus;
	successes: number;
	failures: number;
	evidence: string[];
}

/** Collapse the outcomes of a family into one. */
export function combineOutcomes(
	outcomes: Array<OutcomeLike | undefined>,
	extraEvidence: string[] = [],
): CombinedOutcome {
	const statuses = outcomes.map((outcome) => outcome?.status ?? "unknown");
	const successes = statuses.filter((status) => status === "success").length;
	const failures = statuses.filter((status) => status === "failed").length;

	let status: OutcomeStatus;
	if (statuses.length === 0) status = "unknown";
	else if (failures === statuses.length) status = "failed";
	else if (successes === statuses.length) status = "success";
	else if (successes > 0) status = "mixed";
	else if (failures > 0) status = "mixed";
	else status = "unknown";

	const evidence = [...new Set([...extraEvidence, ...outcomes.flatMap((outcome) => outcome?.evidence ?? [])])].slice(
		0,
		MAX_EVIDENCE,
	);

	return { status, successes, failures, evidence };
}
