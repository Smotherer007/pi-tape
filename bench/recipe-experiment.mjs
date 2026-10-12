#!/usr/bin/env node
/**
 * pi-tape recipe experiment — does a recipe make the next run cheaper or better,
 * compared with nothing, and compared with the agent's own notes?
 *
 *   node bench/recipe-experiment.mjs
 *
 * The task: deploy with `shipit`, a small in-house tool whose help text is incomplete.
 * The working procedure (log in with the team token file, pass --env, bump before a
 * prod deploy) has to be found — the kind of project knowledge no model has from
 * training, and the kind a recipe is meant to keep. Two families:
 *   open     shipit is a readable script — the procedure can be read off its source
 *   sealed   the same tool, compiled into an unreadable blob — only trying finds it
 * The first run of this experiment showed why both are needed: with the source in
 * reach, a capable model reads it and needs no memory at all.
 *
 *   training   3 runs from scratch (api→staging, web→staging, api→prod), each recorded;
 *              after each, the agent writes what it learned to NOTES.md
 *   learning   pi-tape splices the 3 tapes into one recipe
 *   testing    3 unseen deployments (billing→prod, search→staging, web→prod),
 *              each REPEATS times, under three conditions:
 *                none     — no memory at all
 *                notes    — AGENTS.md = the agent's own notes from the 3 training runs
 *                recipes  — the recipe in the project store, pi-tape's hook and tools
 *
 * Success is checked in the tool's own deployment log, not taken from the model.
 * Per run: success, model requests, tool calls, failed tool calls, tokens, cost, time.
 *
 * Isolation as in tape-prove: --no-extensions, only pi-tape from this checkout, a
 * throwaway folder per run, --approve for this process only, and an empty global recipe
 * store (PI_TAPE_DIR) so recipes you already have cannot leak into any condition.
 * Nothing is written to your pi settings or your global recipe store.
 *
 * Cost and time: about 60 runs of 4–12 requests each (2 families × (3 training + 3 tasks
 * × 3 conditions × 3 repeats)). With DeepSeek Flash: well under a dollar, 15–30 minutes.
 * Progress is printed as it goes; the report is written after every run.
 *
 * Environment (optional):
 *   PI_MODEL=provider/id      the model to test (default: your pi default)
 *   REPEATS=3                 runs per test task and condition
 *   FAMILIES=open,sealed      which tool variants to test
 *   PI_BIN, TAPE_EXT          as in tape-prove
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Reports land in .tape/check, which git ignores; the scripts themselves are part of the repo.
const OUT = join(HERE, "..", ".tape", "check");
mkdirSync(OUT, { recursive: true });
const REPO = resolve(HERE, "..");
const REPORT = join(OUT, "experiment-report.md");
const RAW = join(OUT, "experiment-runs.json");
const EXT = process.env.TAPE_EXT || join(REPO, "extensions", "index.ts");
const CLI = join(REPO, "src", "cli.ts");
const ROOT = mkdtempSync(join(tmpdir(), "tape-experiment-"));
// A working folder has no siblings the model could find with `ls ..`: in an earlier
// run of this check, a model read the notes and tapes of the other runs that way.
const isolated = (prefix) => mkdtempSync(join(tmpdir(), `tape-ws-${prefix}-`));
const REPEATS = Math.max(1, Number(process.env.REPEATS ?? 3) || 3);
const FAMILIES = (process.env.FAMILIES ?? "open,sealed").split(",").map((item) => item.trim()).filter(Boolean);

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
const runs = [];
const flush = () => {
	writeFileSync(REPORT, out.join("\n") + "\n");
	writeFileSync(RAW, JSON.stringify(runs, null, 2));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s, n = 160) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);

// ---------------------------------------------------------------------------
// the tool under test
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

function workspace(label, family = "open") {
	const dir = isolated(label);
	writeFileSync(join(dir, "shipit"), family === "sealed" ? sealed() : SHIPIT);
	chmodSync(join(dir, "shipit"), 0o755);
	writeFileSync(join(dir, ".shipit-token"), "team-7f3a\n");
	return dir;
}
const task = (service, env) => `Deploy the ${service} service to ${env} using ./shipit in this folder.`;
const deployedOk = (dir, service, env) => {
	try {
		return readFileSync(join(dir, ".shipit", "deployments.log"), "utf8").split("\n").some((line) => line.startsWith(`${service} ${env} `));
	} catch {
		return false;
	}
};

// ---------------------------------------------------------------------------
// pi in RPC mode
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// one run
// ---------------------------------------------------------------------------
async function oneRun({ family, phase, condition, service, env, repeat, setup, after }) {
	const label = `${family}-${phase}-${condition}-${service}-${env}-${repeat}`;
	const dir = workspace(label, family);
	if (setup) setup(dir);
	const pi = startPi(dir, label, MODEL_ARGS);
	const started = Date.now();
	const run = await pi.send({ type: "prompt", message: task(service, env) }, { waitForRun: true });
	const seconds = (Date.now() - started) / 1000;
	const stats = (await pi.send({ type: "get_session_stats" })).response?.data ?? {};
	const extra = after ? await after(pi, dir) : {};
	const stderr = await pi.stop();
	const summary = summarize(run.events);
	const record = {
		family,
		phase,
		condition,
		service,
		env,
		repeat,
		success: deployedOk(dir, service, env),
		...summary,
		tokens: stats.tokens ?? {},
		cost: stats.cost ?? 0,
		seconds,
		timedOut: run.timedOut,
		dir,
		...extra,
	};
	runs.push(record);
	log(
		`  ${record.success ? "✓" : "✗"} ${family}/${phase}/${condition} ${service}→${env} #${repeat}: ${record.requests} req · ${record.toolCalls} calls (${record.failedCalls} failed${record.tapeTools ? `, ${record.tapeTools} tape_*` : ""}) · ${record.tokens.total ?? "?"} tok · $${Number(record.cost).toFixed(4)} · ${seconds.toFixed(0)}s${record.errors.length ? " · ERROR " + record.errors[0] : ""}`,
	);
	log(`      ${record.commands.map((c) => short(c, 60)).join("  ⟶  ")}`);
	if (stderr && /error/i.test(stderr)) log(`      stderr: ${short(stderr, 200)}`);
	flush();
	return record;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
let MODEL_ARGS = [];

async function main() {
	log(`# pi-tape recipe experiment`);
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
	if (!model) {
		log("no model — set PI_MODEL=provider/id");
		return;
	}
	MODEL_ARGS = ["--provider", model.provider, "--model", model.id];
	log(`model ${model.provider}/${model.id} · repeats ${REPEATS} · folder ${ROOT}`);

	for (const family of FAMILIES) await runFamily(family);

	// result ------------------------------------------------------------------
	log(`\n## result (test runs only)`);
	log(`| family | condition | runs | success | first try | requests | tool calls | failed calls | tokens | cost | seconds |`);
	log(`|---|---|---|---|---|---|---|---|---|---|---|`);
	const mean = (list, pick) => (list.length ? list.reduce((sum, item) => sum + (Number(pick(item)) || 0), 0) / list.length : 0);
	for (const family of FAMILIES) {
		for (const condition of ["none", "notes", "recipes"]) {
			const list = runs.filter((run) => run.family === family && run.phase === "test" && run.condition === condition);
			if (!list.length) continue;
			const ok = list.filter((run) => run.success).length;
			const clean = list.filter((run) => run.success && run.failedCalls === 0).length;
			log(
				`| ${family} | ${condition} | ${list.length} | ${ok}/${list.length} | ${clean}/${list.length} | ${mean(list, (r) => r.requests).toFixed(1)} | ${mean(list, (r) => r.toolCalls).toFixed(1)} | ${mean(list, (r) => r.failedCalls).toFixed(1)} | ${mean(list, (r) => r.tokens.total).toFixed(0)} | $${mean(list, (r) => r.cost).toFixed(4)} | ${mean(list, (r) => r.seconds).toFixed(0)} |`,
			);
		}
	}
	for (const family of FAMILIES) {
		const train = runs.filter((run) => run.family === family && run.phase === "train");
		log(`training cost ${family} (paid once, for notes and recipes alike): $${train.reduce((sum, r) => sum + (Number(r.cost) || 0), 0).toFixed(4)} over ${train.length} runs`);
	}
	log(`raw data: ${RAW}`);
	log(`(data in ${ROOT}, working folders in ${tmpdir()}/tape-ws-* — delete them whenever you like)`);
}

async function runFamily(family) {
	log(`\n# family: ${family}`);

	// training ----------------------------------------------------------------
	log(`\n## training: 3 runs from scratch, recorded; notes written afterwards`);
	const tapes = [];
	const notes = [];
	for (const [service, env] of [["api", "staging"], ["web", "staging"], ["api", "prod"]]) {
		await oneRun({
			family,
			phase: "train",
			condition: "none",
			service,
			env,
			repeat: 1,
			after: async (pi, dir) => {
				const name = `${service}-${env}`;
				await pi.send({ type: "prompt", message: `/tape record ${name}` });
				if (existsSync(join(dir, `${name}.tape`))) tapes.push(join(dir, `${name}.tape`));
				const noteRun = await pi.send(
					{
						type: "prompt",
						message:
							"Write down what you learned about deploying with ./shipit in this folder, for a colleague who has to do the next deployment: " +
							"a short, exact procedure in NOTES.md (create it with the write tool). Nothing else.",
					},
					{ waitForRun: true },
				);
				const s = summarize(noteRun.events);
				const text = existsSync(join(dir, "NOTES.md")) ? readFileSync(join(dir, "NOTES.md"), "utf8") : "";
				notes.push(`## From deploying ${service} to ${env}\n\n${text.trim()}\n`);
				return { notesRequests: s.requests, notesChars: text.length };
			},
		});
	}
	const agentsMd = `# Team notes\n\n${notes.join("\n")}`;
	writeFileSync(join(ROOT, `AGENTS-${family}.md`), agentsMd);
	log(`\nnotes: ${agentsMd.length} characters → ${join(ROOT, `AGENTS-${family}.md`)}`);

	// learning ----------------------------------------------------------------
	log(`\n## learning: splice the ${tapes.length} tapes into a recipe`);
	const storeDir = mkdtempSync(join(ROOT, `store-${family}-`));
	tapes.forEach((tape, index) => copyFileSync(tape, join(storeDir, `t${index}.tape`)));
	try {
		const spliced = execFileSync(process.execPath, [CLI, "splice", ...tapes.map((_, index) => `t${index}.tape`), "--name", "shipit-deploy", "--save"], {
			cwd: storeDir,
			encoding: "utf8",
			timeout: 60_000,
		});
		log(spliced.split("\n").map((line) => "    " + line).join("\n"));
	} catch (error) {
		log(`✗ splice failed: ${short(error?.stderr || error?.message, 400)}`);
	}
	const recipeFile = join(storeDir, ".tape", "recipes", "shipit-deploy.recipe.json");
	const haveRecipe = existsSync(recipeFile);
	flush();

	// testing -----------------------------------------------------------------
	log(`\n## testing: unseen deployments × 3 conditions × ${REPEATS}`);
	const conditions = {
		none: undefined,
		notes: (dir) => writeFileSync(join(dir, "AGENTS.md"), agentsMd),
		recipes: (dir) => {
			if (!haveRecipe) return;
			mkdirSync(join(dir, ".tape", "recipes"), { recursive: true });
			copyFileSync(recipeFile, join(dir, ".tape", "recipes", "shipit-deploy.recipe.json"));
		},
	};
	for (let repeat = 1; repeat <= REPEATS; repeat++) {
		for (const [service, env] of [["billing", "prod"], ["search", "staging"], ["web", "prod"]]) {
			for (const [condition, setup] of Object.entries(conditions)) {
				if (condition === "recipes" && !haveRecipe) continue;
				await oneRun({ family, phase: "test", condition, service, env, repeat, setup });
			}
		}
	}
}

main()
	.catch((error) => log(`\n✗ the experiment itself failed: ${error?.stack ?? error}`))
	.finally(() => {
		flush();
		console.log(`\nreport written to ${REPORT}`);
		process.exit(0);
	});
