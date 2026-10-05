/**
 * The `.tape` save-state format.
 *
 * A tape is a single gzip-compressed JSON file that contains everything
 * needed to re-run a session deterministically: the request prefix, the recorded
 * model answers, the tool results and the tool declarations. It is portable, so
 * you can hand it to someone else and they can inspect or replay your run
 * without an API key and without spending a token.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { stableStringify } from "./hash.ts";
import type { JsonValue, TapeEntry, TapeFile, TapeProfile } from "./types.ts";
import { isDictRef } from "./types.ts";

export const TAPE_MAGIC = "pi-tape";
export const TAPE_VERSION = 1;
export const TAPE_EXTENSION = ".tape";

/** Strings at least this long are moved into the deduplication pool. */
export const DICT_MIN_LENGTH = 256;

/** Tool results are truncated to this many characters in the `minimal` profile. */
export const MINIMAL_TOOL_RESULT_CHARS = 4000;

export class TapeFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TapeFormatError";
	}
}

// ---------------------------------------------------------------------------
// Dictionary (compression support)
// ---------------------------------------------------------------------------

interface DictResult {
	value: JsonValue;
	dict: string[];
}

function internDict(value: unknown, dict: string[], seen: Map<string, number>): JsonValue {
	if (typeof value === "string") {
		if (value.length < DICT_MIN_LENGTH) return value;
		const existing = seen.get(value);
		if (existing !== undefined) return { $d: existing };
		const index = dict.length;
		dict.push(value);
		seen.set(value, index);
		return { $d: index };
	}
	if (Array.isArray(value)) return value.map((item) => internDict(item, dict, seen));
	if (value && typeof value === "object") {
		const out: Record<string, JsonValue> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (item === undefined) continue;
			out[key] = internDict(item, dict, seen);
		}
		return out;
	}
	if (value === undefined) return null;
	return value as JsonValue;
}

/** Replace long strings with dictionary references so repeats are stored once. */
export function buildDictionary(entries: TapeEntry[]): DictResult {
	const dict: string[] = [];
	const seen = new Map<string, number>();
	const value = internDict(entries, dict, seen) as JsonValue;
	return { value, dict };
}

function expandDictionary(value: unknown, dict: string[]): unknown {
	if (isDictRef(value)) {
		const resolved = dict[value.$d];
		if (resolved === undefined) {
			throw new TapeFormatError(`dictionary reference $d:${value.$d} is out of range`);
		}
		return resolved;
	}
	if (Array.isArray(value)) return value.map((item) => expandDictionary(item, dict));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = expandDictionary(item, dict);
		}
		return out;
	}
	return value;
}

/** Expand dictionary references back into full entries. Returns a deep copy. */
export function resolveEntries(tape: TapeFile, entries: TapeEntry[] = tape.entries): TapeEntry[] {
	return expandDictionary(entries, tape.dict) as TapeEntry[];
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function tapeId(entries: TapeEntry[]): string {
	return `sha256:${createHash("sha256").update(stableStringify(entries)).digest("hex").slice(0, 32)}`;
}

/** Canonical JSON of the tape body (without the checksum-bearing header fields). */
export function canonicalTape(tape: TapeFile): string {
	return stableStringify({
		magic: tape.magic,
		version: tape.version,
		profile: tape.profile,
		source: tape.source,
		stats: tape.stats,
		dict: tape.dict,
		entries: tape.entries,
	});
}

/** Serialize a tape to its on-disk representation (gzip of JSON). */
export function packTape(tape: TapeFile): Buffer {
	if (tape.magic !== TAPE_MAGIC) throw new TapeFormatError(`unexpected magic: ${String(tape.magic)}`);
	return gzipSync(Buffer.from(JSON.stringify(tape), "utf8"), { level: 9 });
}

/** Parse a `.tape` payload. Accepts raw JSON too, which makes hand-editing possible. */
export function unpackTape(payload: Buffer | string): TapeFile {
	let json: string;
	const buffer = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;

	if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
		try {
			json = gunzipSync(buffer).toString("utf8");
		} catch (error) {
			throw new TapeFormatError(`gzip decompression failed: ${(error as Error).message}`);
		}
	} else {
		json = buffer.toString("utf8");
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		throw new TapeFormatError(`invalid JSON: ${(error as Error).message}`);
	}

	return validateTape(parsed);
}

export function validateTape(value: unknown): TapeFile {
	if (typeof value !== "object" || value === null) {
		throw new TapeFormatError("tape is not an object");
	}
	const tape = value as Partial<TapeFile>;

	if (tape.magic !== TAPE_MAGIC) {
		throw new TapeFormatError(
			`not a tape: expected magic "${TAPE_MAGIC}", got ${JSON.stringify(tape.magic)}`,
		);
	}
	if (tape.version !== TAPE_VERSION) {
		throw new TapeFormatError(`unsupported tape version ${String(tape.version)} (this build reads v${TAPE_VERSION})`);
	}
	if (!Array.isArray(tape.entries)) throw new TapeFormatError("`entries` must be an array");
	if (!Array.isArray(tape.dict)) throw new TapeFormatError("`dict` must be an array");
	if (!tape.source || typeof tape.source !== "object") throw new TapeFormatError("`source` is missing");
	if (!tape.stats || typeof tape.stats !== "object") throw new TapeFormatError("`stats` is missing");

	return tape as TapeFile;
}

export function writeTape(path: string, tape: TapeFile): void {
	writeFileSync(path, packTape(tape));
}

export function readTape(path: string): TapeFile {
	return unpackTape(readFileSync(path));
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export type { TapeProfile };
