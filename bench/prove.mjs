#!/usr/bin/env node
/**
 * pi-tape proof run — the things a small check cannot show, with real models.
 *
 *   node bench/prove.mjs
 *
 * Per model (your default, plus an Anthropic and an OpenAI model if you have them):
 *   1. record   a longer run with parallel tool calls, a compaction, and a second prompt
 *   2. replay   it, compacting at the same point: every answer from the tape, 0 misses,
 *               the recorded summary served instead of asking for a new one
 *   3. fork     after the compaction, replacing one read; the model continues live.
 *               With thinking on, this sends replayed thinking blocks back to the
 *               provider — the Anthropic signature question.
 * Once, with your default model:
 *   4. debug    a wrong answer traced to its cause: an agent answers from a stale note;
 *               a fork that corrects only that note shows whether the note was the cause,
 *               paying only for the part after it.
 *
 * Isolation: pi runs with --no-extensions and only pi-tape from THIS checkout
 * (extensions/index.ts), so none of your other tools are declared or callable, and
 * the unreleased code is what gets tested. --approve applies to this process only and
 * lets the throwaway folder set a low compaction threshold; nothing is saved to your
 * pi settings. Sessions stay in the throwaway folder.
 *
 * Cost: roughly 15–25 model requests per model with ~5–25k tokens each (mostly cached).
 * A few cents with DeepSeek; well under a dollar with Claude Haiku.
 *
 * Environment (optional):
 *   PI_MODELS="anthropic/claude-haiku-4-5,deepseek/deepseek-flash"   which models to prove
 *   PI_BIN=/path/to/pi                                                 which pi to run
 *   PI_PROVE=debug                                                     only the debugging case
 *   TAPE_EXT=/path/to/extensions/index.(ts|js)                         which pi-tape to load
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Reports land in .tape/check, which git ignores; the scripts themselves are part of the repo.
const OUT = join(HERE, "..", ".tape", "check");
mkdirSync(OUT, { recursive: true });
const REPO = resolve(HERE, "..");
const REPORT = join(OUT, "prove-report.md");
const EXT = process.env.TAPE_EXT || join(REPO, "extensions", "index.ts");
const ROOT = mkdtempSync(join(tmpdir(), "tape-prove-"));
// A working folder has no siblings the model could find with `ls ..`: in an earlier
// run of this check, a model read the notes and tapes of the other runs that way.
const isolated = (prefix) => mkdtempSync(join(tmpdir(), `tape-ws-${prefix}-`));

// ---------------------------------------------------------------------------
// finding pi (same as tape-check)
// ---------------------------------------------------------------------------
function versionDirs(root, suffix) {
	try {
		return readdirSync(root).map((version) => join(root, version, suffix));
	} catch {
		return [];
	}
}
function resolvePi() {
	if (process.env.PI_BIN) return process.env.PI_BIN.trim().split(/\s+/);
	if (!spawnSync("pi", ["--version"], { stdio: "ignore" }).error) return ["pi"];
	const shell = process.env.SHELL || "/bin/zsh";
	let answer = "";
	try {
		answer = execFileSync(shell, ["-ilc", "type pi"], { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] });
	} catch (error) {
		answer = String(error?.stdout ?? "");
	}
	for (const line of answer.split("\n")) {
		const alias = /pi is an alias for (.+)$/.exec(line) ?? /pi is aliased to (.+)$/.exec(line);
		if (alias) return alias[1].trim().replace(/^[`'"]|[`'"]$/g, "").split(/\s+/);
		const path = /pi is (\/\S+)$/.exec(line);
		if (path) return [path[1]];
	}
	const home = process.env.HOME ?? "";
	const candidates = [
		join(REPO, "node_modules", ".bin", "pi"),
		...versionDirs(join(home, ".nvm", "versions", "node"), "bin/pi"),
		...versionDirs(join(home, ".local", "share", "fnm", "node-versions"), "installation/bin/pi"),
		...versionDirs(join(home, "Library", "Application Support", "fnm", "node-versions"), "installation/bin/pi"),
		"/opt/homebrew/bin/pi",
		"/usr/local/bin/pi",
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (found) return [found];
	console.log("could not find pi — set PI_BIN to its full path");
	process.exit(1);
}
const [PI, ...PI_PREFIX] = resolvePi();

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
const out = [];
const log = (line = "") => {
	out.push(line);
	console.log(line);
};
const flush = () => writeFileSync(REPORT, out.join("\n") + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 160) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const results = [];
const check = (scope, ok, text) => {
	results.push(`${ok ? "✓" : "✗"} [${scope}] ${text}`);
	log(`    ${ok ? "✓" : "✗"} ${text}`);
};

// ---------------------------------------------------------------------------
// pi in RPC mode
// ---------------------------------------------------------------------------
function startPi(cwd, label, extra = []) {
	const args = [...PI_PREFIX, "--mode", "rpc", "--session-dir", join(cwd, ".sessions"), "--no-extensions", "--approve", "-e", EXT, ...extra];
	const child = spawn(PI, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
	let buffer = "";
	let stderr = "";
	const events = [];
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			let line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line));
			} catch {}
		}
	});
	child.stderr.on("data", (chunk) => (stderr += chunk));
	child.on("error", (error) => {
		log(`✗ could not start ${PI}: ${error.message}`);
		flush();
		process.exit(1);
	});
	let counter = 0;
	async function send(command, { waitForRun = false, until, timeoutMs = 300_000 } = {}) {
		const id = `${label}-${++counter}`;
		const start = events.length;
		child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
		const deadline = Date.now() + timeoutMs;
		let response;
		while (Date.now() < deadline) {
			response ??= events.slice(start).find((r) => r.type === "response" && r.id === id);
			if (until) {
				if (until(events.slice(start))) {
					await sleep(500);
					break;
				}
			} else if (response) {
				if (!response.success) break;
				if (!(waitForRun && response.data?.disposition === "started")) {
					await sleep(1200);
					break;
				}
				if (events.slice(start).some((r) => r.type === "agent_settled")) break;
			}
			await sleep(100);
		}
		return { response, events: events.slice(start) };
	}
	async function stop() {
		child.stdin.end();
		await Promise.race([new Promise((r) => child.on("exit", r)), sleep(10_000)]);
		if (child.exitCode === null) child.kill();
		return stderr.trim();
	}
	return { send, stop };
}

function describe(events, indent = "    ") {
	const tools = [];
	const answers = [];
	for (const r of events) {
		if (r.type === "extension_ui_request" && r.method === "notify") {
			log(indent + "notify: " + String(r.message).split("\n").join("\n" + indent + "        "));
		} else if (r.type === "message_end" && r.message?.role === "assistant") {
			const m = r.message;
			const parts = (m.content ?? []).map((b) =>
				b.type === "text" ? `text "${short(b.text, 200)}"` : b.type === "toolCall" ? `call ${b.name}${JSON.stringify(b.arguments)}` : b.type,
			);
			answers.push(m);
			log(`${indent}assistant [${m.provider}/${m.model}] ${parts.join(" | ")}${m.errorMessage ? "  ERROR " + short(m.errorMessage, 400) : ""}`);
		} else if (r.type === "tool_execution_end") {
			const text = (r.result?.content ?? []).map((b) => b.text ?? "").join(" ");
			const source = r.result?.details?.tape ?? "real tool";
			tools.push({ name: r.toolName, text, source, isError: r.isError });
			log(`${indent}tool ${r.toolName} → [${source}]${r.isError ? " ERROR" : ""} "${short(text, 90)}"`);
		} else if (r.type === "compaction_end" || r.type === "auto_compaction_end") {
			log(`${indent}compaction ${r.aborted ? "aborted" : "done"}${r.errorMessage ? " " + short(r.errorMessage) : ""}`);
		}
	}
	return { tools, answers };
}
const notices = (events) => events.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message)).join("\n");
const missesOf = (text) => /misses\s+(\d+)/.exec(text)?.[1];
const errorsOf = (answers) => answers.filter((m) => m.errorMessage).map((m) => short(m.errorMessage, 300));
const lastText = (answers) => {
	const final = [...answers].reverse().find((m) => (m.content ?? []).some((b) => b.type === "text" && b.text?.trim()));
	return (final?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
};

// ---------------------------------------------------------------------------
// the long run, with a compaction
// ---------------------------------------------------------------------------
const P1 =
	"Use only the read tool. First read f01.txt. Then read f02.txt, f03.txt and f04.txt together in ONE turn " +
	"(three parallel tool calls). Then read f05.txt. Then reply with one short sentence giving the code word in f05.txt.";
const P2 =
	"Use only the read tool. Read f06.txt and f07.txt together in ONE turn (two parallel tool calls). " +
	"Then reply with one short sentence giving the code words in both files.";
const WORDS = { f01: "amber", f02: "birch", f03: "cobalt", f04: "dune", f05: "ember", f06: "fjord", f07: "garnet", f08: "harbor" };

function longWorkspace() {
	const dir = isolated("long");
	mkdirSync(join(dir, ".pi"));
	// Low enough that this small run can be compacted on request; it applies to this folder only.
	writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 1500 } }));
	for (const [name, word] of Object.entries(WORDS)) {
		const filler = Array.from({ length: 60 }, (_, i) => `Line ${i + 1} of ${name}: nothing important here, keep reading.`).join("\n");
		writeFileSync(join(dir, `${name}.txt`), `${filler}\nThe code word in ${name}.txt is ${word.toUpperCase()}.\n`);
	}
	return dir;
}

async function proveModel(model) {
	const scope = `${model.provider}/${model.id}`;
	log(`\n## ${scope}`);
	const dir = longWorkspace();
	const thinking = model.reasoning ? "low" : undefined;
	const modelArgs = ["--provider", model.provider, "--model", model.id];
	log(`folder ${dir} · thinking ${thinking ?? "n/a"}`);

	// 1. record ---------------------------------------------------------------
	log(`\n### 1 · record (parallel reads, compaction, second prompt)`);
	let pi = startPi(dir, "rec", modelArgs);
	if (thinking) await pi.send({ type: "set_thinking_level", level: thinking });
	let run = await pi.send({ type: "prompt", message: P1 }, { waitForRun: true });
	let d1 = describe(run.events);
	run = await pi.send({ type: "compact" });
	const compacted = run.response?.success === true;
	log(`    compact → ${compacted ? "done" : "failed: " + short(run.response?.error, 200)}`);
	run = await pi.send({ type: "prompt", message: P2 }, { waitForRun: true });
	const d2 = describe(run.events);
	run = await pi.send({ type: "get_session_stats" });
	const recordCost = run.response?.data?.cost;
	run = await pi.send({ type: "prompt", message: "/tape record long" });
	describe(run.events);
	let err = await pi.stop();
	if (err) log(`    stderr: ${short(err, 300)}`);
	const reads = [...d1.tools, ...d2.tools].filter((t) => t.name === "read");
	const recordErrors = errorsOf([...d1.answers, ...d2.answers]);
	const parallel = [...d1.answers, ...d2.answers].some((m) => (m.content ?? []).filter((b) => b.type === "toolCall").length > 1);
	check(scope, recordErrors.length === 0, `recording ran without provider errors${recordErrors.length ? ": " + recordErrors[0] : ""}`);
	check(scope, existsSync(join(dir, "long.tape")), "a tape was written");
	check(scope, compacted, "the recording was compacted between the two prompts");
	log(`    (${reads.length} reads, parallel tool calls ${parallel ? "used" : "NOT used by this model"}, cost $${recordCost ?? "?"})`);
	if (!existsSync(join(dir, "long.tape"))) return;

	// change everything on disk, so a tape-served result is recognisable
	for (const name of Object.keys(WORDS)) writeFileSync(join(dir, `${name}.txt`), `${name}.txt CHANGED ON DISK\n`);

	// 2. replay with compaction --------------------------------------------------
	log(`\n### 2 · replay, compacting at the same point`);
	pi = startPi(dir, "play", modelArgs);
	await pi.send({ type: "prompt", message: "/tape play long.tape" });
	const sm = await pi.send({ type: "set_model", provider: "tape", modelId: model.id });
	if (!sm.response?.success) log(`    set_model tape/${model.id} failed: ${sm.response?.error}`);
	if (thinking) await pi.send({ type: "set_thinking_level", level: thinking });
	run = await pi.send({ type: "prompt", message: P1 }, { waitForRun: true });
	const r1 = describe(run.events);
	run = await pi.send({ type: "compact" });
	log(`    compact → ${run.response?.success ? "done" : "failed: " + short(run.response?.error, 200)}`);
	run = await pi.send({ type: "prompt", message: P2 }, { waitForRun: true });
	const r2 = describe(run.events);
	run = await pi.send({ type: "prompt", message: "/tape status" });
	describe(run.events);
	const status = notices(run.events);
	err = await pi.stop();
	if (err) log(`    stderr: ${short(err, 300)}`);
	const replayTools = [...r1.tools, ...r2.tools];
	check(scope, replayTools.length > 0 && replayTools.every((t) => t.source === "replayed"), "replay: every tool result came from the tape");
	check(scope, !replayTools.some((t) => t.text.includes("CHANGED")), "replay: no tool ran against the changed files");
	check(scope, missesOf(status) === "0", `replay: 0 hash misses (got ${missesOf(status) ?? "?"})`);
	if (compacted) check(scope, /compaction 1 served from the recording/.test(status), "replay: the recorded summary was served, no model asked");

	// 3. fork after the compaction ----------------------------------------------
	const calls = [...d1.answers, ...d2.answers].flatMap((m) => (m.content ?? []).filter((b) => b.type === "toolCall"));
	const turn = calls.findIndex((c) => String(c.arguments?.path ?? "").endsWith("f06.txt")) + 1;
	if (!turn) {
		log(`\n### 3 · fork skipped: the model never read f06.txt`);
		return;
	}
	log(`\n### 3 · fork after the compaction: replace f06.txt (turn ${turn}), continue live${thinking ? " with thinking on" : ""}`);
	writeFileSync(join(dir, "f08.txt"), `The code word in f08.txt is ${WORDS.f08.toUpperCase()}.\n`);
	pi = startPi(dir, "fork", modelArgs);
	const replacement = "f06.txt has moved. Its code word is now in f08.txt — read f08.txt.";
	run = await pi.send({ type: "prompt", message: `/tape fork long.tape --model ${scope} --at ${turn} --result ${replacement} --live-tools read` });
	await pi.send({ type: "set_model", provider: "tape", modelId: model.id });
	if (thinking) await pi.send({ type: "set_thinking_level", level: thinking });
	run = await pi.send({ type: "prompt", message: P1 }, { waitForRun: true });
	const f1 = describe(run.events);
	run = await pi.send({ type: "compact" });
	log(`    compact → ${run.response?.success ? "done" : "failed: " + short(run.response?.error, 200)}`);
	run = await pi.send({ type: "prompt", message: P2 }, { waitForRun: true });
	const f2 = describe(run.events);
	run = await pi.send({ type: "prompt", message: "/tape status" });
	describe(run.events);
	const forkStatus = notices(run.events);
	err = await pi.stop();
	if (err) log(`    stderr: ${short(err, 300)}`);
	const forkTools = [...f1.tools, ...f2.tools];
	const liveErrors = errorsOf([...f1.answers, ...f2.answers]);
	check(scope, !/stopped unsent/.test(forkStatus), "fork: nothing missed before the intervention");
	check(scope, forkTools.some((t) => t.source === "override"), "fork: the intervention was served");
	check(scope, liveErrors.length === 0, `fork: the live continuation ran without provider errors${liveErrors.length ? ": " + liveErrors[0] : ""}`);
	check(scope, /request\(s\) the recording lacked/.test(forkStatus) && !/0 request\(s\) the recording lacked/.test(forkStatus), "fork: the model was asked live after the intervention");
	const followed = forkTools.some((t) => t.source === "real tool" && /HARBOR/.test(t.text)) || /harbor/i.test(lastText([...f1.answers, ...f2.answers]));
	const liveRequests = /(\d+) request\(s\) the recording lacked/.exec(forkStatus)?.[1] ?? "?";
	log(`    (the live model ${followed ? "followed the replaced result to f08.txt" : "did not follow the replaced result — its own choice"}; ${liveRequests} live request(s))`);
}

// ---------------------------------------------------------------------------
// the debugging case
// ---------------------------------------------------------------------------
async function proveDebugging(model) {
	const scope = `debug ${model.provider}/${model.id}`;
	log(`\n## debugging case: a wrong answer, traced to its cause`);
	const dir = isolated("debug");
	writeFileSync(join(dir, "notes.md"), "# Service notes\n\nThe service listens on port 3000.\n");
	writeFileSync(join(dir, "config.json"), JSON.stringify({ service: { port: 8080 } }, null, 2) + "\n");
	const ask = "Which port does the service listen on? Read notes.md — only that file — and answer with just the number.";
	const modelArgs = ["--provider", model.provider, "--model", model.id];

	log(`\n### 4a · the run that went wrong`);
	let pi = startPi(dir, "dbg", modelArgs);
	let run = await pi.send({ type: "prompt", message: ask }, { waitForRun: true });
	const original = describe(run.events);
	run = await pi.send({ type: "get_session_stats" });
	const originalCost = run.response?.data?.cost;
	await pi.send({ type: "prompt", message: "/tape record wrong" });
	await pi.stop();
	const wrongAnswer = lastText(original.answers);
	log(`    answer: "${short(wrongAnswer)}" (config.json says 8080) · cost $${originalCost ?? "?"}`);

	const turn =
		original.answers
			.flatMap((m) => (m.content ?? []).filter((b) => b.type === "toolCall"))
			.findIndex((c) => String(c.arguments?.path ?? "").endsWith("notes.md")) + 1;
	if (!turn) {
		log("    the model did not read notes.md — the case does not apply to it");
		return;
	}

	log(`\n### 4b · hypothesis: the stale note caused it — fork with only that note corrected, one command`);
	pi = startPi(dir, "dbgfork", modelArgs);
	run = await pi.send(
		{
			type: "prompt",
			message: `/tape fork wrong.tape --model ${model.provider}/${model.id} --run --at ${turn} --result # Service notes\n\nThe service listens on port 8080.`,
		},
		{ until: (events) => events.some((r) => r.type === "extension_ui_request" && /tape replay ←|stopped after|could not switch/.test(String(r.message))) },
	);
	const forked = describe(run.events);
	const forkStatus = notices(run.events);
	await pi.send({ type: "prompt", message: "/tape record corrected" });
	await pi.stop();
	const fixedAnswer = lastText(forked.answers);
	log(`    answer: "${short(fixedAnswer)}"`);

	check(scope, /3000/.test(wrongAnswer) && !/8080/.test(wrongAnswer), `the original run answered from the stale note (${short(wrongAnswer, 40)})`);
	check(scope, /8080/.test(fixedAnswer), `with only the note corrected, the answer is right (${short(fixedAnswer, 40)})`);
	check(scope, forked.tools.some((t) => t.source === "override"), "the fork replaced exactly the note, nothing else was re-run");
	check(scope, /running 1 recorded prompt/.test(forkStatus) && /tape replay ←/.test(forkStatus), "one command: --run sent the recorded prompt itself and reported");
	try {
		const cli = join(REPO, "src", "cli.ts");
		const diff = execFileSync(process.execPath, [cli, "diff", join(dir, "wrong.tape"), join(dir, "corrected.tape")], { encoding: "utf8", timeout: 30_000 });
		log("\n    pi-tape diff wrong.tape corrected.tape\n" + diff.split("\n").map((l) => "      " + l).join("\n"));
	} catch (error) {
		log(`    (diff failed: ${short(error?.message, 200)})`);
	}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function chooseModels() {
	const probeDir = isolated("probe");
	const pi = startPi(probeDir, "probe");
	const state = await pi.send({ type: "get_state" });
	const list = await pi.send({ type: "get_available_models" });
	await pi.stop();
	const available = list.response?.data?.models ?? [];
	const find = (spec) => {
		const [provider, ...rest] = spec.split("/");
		const id = rest.join("/");
		return available.find((m) => m.provider === provider && m.id === id) ?? { provider, id, reasoning: false };
	};
	if (process.env.PI_MODELS) return process.env.PI_MODELS.split(",").map((s) => find(s.trim())).filter((m) => m.id);
	const chosen = [];
	const add = (m) => m && !chosen.some((c) => c.provider === m.provider && c.id === m.id) && chosen.push(m);
	add(state.response?.data?.model);
	add(available.find((m) => m.provider === "anthropic" && /haiku/i.test(m.id)));
	add(available.find((m) => m.provider === "openai" && /mini/i.test(m.id)));
	log(`available models: ${available.length} · chosen: ${chosen.map((m) => `${m.provider}/${m.id}`).join(", ") || "none"}`);
	return chosen;
}

async function main() {
	log(`# pi-tape proof run`);
	log(`date ${new Date().toISOString()}`);
	log(`pi ${[PI, ...PI_PREFIX].join(" ")}`);
	log(`pi-tape from ${EXT}`);
	try {
		log(`git ${execFileSync("git", ["-C", REPO, "log", "--oneline", "-1"], { encoding: "utf8" }).trim()} · working tree ${execFileSync("git", ["-C", REPO, "status", "--short"], { encoding: "utf8" }).trim() ? "with uncommitted changes" : "clean"}`);
	} catch {}
	log(`folder ${ROOT}`);
	const models = await chooseModels();
	if (!models.length) {
		log("no model to prove — set PI_MODELS");
		return;
	}
	for (const model of process.env.PI_PROVE === "debug" ? [] : models) {
		try {
			await proveModel(model);
		} catch (error) {
			log(`✗ ${model.provider}/${model.id} aborted: ${error?.stack ?? error}`);
		}
		flush();
	}
	try {
		await proveDebugging(models[0]);
	} catch (error) {
		log(`✗ debugging case aborted: ${error?.stack ?? error}`);
	}
	log(`\n## result`);
	results.forEach((line) => log(line));
	log(`\n(data in ${ROOT}, working folders in ${tmpdir()}/tape-ws-* — delete them whenever you like)`);
}

main()
	.catch((error) => log(`\n✗ the proof run itself failed: ${error?.stack ?? error}`))
	.finally(() => {
		flush();
		console.log(`\nreport written to ${REPORT}`);
		process.exit(0);
	});
