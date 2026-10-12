#!/usr/bin/env node
/**
 * pi-tape live check — runs your installed pi (with your normal model and login) in
 * RPC mode against a throwaway folder, and writes what happened to
 * .tape/check/report.md next to this script.
 *
 *   node bench/replay-check.mjs
 *
 * What it does, with a real model:
 *   1. record   a small run: read a.txt, a2.txt, a3.txt, answer      (~4 model calls)
 *   2. change   those files on disk, so anything served from the tape is recognisable
 *   3. replay   the tape: every answer and tool result must come from the recording
 *   4. replay   again at a different thinking level (only if the model reasons)
 *   5. fork     replace the result of the 2nd read, let the model continue live,
 *               with `read` allowed for real                         (~1–3 model calls)
 *
 * Nothing outside the throwaway folder is touched; sessions go there too, not into
 * your pi history. No credentials are read or written by this script — pi uses its own.
 *
 * Environment (optional):
 *   PI_BIN=/path/to/pi        which pi to run (default: `pi`, or whatever your shell's `type pi` says)
 *   PI_EXTRA_ARGS="..."       extra arguments for pi, e.g. "--provider anthropic --model claude-haiku-4-5"
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Reports land in .tape/check, which git ignores; the scripts themselves are part of the repo.
const OUT = join(HERE, "..", ".tape", "check");
mkdirSync(OUT, { recursive: true });
const REPORT = join(OUT, "report.md");
/**
 * How to start pi, as [command, ...args].
 *
 * `pi` is often not a plain binary on PATH for a child process: it may be a zsh alias,
 * a function, or live in a directory only the interactive shell adds. So: PI_BIN if
 * given (may contain arguments), else `pi` if it starts, else ask the login shell
 * what `pi` is and follow an alias to what it stands for.
 */
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
		// zsh: "pi is an alias for X" · bash: "pi is aliased to `X'"
		const alias = /pi is an alias for (.+)$/.exec(line) ?? /pi is aliased to (.+)$/.exec(line);
		if (alias) return alias[1].trim().replace(/^[`'"]|[`'"]$/g, "").split(/\s+/).map(expandHome);
		const path = /pi is (\/\S+)$/.exec(line);
		if (path) return [path[1]];
	}
	// Not on the shell's PATH either: look where pi usually ends up. The repo's own
	// devDependency comes first — it uses the same ~/.pi (login, installed packages).
	const home = process.env.HOME ?? "";
	const candidates = [
		join(HERE, "..", "node_modules", ".bin", "pi"),
		...versionDirs(join(home, ".nvm", "versions", "node"), "bin/pi"),
		...versionDirs(join(home, ".local", "share", "fnm", "node-versions"), "installation/bin/pi"),
		...versionDirs(join(home, "Library", "Application Support", "fnm", "node-versions"), "installation/bin/pi"),
		"/opt/homebrew/bin/pi",
		"/usr/local/bin/pi",
		join(home, ".npm-global", "bin", "pi"),
	];
	const found = candidates.find((candidate) => existsSync(candidate));
	if (found) return [found];
	console.log(`could not find pi (\`type pi\` said: ${answer.trim().slice(0, 160) || "nothing"}). Set PI_BIN to the full path of your pi.`);
	process.exit(1);
}
function versionDirs(root, suffix) {
	try {
		return readdirSync(root).map((version) => join(root, version, suffix));
	} catch {
		return [];
	}
}
function expandHome(part) {
	return part.startsWith("~/") ? join(process.env.HOME ?? "", part.slice(2)) : part;
}
const [PI, ...PI_PREFIX] = resolvePi();
const EXTRA = (process.env.PI_EXTRA_ARGS || "").split(/\s+/).filter(Boolean);
const WS = mkdtempSync(join(tmpdir(), "tape-check-"));
const PROMPT =
	"Use the read tool to read a.txt, then a2.txt, then a3.txt — one call at a time, in that order, nothing else. " +
	"Then reply with one short sentence that quotes what the last file you read contained. Use no other tool.";

const out = [];
const log = (line = "") => {
	out.push(line);
	console.log(line);
};
const flush = () => writeFileSync(REPORT, out.join("\n") + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 160) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

