/**
 * Parsing and tree navigation for pi session files.
 *
 * A session file is append-only JSONL. The first line is a header, every later
 * line is an entry with `id`/`parentId`, which together form a tree (v2+).
 * Replay follows one root-to-leaf path; branching is what makes forks possible.
 */

import { readFileSync } from "node:fs";
import type { ContentBlock, SessionEntry, SessionFile, SessionHeader, SessionMessage } from "./types.ts";

export class SessionParseError extends Error {
	readonly line?: number;

	constructor(message: string, line?: number) {
		super(line === undefined ? message : `${message} (line ${line + 1})`);
		this.name = "SessionParseError";
		this.line = line;
	}
}

/** Parse a session JSONL file from disk. */
export function readSession(path: string): SessionFile {
	return parseSession(readFileSync(path, "utf8"), path);
}

/** Parse session JSONL content. `path` is only used for diagnostics. */
export function parseSession(text: string, path = "<memory>"): SessionFile {
	const lines = text.split("\n");
	const entries: SessionEntry[] = [];
	let header: SessionHeader | undefined;

	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]?.trim();
		if (!raw) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new SessionParseError(`invalid JSON: ${(error as Error).message}`, i);
		}
		if (typeof parsed !== "object" || parsed === null) {
			throw new SessionParseError("line is not a JSON object", i);
		}

		const obj = parsed as Record<string, unknown>;
		if (obj.type === "session" && header === undefined) {
			header = obj as unknown as SessionHeader;
			continue;
		}
		if (typeof obj.id !== "string") {
			throw new SessionParseError("entry is missing a string `id`", i);
		}
		entries.push({
			...obj,
			type: typeof obj.type === "string" ? obj.type : "unknown",
			id: obj.id,
			parentId: typeof obj.parentId === "string" ? obj.parentId : null,
			timestamp: typeof obj.timestamp === "string" ? obj.timestamp : "",
		} as SessionEntry);
	}

	if (!header) {
		throw new SessionParseError("missing session header (first line must be a `session` entry)");
	}

	const byId = new Map<string, SessionEntry>();
	const children = new Map<string, string[]>();
	for (const entry of entries) {
		// Later duplicates win, mirroring "last write on the active branch" semantics.
		byId.set(entry.id, entry);
	}
	const leaves: string[] = [];
	for (const entry of entries) {
		const siblings = children.get(entry.parentId ?? "");
		if (siblings) siblings.push(entry.id);
		else children.set(entry.parentId ?? "", [entry.id]);
	}
	for (const entry of entries) {
		if (!children.has(entry.id)) leaves.push(entry.id);
	}

	return { path, header, entries, byId, children, leaves };
}

/**
 * Ancestry from root to `leafId` inclusive.
 * Unknown or dangling parent ids terminate the walk rather than throwing, because
 * a partially copied session file is still worth debugging.
 */
export function pathToLeaf(session: SessionFile, leafId: string | null): SessionEntry[] {
	if (!leafId) return [];
	const out: SessionEntry[] = [];
	const seen = new Set<string>();
	let cursor: string | null = leafId;

	while (cursor) {
		if (seen.has(cursor)) {
			throw new SessionParseError(`cycle in session tree at entry ${cursor}`);
		}
		seen.add(cursor);
		const entry: SessionEntry | undefined = session.byId.get(cursor);
		if (!entry) break;
		out.push(entry);
		cursor = entry.parentId;
	}
	out.reverse();
	return out;
}

/**
 * Extension point: pi stores the *latest* leaf conceptually, but a file can hold
 * several. We pick the last entry in file order that has no children, which is
 * the branch the session was last written on.
 */
export function activeLeaf(session: SessionFile): string | null {
	for (let i = session.entries.length - 1; i >= 0; i--) {
		const entry = session.entries[i];
		if (entry && session.leaves.includes(entry.id)) return entry.id;
	}
	return session.leaves[0] ?? null;
}

/** Direct children of an entry id (or of the roots when `null`). */
export function childIds(session: SessionFile, id: string | null): string[] {
	return session.children.get(id ?? "") ?? [];
}

/** Entries on the path that have more than one child: the forkable points. */
export function branchPoints(session: SessionFile, leafId?: string | null): SessionEntry[] {
	const leaf = leafId === undefined ? activeLeaf(session) : leafId;
	return pathToLeaf(session, leaf).filter((entry) => childIds(session, entry.id).length > 1);
}

export function isMessageEntry(entry: SessionEntry): boolean {
	return entry.type === "message";
}

export function messageOf(entry: SessionEntry): SessionMessage | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (typeof message !== "object" || message === null) return undefined;
	const role = (message as Record<string, unknown>).role;
	if (typeof role !== "string") return undefined;
	return message as SessionMessage;
}

export function roleOf(entry: SessionEntry): string | undefined {
	return messageOf(entry)?.role;
}

/** Normalize `content` to an array of blocks. Strings become a single text block. */
export function contentBlocks(message: SessionMessage | undefined): ContentBlock[] {
	if (!message) return [];
	const content = message.content;
	if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
	if (Array.isArray(content)) return content as ContentBlock[];
	return [];
}

/** Tool calls contained in an assistant message. */
export function toolCallsOf(entry: SessionEntry): Array<{ id: string; name: string; arguments: unknown }> {
	const message = messageOf(entry);
	if (!message || message.role !== "assistant") return [];
	return contentBlocks(message)
		.filter((block) => block.type === "toolCall")
		.map((block) => ({
			id: String(block.id ?? ""),
			name: String(block.name ?? ""),
			arguments: block.arguments ?? {},
		}));
}

/** Concatenated text of a message, for previews and reports. */
export function textOf(message: SessionMessage | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return contentBlocks(message)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

/** Root entry ids of the session, in file order. */
export function rootIds(session: SessionFile): string[] {
	return childIds(session, null);
}
