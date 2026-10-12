#!/usr/bin/env node
/**
 * pi-tape knowledge regression check — does a change to what the agent is told
 * (AGENTS.md, a skill, a system prompt) change what it does, and where?
 *
 *   node bench/knowledge-regression.mjs
 *
 * Today a change to AGENTS.md is shipped on faith. The alternative here: keep a
 * recording of a run that worked, and after changing the knowledge, *shadow* it —
 * replay the recording (same tool results, no side effects, nothing deployed) and ask
 * the model at every recorded step what it would do now, with the new knowledge.
 * pi-tape reports which decisions changed, step by step.
 *
 *   golden      one real run with the original AGENTS.md, recorded
 *   control     shadow with the SAME AGENTS.md            → measures the model's own noise
 *   reworded    shadow with the same facts, other words   → must not raise an alarm
 *   regression  shadow with the bump rule deleted         → must be caught, at the step it matters
 *   reality     one real run with the deleted rule        → shows the regression is real, and what it costs
 *
 * The tool is the sealed `shipit` from the recipe experiment, so the agent depends on
 * what AGENTS.md says rather than on reading the tool's source.
 *
 * Isolation as in the other checks: --no-extensions, only pi-tape from this checkout,
 * throwaway folders, --approve for this process only, an empty global recipe store.
 * Cost: a handful of requests per shadow. With DeepSeek Flash: cents, a few minutes.
 *
 * Environment (optional): PI_MODEL=provider/id · REPEATS=2 · PI_BIN · TAPE_EXT
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
// Reports land in .tape/check, which git ignores; the scripts themselves are part of the repo.
const OUT = join(HERE, "..", ".tape", "check");
mkdirSync(OUT, { recursive: true });
const REPO = resolve(HERE, "..");
const REPORT = join(OUT, "knowledge-report.md");
const EXT = process.env.TAPE_EXT || join(REPO, "extensions", "index.ts");
const ROOT = mkdtempSync(join(tmpdir(), "tape-knowledge-"));
// A working folder has no siblings the model could find with `ls ..`: in an earlier
// run of this check, a model read the notes and tapes of the other runs that way.
const isolated = (prefix) => mkdtempSync(join(tmpdir(), `tape-ws-${prefix}-`));
const REPEATS = Math.max(1, Number(process.env.REPEATS ?? 2) || 2);

// ---------------------------------------------------------------------------
// finding pi
// ---------------------------------------------------------------------------
// finding pi
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
	const found = [
		join(REPO, "node_modules", ".bin", "pi"),
		...versionDirs(join(home, ".nvm", "versions", "node"), "bin/pi"),
		...versionDirs(join(home, ".local", "share", "fnm", "node-versions"), "installation/bin/pi"),
		"/opt/homebrew/bin/pi",
		"/usr/local/bin/pi",
	].find((candidate) => existsSync(candidate));
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
const check = (ok, text) => {
	results.push(`${ok ? "✓" : "✗"} ${text}`);
	log(`    ${ok ? "✓" : "✗"} ${text}`);
};

// ---------------------------------------------------------------------------
// the tool, sealed
// ---------------------------------------------------------------------------
const SHIPIT = `#!/usr/bin/env node
// shipit — the team's deploy tool.
const fs = require("node:fs");
const path = require("node:path");
const dir = path.join(process.cwd(), ".shipit");
fs.mkdirSync(dir, { recursive: true });
const state = (name, fallback) => { try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { return fallback; } };
const save = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf("--" + name); return i >= 0 ? rest[i + 1] : undefined; };
const fail = (msg) => { console.error("shipit: " + msg); process.exit(1); };
const SERVICES = ["api", "web", "billing", "search"];
if (!cmd || cmd === "--help" || cmd === "help" || cmd === "-h") { console.log("usage: shipit <command> [args]\\ncommands:\\n  deploy <service>   deploy a service"); process.exit(0); }
if (cmd === "login") {
  const file = flag("token-file");
  if (!file) fail("login needs --token-file <file> (the team token lives in .shipit-token)");
  if (!fs.existsSync(file) || fs.readFileSync(file, "utf8").trim() !== "team-7f3a") fail("token in " + file + " is not valid");
  save("session.json", { user: "team" }); console.log("logged in as team"); process.exit(0);
}
if (cmd === "bump") {
  const service = rest[0]; if (!SERVICES.includes(service)) fail('unknown service "' + service + '" (known: ' + SERVICES.join(", ") + ")");
  const versions = state("versions.json", {}); const [a, b, c] = (versions[service] ?? "1.0.0").split(".").map(Number);
  versions[service] = a + "." + b + "." + (c + 1); save("versions.json", versions); console.log(service + " is now " + versions[service]); process.exit(0);
}
if (cmd === "deploy") {
  const service = rest[0];
  if (!state("session.json", null)) fail("not logged in — run: shipit login");
  if (!SERVICES.includes(service)) fail('unknown service "' + service + '" (known: ' + SERVICES.join(", ") + ")");
  const env = flag("env"); if (env !== "staging" && env !== "prod") fail("--env is required: staging or prod");
  const versions = state("versions.json", {}); const version = versions[service] ?? "1.0.0";
  const deployed = state("deployed.json", {});
  if (env === "prod" && version === "1.0.0") fail("prod needs a released version — bump first: shipit bump " + service);
  deployed[service + "/" + env] = version; save("deployed.json", deployed);
  fs.appendFileSync(path.join(dir, "deployments.log"), service + " " + env + " " + version + "\\n");
  console.log("deployed " + service + " " + version + " to " + env); process.exit(0);
}
fail('unknown command "' + cmd + '"');
`;

/** The same tool, compiled: it runs the same, but its source says nothing. */
function sealed() {
	const body = SHIPIT.split("\n").slice(1).join("\n");
	const blob = gzipSync(Buffer.from(body)).toString("base64");
	return `#!/usr/bin/env node\n// shipit — compiled build, do not edit\neval(require("zlib").gunzipSync(Buffer.from("${blob}","base64")).toString());\n`;
}

