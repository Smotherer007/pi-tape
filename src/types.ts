/**
 * Tolerant type definitions for pi session files and the `.tape` save-state format.
 *
 * Design rule: we are a debugger. Unknown entry types, unknown message roles and
 * unknown content blocks must survive a capture/replay round-trip untouched, so
 * almost everything here is deliberately open-ended rather than a closed union.
 */

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

/** A content block inside a message. Unknown block types are preserved as-is. */
export interface ContentBlock {
	type: string;
	[key: string]: unknown;
}

/** A message as stored in a session entry. Unknown roles are preserved as-is. */
export interface SessionMessage {
	role: string;
	content?: string | ContentBlock[];
	[key: string]: unknown;
}

/**
 * Base shape of every session entry except the header.
 * See docs/session-format.md in the pi package.
 */
export interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

export interface SessionHeader {
	type: "session";
	version?: number;
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
	[key: string]: unknown;
}

export interface SessionFile {
	path: string;
	header: SessionHeader;
	/** Entries in file order (which is append order, not tree order). */
	entries: SessionEntry[];
	byId: Map<string, SessionEntry>;
	/** Child ids per parent id, in file order. */
	children: Map<string, string[]>;
	/** Entry ids with no children. */
	leaves: string[];
}

export interface TapeSource {
	sessionFile: string;
	sessionId: string;
	cwd: string;
	piVersion?: string;
	/** The leaf this capture was taken from; replay follows its ancestry. */
	leafId: string | null;
}

export interface TapeStats {
	entries: number;
	messages: number;
	userMessages: number;
	assistantMessages: number;
	toolResults: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
	tools: string[];
	models: string[];
}

export type TapeProfile = "full" | "normal" | "minimal";

export interface TapeFile {
	magic: "pi-tape";
	version: 1;
	/** Content address over the canonical encoding of `entries`. */
	id: string;
	created: string;
	name?: string;
	profile: TapeProfile;
	/** True when capture dropped information, so replay is not bit-faithful. */
	lossy: boolean;
	/** Human-readable list of everything the capture dropped. */
	dropped: string[];
	source: TapeSource;
	stats: TapeStats;
	/** Deduplication pool for large repeated strings; entries reference it by index. */
	dict: string[];
	entries: TapeEntry[];
}

/**
 * A captured entry. Entries keep their original shape; large strings may be
 * replaced by a `{"$d": <dict index>}` reference, which `resolveEntry()`
 * expands again.
 */
export type TapeEntry = SessionEntry;

export interface DictRef {
	$d: number;
}

export function isDictRef(value: unknown): value is DictRef {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as DictRef).$d === "number" &&
		Object.keys(value as object).length === 1
	);
}

/** Result of a single replay lookup. */
export type ReplayOutcome =
	| { kind: "hit"; via: "hash" | "cursor"; entry: SessionEntry }
	| { kind: "miss"; reason: string };