/** One pi process in RPC mode, with a tiny JSONL client. */
function startPi(label) {
	const child = spawn(PI, [...PI_PREFIX, "--mode", "rpc", "--session-dir", join(WS, "sessions"), ...EXTRA], {
		cwd: WS,
		stdio: ["pipe", "pipe", "pipe"],
	});
	let buffer = "";
	let stderr = "";
	const listeners = new Set();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		buffer += chunk;
		let index;
		while ((index = buffer.indexOf("\n")) >= 0) {
			let line = buffer.slice(0, index);
			buffer = buffer.slice(index + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			let record;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			for (const listener of listeners) listener(record);
		}
	});
	child.stderr.on("data", (chunk) => (stderr += chunk));
	child.on("error", (error) => {
		log(`✗ could not start ${PI}: ${error.message} — set PI_BIN to your pi binary (\`which pi\`)`);
		flush();
		process.exit(1);
	});
	let counter = 0;
	const events = [];
	listeners.add((r) => events.push(r));

	async function send(command, { waitForRun = false, timeoutMs = 240_000 } = {}) {
		const id = `${label}-${++counter}`;
		const start = events.length;
		child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
		const deadline = Date.now() + timeoutMs;
		let response;
		while (Date.now() < deadline) {
			response ??= events.slice(start).find((r) => r.type === "response" && r.id === id);
			if (response) {
				const started = response.data?.disposition === "started";
				if (!response.success) break;
				if (!(waitForRun && started)) {
					await sleep(1500); // let an extension command's notifications arrive
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
		return stderr;
	}
	return { send, stop };
}

/** The parts of a stream of events a person needs to judge the run. */
function describe(events) {
	const lines = [];
	const tools = [];
	for (const r of events) {
		if (r.type === "extension_ui_request" && r.method === "notify") {
			lines.push("    notify: " + String(r.message).split("\n").join("\n            "));
		} else if (r.type === "message_end" && r.message?.role === "assistant") {
			const m = r.message;
			const parts = (m.content ?? []).map((b) =>
				b.type === "text" ? `text "${short(b.text)}"` : b.type === "toolCall" ? `call ${b.name}${JSON.stringify(b.arguments)}` : b.type,
			);
			lines.push(`    assistant [${m.provider}/${m.model}] ${parts.filter((p) => p !== "thinking").join(" | ")}${m.errorMessage ? "  ERROR " + short(m.errorMessage, 300) : ""}`);
		} else if (r.type === "tool_execution_end") {
			const text = (r.result?.content ?? []).map((b) => b.text ?? "").join(" ");
			const source = r.result?.details?.tape ?? "real tool";
			tools.push({ name: r.toolName, text, source, isError: r.isError });
			lines.push(`    tool ${r.toolName} → [${source}]${r.isError ? " ERROR" : ""} "${short(text)}"`);
		}
	}
	return { lines, tools };
}

function notifications(events) {
	return events.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message));
}

const checks = [];
const check = (ok, text) => {
	checks.push(`${ok ? "✓" : "✗"} ${text}`);
};

