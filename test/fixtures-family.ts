/**
 * A fixture with *different* procedures, each recorded more than once.
 *
 * The Vue/React family in `recipes.test.ts` is one procedure with one parameter,
 * which is enough to test co-variation but not enough to test composition: you
 * cannot learn much about stitching parts together from tapes that are all the
 * same part.
 *
 * So this builds four unrelated fragments — set a service up, write a
 * Dockerfile, build an image, run it — that were never recorded in one session.
 * Learning them as separate recipes and then linking them is the only way to see
 * whether the seam between two fragments can be named, which is the thing the
 * whole gap/contract layer exists for.
 */

import { recordSession } from "../src/record.ts";
import { parseSession } from "../src/session.ts";
import type { TapeFile, TapeOutcomeStatus } from "../src/types.ts";
import { assistantToolCall, sessionText, systemEntry, toolResultEntry } from "./fixtures.ts";

export interface RecordedCall {
	tool: string;
	args: Record<string, unknown>;
	/** Text of the tool result. Defaults to "ok". */
	text?: string;
	isError?: boolean;
}

export function tapeOfCalls(
	calls: RecordedCall[],
	name: string,
	options: { status?: TapeOutcomeStatus; cwd?: string } = {},
): TapeFile {
	const root = `s-${name}`;
	const entries = [systemEntry(root, null)];
	let parent = root;

	calls.forEach((call, index) => {
		const assistantId = `a-${name}-${index}`;
		const resultId = `t-${name}-${index}`;
		entries.push(assistantToolCall(assistantId, parent, call.tool, call.args));
		entries.push(toolResultEntry(resultId, assistantId, call.tool, call.text ?? "ok", call.isError ?? false));
		parent = resultId;
	});

	return recordSession(parseSession(sessionText(entries, options.cwd ?? "/tmp/project")), {
		name,
		...(options.status === undefined ? {} : { status: options.status }),
	}).tape;
}

export function tapeOfCommands(
	commands: string[],
	name: string,
	options: { status?: TapeOutcomeStatus } = {},
): TapeFile {
	return tapeOfCalls(
		commands.map((command) => ({ tool: "bash", args: { command } })),
		name,
		options,
	);
}

// ---------------------------------------------------------------------------
// fragments
// ---------------------------------------------------------------------------

/**
 * Setting a Python service up. Two frameworks, and the port varied independently
 * of the framework on purpose: a bijection test that grouped them would be
 * reading a coincidence as a parameter.
 */
export function serviceFamily(): TapeFile[] {
	const service = (framework: string, port: number, name: string): TapeFile =>
		tapeOfCalls(
			[
				{ tool: "bash", args: { command: "python -m venv .venv" } },
				{ tool: "bash", args: { command: `pip install ${framework}` } },
				{ tool: "write", args: { path: "src/main.py", content: `app = "${framework}"\n` } },
				{ tool: "bash", args: { command: `uvicorn main:app --port ${port}` } },
			],
			name,
		);

	return [
		service("fastapi", 8000, "service-fastapi-8000"),
		service("fastapi", 9000, "service-fastapi-9000"),
		service("flask", 8000, "service-flask-8000"),
	];
}

/** Writing the Dockerfile. Its *content* is knowledge that never enters a step. */
export function dockerfileFamily(): TapeFile[] {
	return [
		tapeOfCalls([{ tool: "write", args: { path: "Dockerfile", content: "FROM python:3.12-slim\n" } }], "dockerfile-312"),
		tapeOfCalls([{ tool: "write", args: { path: "Dockerfile", content: "FROM python:3.11-slim\n" } }], "dockerfile-311"),
	];
}

/** Building the image. Needs the Dockerfile, which is a different fragment. */
export function containeriseFamily(): TapeFile[] {
	return [
		tapeOfCommands(["docker build -t api:latest ."], "image-a"),
		tapeOfCommands(["docker build -t api:latest ."], "image-b"),
	];
}

/** Running it. Needs the image, which is again a different fragment. */
export function deployFamily(): TapeFile[] {
	return [
		tapeOfCommands(["docker run -p 8080:8080 api:latest"], "deploy-a"),
		tapeOfCommands(["docker run -p 8080:8080 api:latest"], "deploy-b"),
	];
}

/**
 * Recordings of the same command shape, with different credentials.
 *
 * The shape is identical and the secrets are not, which is what makes them
 * auditable: two recordings of the same procedure must not be told apart by
 * anything that was redacted.
 */
export function secretFamily(): TapeFile[] {
	return [
		tapeOfCommands(["npm publish --token npm_aaaaaaaaaaaaaaaaaaaa"], "publish-a"),
		tapeOfCommands(["npm publish --token npm_bbbbbbbbbbbbbbbbbbbb"], "publish-b"),
	];
}

/** A path that only means something on one machine. */
export function absolutePathFamily(): TapeFile[] {
	return [
		tapeOfCalls(
			[
				{ tool: "read", args: { path: "/home/alice/project/src/main.ts" } },
				{ tool: "write", args: { path: "/home/alice/project/tsconfig.json", content: "{}" } },
			],
			"absolute-a",
			{ cwd: "/home/alice/project" },
		),
		tapeOfCalls(
			[
				{ tool: "read", args: { path: "/home/bob/project/src/main.ts" } },
				{ tool: "write", args: { path: "/home/bob/project/tsconfig.json", content: "{}" } },
			],
			"absolute-b",
			{ cwd: "/home/bob/project" },
		),
	];
}

/** Two runs that verified the result, and one that failed its verification. */
export function mixedOutcomeFamily(): TapeFile[] {
	return [
		tapeOfCommands(["npm install express", "npm test"], "run-ok-a"),
		tapeOfCommands(["npm install express", "npm test"], "run-ok-b"),
		tapeOfCalls(
			[
				{ tool: "bash", args: { command: "npm install express" } },
				{ tool: "bash", args: { command: "npm test" }, text: "1 failing", isError: true },
			],
			"run-broken",
		),
	];
}