function workspace(label, agentsMd) {
	const dir = isolated(label);
	writeFileSync(join(dir, "shipit"), sealed());
	chmodSync(join(dir, "shipit"), 0o755);
	writeFileSync(join(dir, ".shipit-token"), "team-7f3a\n");
	if (agentsMd) writeFileSync(join(dir, "AGENTS.md"), agentsMd);
	return dir;
}
const deployedOk = (dir, service, env) => {
	try {
		return readFileSync(join(dir, ".shipit", "deployments.log"), "utf8").split("\n").some((line) => line.startsWith(`${service} ${env} `));
	} catch {
		return false;
	}
};

// ---------------------------------------------------------------------------
// the knowledge, in three versions
// ---------------------------------------------------------------------------
const ORIGINAL = `# Deploying with shipit

- Log in first: \`./shipit login --token-file .shipit-token\`
- Deploy: \`./shipit deploy <service> --env <staging|prod>\`
- Prod only: run \`./shipit bump <service>\` before the deploy. Prod rejects an unreleased version.
`;
const REWORDED = `# shipit

Every deployment starts with \`./shipit login --token-file .shipit-token\`.
For production, release a new version first with \`./shipit bump <service>\` — otherwise prod refuses it.
Then run \`./shipit deploy <service> --env staging\` or \`--env prod\`.
`;
const REGRESSED = `# Deploying with shipit

- Log in first: \`./shipit login --token-file .shipit-token\`
- Deploy: \`./shipit deploy <service> --env <staging|prod>\`
`;
const TASK = "Deploy the billing service to prod using ./shipit in this folder. AGENTS.md describes how.";