async function main() {
	log(`# pi-tape live check`);
	log(`date ${new Date().toISOString()} · pi ${[PI, ...PI_PREFIX].join(" ")} ${EXTRA.join(" ")} · folder ${WS}`);
	try {
		const installed = execFileSync(PI, [...PI_PREFIX, "list"], { encoding: "utf8", timeout: 30_000 });
		log("installed: " + short(installed.split("\n").filter((l) => /pi-tape/.test(l)).join(" "), 200));
		const pkgLine = installed.split("\n").find((l) => /pi-tape/.test(l) && l.trim().startsWith("/"));
		if (pkgLine) log("pi-tape version " + JSON.parse(readFileSync(join(pkgLine.trim(), "package.json"), "utf8")).version);
	} catch {
		log("installed: (pi list failed)");
	}
	writeFileSync(join(WS, "a.txt"), "alpha\n");
	writeFileSync(join(WS, "a2.txt"), "alpha2\n");
	writeFileSync(join(WS, "a3.txt"), "gamma\n");
	writeFileSync(join(WS, "b.txt"), "beta\n");

	// 1. record ---------------------------------------------------------------
	log(`\n## 1 · record`);
	let pi = startPi("rec");
	const state = await pi.send({ type: "get_state" });
	const model = state.response?.data?.model;
	const thinking = state.response?.data?.thinkingLevel;
	log(`model ${model?.provider}/${model?.id} · reasoning ${model?.reasoning} · thinking ${thinking}`);
	if (!model) {
		log("no model selected — set PI_EXTRA_ARGS=\"--provider … --model …\"");
		return;
	}
	let run = await pi.send({ type: "prompt", message: PROMPT }, { waitForRun: true });
	let d = describe(run.events);
	d.lines.forEach((l) => log(l));
	const recordedReads = d.tools.filter((t) => t.name === "read");
	check(recordedReads.length >= 2, `the recording has at least two reads (it has ${recordedReads.length})`);
	run = await pi.send({ type: "prompt", message: "/tape record base" });
	describe(run.events).lines.forEach((l) => log(l));
	log(`stderr: ${short(await pi.stop(), 400) || "(none)"}`);
	flush();
	if (!existsSync(join(WS, "base.tape"))) {
		log("✗ no base.tape was written — is pi-tape installed? (`pi list`)");
		return;
	}

	// 2. change the files -----------------------------------------------------
	for (const f of ["a.txt", "a2.txt", "a3.txt"]) writeFileSync(join(WS, f), `${f} CHANGED ON DISK\n`);
	log(`\n(changed a.txt, a2.txt, a3.txt on disk — a tape-served result still shows the old text)`);

	const tapeModel = { type: "set_model", provider: "tape", modelId: model.id };

	// 3. plain replay ---------------------------------------------------------
	log(`\n## 2 · plain replay`);
	pi = startPi("play");
	run = await pi.send({ type: "prompt", message: "/tape play base.tape" });
	describe(run.events).lines.forEach((l) => log(l));
	const sm = await pi.send(tapeModel);
	if (!sm.response?.success) log(`    set_model tape/${model.id} failed: ${sm.response?.error}`);
	run = await pi.send({ type: "prompt", message: PROMPT }, { waitForRun: true });
	d = describe(run.events);
	d.lines.forEach((l) => log(l));
	check(d.tools.length > 0 && d.tools.every((t) => t.source === "replayed"), "replay: every tool result came from the tape");
	check(!d.tools.some((t) => t.text.includes("CHANGED ON DISK")), "replay: no tool ran against the changed files");
	run = await pi.send({ type: "prompt", message: "/tape status" });
	describe(run.events).lines.forEach((l) => log(l));
	const misses = /misses\s+(\d+)/.exec(notifications(run.events).join("\n"))?.[1];
	check(misses === "0", `replay: 0 hash misses (got ${misses ?? "?"})`);
	log(`stderr: ${short(await pi.stop(), 400) || "(none)"}`);
	flush();

	// 4. replay at another thinking level -------------------------------------
	if (model.reasoning) {
		const other = thinking === "high" ? "low" : "high";
		log(`\n## 3 · plain replay at thinking level "${other}" (recorded at "${thinking}")`);
		pi = startPi("think");
		await pi.send({ type: "prompt", message: "/tape play base.tape" });
		await pi.send(tapeModel);
		await pi.send({ type: "set_thinking_level", level: other });
		run = await pi.send({ type: "prompt", message: PROMPT }, { waitForRun: true });
		describe(run.events).lines.forEach((l) => log(l));
		run = await pi.send({ type: "prompt", message: "/tape status" });
		describe(run.events).lines.forEach((l) => log(l));
		const m2 = /misses\s+(\d+)/.exec(notifications(run.events).join("\n"))?.[1];
		check(m2 === "0", `replay at another thinking level: 0 hash misses (got ${m2 ?? "?"})`);
		log(`stderr: ${short(await pi.stop(), 400) || "(none)"}`);
		flush();
	} else {
		log(`\n## 3 · skipped: ${model.id} does not reason, so there is no thinking level to vary`);
	}

	// 5. fork -------------------------------------------------------------------
	log(`\n## 4 · fork: replace the 2nd read, continue live, read allowed for real`);
	pi = startPi("fork");
	const replacement = "This file only says: the answer is in b.txt — read b.txt next.";
	run = await pi.send({
		type: "prompt",
		message: `/tape fork base.tape --model ${model.provider}/${model.id} --at 2 --result ${replacement} --live-tools read`,
	});
	describe(run.events).lines.forEach((l) => log(l));
	await pi.send(tapeModel);
	run = await pi.send({ type: "prompt", message: PROMPT }, { waitForRun: true });
	d = describe(run.events);
	d.lines.forEach((l) => log(l));
	const [first, second, ...rest] = d.tools;
	check(first?.source === "replayed" && !first.text.includes("CHANGED"), "fork: the 1st read came from the tape, not the changed file");
	check(second?.source === "override", "fork: the 2nd read returned the intervention");
	check(rest.every((t) => t.source !== "replayed"), "fork: nothing after the intervention was served by position from the old run");
	log(`    (what the live model did next is its own choice; a real read of b.txt shows "beta")`);
	run = await pi.send({ type: "prompt", message: "/tape status" });
	describe(run.events).lines.forEach((l) => log(l));
	const statusText = notifications(run.events).join("\n");
	const m3 = /misses\s+(\d+)/.exec(statusText)?.[1];
	check(m3 === "0", `fork: 0 hash misses before the divergence (got ${m3 ?? "?"})`);
	run = await pi.send({ type: "prompt", message: "/tape record fork" });
	describe(run.events).lines.forEach((l) => log(l));
	log(`stderr: ${short(await pi.stop(), 400) || "(none)"}`);

	log(`\n## result`);
	checks.forEach((c) => log(c));
	log(`\n(tapes and sessions are in ${WS} — delete it whenever you like)`);
	flush();
}

main()
	.catch((error) => {
		log(`\n✗ the check itself failed: ${error?.stack ?? error}`);
	})
	.finally(() => {
		flush();
		console.log(`\nreport written to ${REPORT}`);
		process.exit(0);
	});
