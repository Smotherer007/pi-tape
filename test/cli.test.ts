/**
 * The published artefact, and the CLI as a user meets it.
 *
 * These tests exist because of a bug that no other test could have caught: the
 * package shipped TypeScript and pointed its `bin` at `src/cli.ts`, so an installed
 * `pi-tape` died on its first line with
 * `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Node refuses to strip types under
 * `node_modules`, which is exactly where a dependency lives — from a checkout
 * everything worked, and the package was broken.
 *
 * So the entry points are checked, not just the code behind them.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	bin: Record<string, string>;
	files: string[];
	pi: { extensions: string[] };
	scripts: Record<string, string>;
};

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

/** Run the CLI from a checkout. `src/cli.ts` is fine here: it is not under node_modules. */
function cli(args: string[], env: Record<string, string> = {}): Promise<Run> {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [join(root, "src", "cli.ts"), ...args], {
			cwd: root,
			env: { ...process.env, ...env },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

// ---------------------------------------------------------------------------
// packaging
// ---------------------------------------------------------------------------

test("every published entry point is JavaScript, never TypeScript", () => {
	// A `bin` or an extension path ending in `.ts` works from a checkout and fails
	// for everybody who installs the package, which is the whole audience.
	for (const [name, path] of Object.entries(pkg.bin)) {
		assert.match(path, /\.js$/, `bin "${name}" must point at compiled JavaScript, got ${path}`);
	}
	for (const path of pkg.pi.extensions) {
		assert.match(path, /\.js$/, `extension "${path}" must be compiled JavaScript`);
	}

	// And the compiled output has to be shipped, or the paths above point nowhere.
	assert.ok(pkg.files.includes("dist"), "the tarball must include dist");
	assert.match(pkg.scripts.build ?? "", /tsc/, "build must actually compile");
	assert.match(
		pkg.scripts.prepublishOnly ?? "",
		/build/,
		"publishing without building is how the broken 1.0.0 artefact happened",
	);
});

test("the build config keeps the sources importable and rewrites them on the way out", () => {
	// tsconfig files are JSONC, and this one carries comments on purpose. Only line
	// comments are stripped: a block-comment regex would eat the `/**/` inside
	// `src/**/*.ts`, which is how a glob silently becomes `src*.ts`.
	const raw = readFileSync(join(root, "tsconfig.build.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
	const build = JSON.parse(raw) as {
		compilerOptions: { noEmit: boolean; outDir: string; rewriteRelativeImportExtensions: boolean };
		include: string[];
	};
	assert.equal(build.compilerOptions.noEmit, false, "the build emits");
	assert.equal(build.compilerOptions.outDir, "dist");
	// The sources import `./x.ts` because node needs that from a checkout; emitted
	// JavaScript cannot keep it, so it has to be rewritten rather than copied.
	assert.equal(build.compilerOptions.rewriteRelativeImportExtensions, true);
	assert.ok(build.include.some((entry) => entry.startsWith("src/")));
	assert.ok(build.include.some((entry) => entry.startsWith("extensions/")));
});

// ---------------------------------------------------------------------------
// the CLI as invoked
// ---------------------------------------------------------------------------

test("the CLI answers, and says what it can do", async () => {
	const result = await cli(["help"]);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /pi-tape — record pi agent sessions/);
	assert.match(result.stdout, /pi-tape run <recipe\.\.\.>/);
});

test("a closed pipe is not an error", async () => {
	// `pi-tape rules | head -2` is normal usage, and it used to end in an unhandled
	// EPIPE with a stack trace.
	const child = spawn(process.execPath, [join(root, "src", "cli.ts"), "rules"], { cwd: root });
	let stderr = "";
	child.stderr.on("data", (chunk) => (stderr += String(chunk)));

	const code = await new Promise<number | null>((resolvePromise) => {
		child.stdout.once("data", () => child.stdout.destroy());
		child.on("close", resolvePromise);
	});

	assert.equal(code, 0, `expected a clean exit, got ${code} (${stderr})`);
	assert.doesNotMatch(stderr, /EPIPE|at cmdRules/, "a consumer that stopped reading is not a crash");
});

test("a tape can be recorded, spliced, dubbed and linked through the CLI", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tape-cli-"));
	const store = join(dir, "store");
	try {
		// Two recordings of the same shape, so the splice has a family to learn from.
		const make = (id: string, template: string, pkgName: string): string => {
			const header = { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: dir };
			const entries: unknown[] = [
				{
					type: "message",
					id: "s",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "system", content: "", sections: { preamble: "test" }, toolsAdded: [], timestamp: 1 },
				},
			];
			[
				`npm create ${template}@latest ${id}`,
				`npm install ${pkgName}-router`,
				"npm run build",
			].forEach((command, index) => {
				const assistantId = `a${index}`;
				const resultId = `t${index}`;
				entries.push({
					type: "message",
					id: assistantId,
					parentId: index === 0 ? "s" : `t${index - 1}`,
					timestamp: "2026-01-01T00:00:01.000Z",
					message: {
						role: "assistant",
						content: [{ type: "toolCall", id: `call_${assistantId}`, name: "bash", arguments: { command } }],
						api: "test",
						provider: "test",
						model: "test-model",
						stopReason: "toolUse",
						timestamp: 2,
						usage: { input: 1, output: 1, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					},
				});
				entries.push({
					type: "message",
					id: resultId,
					parentId: assistantId,
					timestamp: "2026-01-01T00:00:02.000Z",
					message: {
						role: "toolResult",
						toolCallId: `call_${assistantId}`,
						toolName: "bash",
						content: [{ type: "text", text: "built in 1s" }],
						isError: false,
						timestamp: 3,
					},
				});
			});
			const path = join(dir, `${id}.jsonl`);
			writeFileSync(path, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
			return path;
		};

		const vue = make("app-one", "vue", "vue");
		const react = make("app-two", "react", "react");
		const env = { PI_TAPE_DIR: store };

		const recorded = await cli(["record", vue, "--out", join(dir, "vue.tape"), "--name", "vue"], env);
		assert.equal(recorded.code, 0, recorded.stderr);
		assert.match(recorded.stdout, /outcome {3}success/, "a green verification is a success, and it is reported");

		const second = await cli(["record", react, "--out", join(dir, "react.tape"), "--name", "react"], env);
		assert.equal(second.code, 0, second.stderr);

		const spliced = await cli(
			["splice", join(dir, "vue.tape"), join(dir, "react.tape"), "--name", "frontend", "--scope", "global", "--save"],
			env,
		);
		assert.equal(spliced.code, 0, spliced.stderr);
		assert.match(spliced.stdout, /spliced "frontend" from 2 tape\(s\)/);
		assert.ok(existsSync(join(store, "recipes", "frontend.recipe.json")));

		const dubbed = await cli(["dub", "frontend", "--set", "template=vue@latest", "--set", "name=demo"], env);
		assert.equal(dubbed.code, 0, dubbed.stderr);
		// Two recordings is a thin family: the name co-varies with the framework by
		// accident, so it lands inside that parameter. An explicit assignment still has
		// to win -- silently ignoring what the caller asked for is never the answer.
		assert.match(dubbed.stdout, /npm create vue@latest demo/);
		assert.match(dubbed.stdout, /npm install vue-router/, "and the router still came along");

		const linked = await cli(["link", "frontend"], env);
		assert.equal(linked.code, 0, linked.stderr);
		assert.match(linked.stdout, /probe before running: npm/);

		// `--set name` without a value is a mistake, and must be reported as one.
		const badSet = await cli(["dub", "frontend", "--set", "name"], env);
		assert.notEqual(badSet.code, 0);
		assert.match(badSet.stderr, /--set expects key=value/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