// ---------------------------------------------------------------------------
// pi in RPC mode
// ---------------------------------------------------------------------------
let MODEL_ARGS = [];
function startPi(cwd, label, extra = []) {
	// Sessions outside the working folder: in the first run the model found its own
	// earlier sessions there and read them, which is memory by the back door.
	const sessions = join(ROOT, ".sessions", label);
	mkdirSync(sessions, { recursive: true });
	const args = [...PI_PREFIX, "--mode", "rpc", "--session-dir", sessions, "--no-extensions", "--approve", "-e", EXT, ...extra];
	// An empty global recipe store, so only the recipe this experiment learned can be
	// found — recipes in your own ~/.pi/agent/tape would otherwise reach every condition.
	const env = { ...process.env, PI_TAPE_DIR: join(ROOT, "empty-global-store") };
	const child = spawn(PI, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
	async function send(command, { waitForRun = false, timeoutMs = 420_000 } = {}) {
		const id = `${label}-${++counter}`;
		const start = events.length;
		child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
		const deadline = Date.now() + timeoutMs;
		let response;
		while (Date.now() < deadline) {
			response ??= events.slice(start).find((r) => r.type === "response" && r.id === id);
			if (response) {
				if (!response.success) break;
				if (!(waitForRun && response.data?.disposition === "started")) {
					await sleep(1000);
					break;
				}
				if (events.slice(start).some((r) => r.type === "agent_settled")) break;
			}
			await sleep(100);
		}
		return { response, events: events.slice(start), timedOut: Date.now() >= deadline };
	}
	async function stop() {
		child.stdin.end();
		await Promise.race([new Promise((r) => child.on("exit", r)), sleep(10_000)]);
		if (child.exitCode === null) child.kill();
		return stderr.trim();
	}
	return { send, stop };
}

function summarize(events) {
	const answers = events.filter((r) => r.type === "message_end" && r.message?.role === "assistant").map((r) => r.message);
	const tools = events.filter((r) => r.type === "tool_execution_end");
	const commands = answers.flatMap((m) => (m.content ?? []).filter((b) => b.type === "toolCall")).map((c) => (c.name === "bash" ? c.arguments?.command : `${c.name} ${JSON.stringify(c.arguments)}`));
	return {
		requests: answers.length,
		toolCalls: tools.length,
		failedCalls: tools.filter((t) => t.isError).length,
		tapeTools: tools.filter((t) => String(t.toolName).startsWith("tape_")).length,
		errors: answers.filter((m) => m.errorMessage).map((m) => short(m.errorMessage, 200)),
		commands,
	};
}


async function shadow(label, agentsMd, golden, model) {
	const dir = workspace(label, agentsMd);
	copyFileSync(golden, join(dir, "golden.tape"));
	const pi = startPi(dir, label, MODEL_ARGS);
	await pi.send({ type: "prompt", message: `/tape shadow golden.tape --model ${model.provider}/${model.id}` });
	await pi.send({ type: "set_model", provider: "tape", modelId: model.id });
	await pi.send({ type: "prompt", message: TASK }, { waitForRun: true });
	let report = "";
	for (let attempt = 0; attempt < 60; attempt++) {
		const run = await pi.send({ type: "prompt", message: "/tape regress" });
		report = run.events.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => String(r.message)).join("\n");
		if (!/still running/.test(report)) break;
		await sleep(2000);
	}
	await pi.stop();
	const counts = /(\d+) request\(s\) · (\d+) identical · (\d+) structurally different · (\d+) only/.exec(report);
	const parsed = counts
		? { requests: +counts[1], identical: +counts[2], structural: +counts[3], surface: +counts[4] }
		: { requests: 0, identical: 0, structural: -1, surface: 0 };
	const tokens = Number(/cost (\d+) tokens/.exec(report)?.[1] ?? 0);
	log(`  ${label}: ${parsed.requests} step(s) · ${parsed.identical} identical · ${parsed.structural} different action · ${parsed.surface} only worded/inspected differently · ${tokens} tokens`);
	const details = report.split("\n").filter((line) => /^\s{2,}(\S.*|\[)/.test(line) && /recorded:|new:|\[toolCalls\]|\[error\]|\[stopReason\]/.test(line));
	for (const line of details.slice(0, 8)) log(`      ${line.trim()}`);
	return { ...parsed, tokens };
}

async function realRun(label, agentsMd) {
	const dir = workspace(label, agentsMd);
	const pi = startPi(dir, label, MODEL_ARGS);
	const run = await pi.send({ type: "prompt", message: TASK }, { waitForRun: true });
	const stats = (await pi.send({ type: "get_session_stats" })).response?.data ?? {};
	await pi.stop();
	const s = summarize(run.events);
	const ok = deployedOk(dir, "billing", "prod");
	log(`  ${label}: ${ok ? "deployed" : "NOT deployed"} · ${s.requests} req · ${s.toolCalls} calls (${s.failedCalls} failed) · ${stats.tokens?.total ?? "?"} tok · $${Number(stats.cost ?? 0).toFixed(4)}`);
	log(`      ${s.commands.map((c) => short(c, 70)).join("  ⟶  ")}`);
	return { dir, ok, ...s, tokens: stats.tokens?.total ?? 0, cost: stats.cost ?? 0 };
}

async function main() {
	log(`# pi-tape knowledge regression check`);
	log(`date ${new Date().toISOString()} · pi ${[PI, ...PI_PREFIX].join(" ")} · pi-tape from ${EXT}`);
	try {
		log(`git ${execFileSync("git", ["-C", REPO, "log", "--oneline", "-1"], { encoding: "utf8" }).trim()} · ${execFileSync("git", ["-C", REPO, "status", "--short"], { encoding: "utf8" }).trim() ? "uncommitted changes" : "clean"}`);
	} catch {}
	if (process.env.PI_MODEL) {
		const [provider, ...rest] = process.env.PI_MODEL.split("/");
		MODEL_ARGS = ["--provider", provider, "--model", rest.join("/")];
	}
	const probe = startPi(workspace("probe"), "probe", MODEL_ARGS);
	const model = (await probe.send({ type: "get_state" })).response?.data?.model;
	await probe.stop();
	if (!model) return log("no model — set PI_MODEL=provider/id");
	MODEL_ARGS = ["--provider", model.provider, "--model", model.id];
	log(`model ${model.provider}/${model.id} · repeats ${REPEATS} · folder ${ROOT}`);

	log(`\n## golden: one real run with the original AGENTS.md`);
	let golden;
	for (let attempt = 1; attempt <= 3 && !golden; attempt++) {
		const dir = workspace(`golden-${attempt}`, ORIGINAL);
		const pi = startPi(dir, `golden-${attempt}`, MODEL_ARGS);
		const run = await pi.send({ type: "prompt", message: TASK }, { waitForRun: true });
		await pi.send({ type: "prompt", message: "/tape record golden --status success" });
		await pi.stop();
		const s = summarize(run.events);
		const ok = deployedOk(dir, "billing", "prod");
		log(`  attempt ${attempt}: ${ok ? "deployed" : "NOT deployed"} · ${s.requests} req · ${s.commands.map((c) => short(c, 70)).join("  ⟶  ")}`);
		if (ok && s.failedCalls === 0 && existsSync(join(dir, "golden.tape"))) golden = join(dir, "golden.tape");
	}
	if (!golden) {
		log("✗ no clean golden run in 3 attempts — the model does not follow AGENTS.md reliably enough for this check");
		return;
	}

	const variants = [
		["control", ORIGINAL],
		["reworded", REWORDED],
		["regression", REGRESSED],
	];
	const outcome = {};
	for (const [name, text] of variants) {
		log(`\n## shadow: ${name}`);
		outcome[name] = [];
		for (let repeat = 1; repeat <= REPEATS; repeat++) outcome[name].push(await shadow(`${name}-${repeat}`, text, golden, model));
		flush();
	}

	log(`\n## reality: what the regressed AGENTS.md does when it is actually run`);
	const real = await realRun("reality", REGRESSED);
	flush();

	log(`\n## result`);
	const all = (name, test) => outcome[name].every(test);
	check(all("control", (r) => r.structural === 0), `control: the unchanged knowledge changes no action (${outcome.control.map((r) => r.structural).join(", ")} different)`);
	check(all("reworded", (r) => r.structural === 0), `reworded: the same facts in other words raise no alarm (${outcome.reworded.map((r) => r.structural).join(", ")} different)`);
	check(all("regression", (r) => r.structural >= 1), `regression: the deleted rule is caught in every shadow (${outcome.regression.map((r) => r.structural).join(", ")} different)`);
	check(!real.ok || real.failedCalls > 0, `reality: with the deleted rule the run ${real.ok ? `still deployed, but only after ${real.failedCalls} failed call(s)` : "did not deploy"}`);
	const shadowTokens = outcome.regression.reduce((sum, r) => sum + r.tokens, 0) / outcome.regression.length;
	log(`\ncost of catching it: ~${shadowTokens.toFixed(0)} tokens per shadow, nothing executed · a real run with the change: ${real.tokens} tokens, and it ran shipit for real`);
	log(`\n(data in ${ROOT}, working folders in ${tmpdir()}/tape-ws-* — delete them whenever you like)`);
}

main()
	.catch((error) => log(`\n✗ the check itself failed: ${error?.stack ?? error}`))
	.finally(() => {
		flush();
		console.log(`\nreport written to ${REPORT}`);
		process.exit(0);
	});
