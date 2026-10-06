/**
 * Capture a session branch into a tape.
 *
 * Capture follows one root-to-leaf path. A save-state describes a *run*, not a
 * whole session file, because replay can only follow one history. Branch points
 * are reported so you can capture the other arm explicitly if you want it.
 */

import type {
	TapeEntry,
	TapeFile,
	TapeOutcomeStatus,
	TapeProfile,
	TapeSource,
	SessionEntry,
	SessionFile,
} from "./types.ts";
import { activeLeaf, branchPoints, pathToLeaf } from "./session.ts";
import { buildDictionary, DICT_MIN_LENGTH, MINIMAL_TOOL_RESULT_CHARS, tapeId } from "./tape.ts";
import { computeStats } from "./stats.ts";
import { deriveOutcome } from "./outcome.ts";
import { redactEntries, REDACTED_MARK } from "./redact.ts";

export interface RecordOptions {
	profile?: TapeProfile;
	name?: string;
	/** Capture this leaf's ancestry instead of the session's active leaf. */
	leafId?: string | null;
	piVersion?: string;
	/** Declare how the run ended, overriding what the recorder can infer. */
	status?: TapeOutcomeStatus;
	/**
	 * Replace every credential in the recording with `[redacted]`. This is what makes
	 * a tape safe to hand to someone else, and it is lossy by definition: a redacted
	 * tape is no longer the same run.
	 */
	redact?: boolean;
}

const MINIMAL_DROP_TYPES = new Set(["usage", "label", "session_info"]);

export interface RecordResult {
	tape: TapeFile;
	/** Entries on the captured path, before any profile transformation. */
	path: SessionEntry[];
	branchPoints: number;
}

export function recordSession(session: SessionFile, options: RecordOptions = {}): RecordResult {
	const profile = options.profile ?? "normal";
	const leafId = options.leafId === undefined ? activeLeaf(session) : options.leafId;

	if (!leafId) {
		throw new Error("session has no entries to record");
	}

	const path = pathToLeaf(session, leafId);
	const forks = branchPoints(session, leafId);

	const dropped: string[] = [];
	let lossy = false;

	let entries: TapeEntry[] = path.map((entry) => structuredClone(entry) as TapeEntry);

	if (profile === "minimal") {
		const before = entries.length;
		entries = entries.filter((entry) => !MINIMAL_DROP_TYPES.has(entry.type));
		const removed = before - entries.length;
		if (removed > 0) {
			dropped.push(`${removed} non-context entries (usage/label/session_info)`);
			lossy = true;
		}

		let thinkingBlocks = 0;
		let truncatedResults = 0;

		for (const entry of entries) {
			const message = entry.message as Record<string, unknown> | undefined;
			if (!message || !Array.isArray(message.content)) continue;

			const kept = [];
			for (const block of message.content as Array<Record<string, unknown>>) {
				if (block.type === "thinking") {
					thinkingBlocks++;
					continue;
				}
				if (
					message.role === "toolResult" &&
					block.type === "text" &&
					typeof block.text === "string" &&
					block.text.length > MINIMAL_TOOL_RESULT_CHARS
				) {
					truncatedResults++;
					kept.push({
						...block,
						text:
							block.text.slice(0, MINIMAL_TOOL_RESULT_CHARS) +
							`\n\n[tape: truncated, ${block.text.length - MINIMAL_TOOL_RESULT_CHARS} characters dropped]`,
					});
					continue;
				}
				kept.push(block);
			}
			message.content = kept;

			// `details` and `nestedCalls` are rendering/telemetry, not context.
			if (message.role === "toolResult") {
				delete message.details;
				delete message.nestedCalls;
				delete message.usage;
			}
			if (message.role === "assistant") {
				delete message.diagnostics;
			}
		}

		if (thinkingBlocks > 0) {
			dropped.push(`${thinkingBlocks} thinking blocks`);
			lossy = true;
		}
		if (truncatedResults > 0) {
			dropped.push(`${truncatedResults} tool results truncated to ${MINIMAL_TOOL_RESULT_CHARS} chars`);
			lossy = true;
		}
	}

	if (options.redact) {
		// After the profile transform and before the string pool: nothing pooled and
		// nothing referenced may still hold a credential.
		const result = redactEntries(entries);
		entries = result.entries;
		if (result.redactions > 0) {
			dropped.push(`${result.redactions} credential(s) replaced by ${REDACTED_MARK}`);
			lossy = true;
		}
	}

	const { value, dict } = buildDictionary(entries);
	const dictedEntries = value as TapeEntry[];
	const resolvedStats = computeStats(entries);
	// Derived from the entries the tape actually carries, so the outcome and the
	// recording cannot disagree.
	const outcome = deriveOutcome(entries, options.status);

	const source: TapeSource = {
		sessionFile: session.path,
		sessionId: session.header.id,
		cwd: session.header.cwd,
		piVersion: options.piVersion,
		leafId,
	};

	const tape: TapeFile = {
		magic: "pi-tape",
		version: 1,
		id: tapeId(dictedEntries),
		created: new Date().toISOString(),
		name: options.name,
		profile,
		lossy,
		dropped,
		source,
		stats: resolvedStats,
		outcome,
		dict,
		entries: dictedEntries,
	};

	return { tape, path, branchPoints: forks.length };
}

/** Entries that are not worth shipping inside a tape; useful for size reporting. */
export function dictionarySavings(tape: TapeFile): { poolStrings: number; poolChars: number; minLength: number } {
	return {
		poolStrings: tape.dict.length,
		poolChars: tape.dict.reduce((sum, item) => sum + item.length, 0),
		minLength: DICT_MIN_LENGTH,
	};
}
