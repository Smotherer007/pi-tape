/** Locating pi session files on disk. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function agentDir(): string {
	return process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function sessionsRoot(): string {
	return join(agentDir(), "sessions");
}

export interface SessionCandidate {
	path: string;
	sizeBytes: number;
	modified: Date;
	name?: string;
	sessionId?: string;
	cwd?: string;
	preview?: string;
}

/**
 * Read the first two lines of a session file cheaply enough to list hundreds of
 * them: header for metadata, first message for a preview.
 */
export function peekSession(path: string): SessionCandidate {
	const stat = statSync(path);
	let header: Record<string, unknown> | undefined;
	let preview: string | undefined;

	try {
		const text = readFileSync(path, "utf8");
		const lines = text.split("\n");
		if (lines[0]) header = JSON.parse(lines[0]) as Record<string, unknown>;
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type === "session_info" && typeof entry.name === "string") {
				header = { ...header, sessionName: entry.name };
				continue;
			}
			if (entry.type !== "message") continue;
			const message = entry.message as Record<string, unknown> | undefined;
			if (message?.role !== "user") continue;
			const content = message.content;
			const text2 =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content
								.map((block) => (block as Record<string, unknown>).text)
								.filter((value): value is string => typeof value === "string")
								.join(" ")
						: "";
			if (text2) {
				preview = text2.replace(/\s+/g, " ").slice(0, 80);
				break;
			}
		}
	} catch {
		// A partially written or broken session should still be listable.
	}

	return {
		path,
		sizeBytes: stat.size,
		modified: stat.mtime,
		name: typeof header?.sessionName === "string" ? header.sessionName : undefined,
		sessionId: typeof header?.id === "string" ? header.id : undefined,
		cwd: typeof header?.cwd === "string" ? header.cwd : undefined,
		preview,
	};
}

/** All session files, most recently modified first. */
export function listSessions(): SessionCandidate[] {
	const root = sessionsRoot();
	const out: SessionCandidate[] = [];

	let dirs: string[];
	try {
		dirs = readdirSync(root);
	} catch {
		return out;
	}

	for (const dir of dirs) {
		let files: string[];
		try {
			files = readdirSync(join(root, dir));
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(root, dir, file);
			try {
				out.push(peekSession(path));
			} catch {
				// ignore unreadable files
			}
		}
	}

	return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** The most recently modified session, or undefined when there is none. */
export function latestSession(): SessionCandidate | undefined {
	return listSessions()[0];
}

/**
 * Resolve a user-supplied session reference: a path, a session id prefix, or
 * undefined for "the latest session".
 */
export function resolveSession(reference: string | undefined): string | undefined {
	if (!reference) return latestSession()?.path;
	if (reference.includes("/") || reference.endsWith(".jsonl")) return reference;

	const match = listSessions().find(
		(candidate) =>
			candidate.sessionId?.startsWith(reference) ||
			candidate.path.includes(reference) ||
			candidate.name?.includes(reference),
	);
	return match?.path;
}
