/**
 * Running a procedure: bind, probe, execute, verify.
 *
 * This is the part that turns a recipe from a description into something that
 * either worked or did not. The loop is the one a JVM performs on a distribution:
 *
 *   bind      fill what the recipe deliberately left open (gaps)
 *   probe     find out what this machine actually has
 *   execute   run the command steps in order, in a working directory
 *   verify    check the postconditions the steps claimed they would deliver
 *
 * Three deliberate omissions.
 *
 * 1. **No model call.** Binding fills a gap from a parameter, an environment
 *    variable or the working directory. What is left over is reported as a typed
 *    gap, and filling *that* is the agent's job — which is where a model belongs,
 *    not inside a loop that is supposed to be reproducible.
 * 2. **No verification it cannot perform.** A `dependency` or an `image` condition
 *    is reported as unverifiable rather than assumed to hold. Silence is never a
 *    pass; the same rule the freshness check follows.
 * 3. **No pretence that a tool call is a command.** A recording of `write src/x.ts`
 *    is a pi tool call, not a shell command. pi-tape is not an agent and has no
 *    `write` tool, so such steps are named as the agent's job instead of being run
 *    as a command that would fail with "not found".
 *
 * What it conspicuously does *not* do is provide an environment. There is no
 * container, no toolchain manager and no install step, because every one of those
 * would be a dependency of its own. A procedure's environment is *described*
 * (contracts), *checked* (the probe) and then refused when it is missing — the
 * machine, or the agent, supplies it. That is the honest boundary: pi-tape is the
 * bytecode and the verifier, not the runtime.
 *
 * Execution is injectable, so the loop is tested without running anything.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { Condition, Contracts, Recipe, StepKind } from "./recipe-types.ts";
import { contractsOfSteps } from "./contract.ts";
import { composeRecipe, unfilledGaps, type UnfilledGap } from "./recipe-query.ts";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ExecOptions {
	cwd: string;
	timeoutMs: number;
}

export type Executor = (command: string, options: ExecOptions) => Promise<ExecResult>;

/** Run through a shell, because a step is a command line, not an argv array. */
export const shellExecutor: Executor = (command, options) =>
	new Promise((resolvePromise) => {
		execFile(
			"/bin/sh",
			["-c", command],
			{ cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 1024 * 1024 * 8 },
			(error, stdout, stderr) => {
				const code =
					error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
				resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
			},
		);
	});

// ---------------------------------------------------------------------------
// safety
// ---------------------------------------------------------------------------

interface DangerRule {
	re: RegExp;
	why: string;
}

/**
 * Steps refused unless the caller insists.
 *
 * This is a floor, not a sandbox: a procedure is a recorded command line, and
 * running one runs whatever was recorded. The gate exists so that the obviously
 * destructive case cannot happen by an absent-minded `--yes`, and it is a small,
 * legible list rather than a heuristic pretending to be a security boundary.
 */
const DANGEROUS: DangerRule[] = [
	{ re: /\brm\b[^|;]*\s(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(\/|~|\$HOME)(\/|\s|$)/, why: "deletes a root or home path" },
	{ re: /\bsudo\b/, why: "escalates to root" },
	{ re: /\b(curl|wget)\b[^|;]*\|\s*(ba|z|k)?sh\b/, why: "pipes a download into a shell" },
	{ re: /\bmkfs\b|\bdd\b[^|;]*\bof=\/dev\//, why: "writes to a device" },
	{ re: /:\s*\(\s*\)\s*\{.*\}\s*;?\s*:/, why: "fork bomb" },
	{ re: /\b(chmod|chown)\b[^|;]*\s\/(\s|$)/, why: "changes permissions on a root path" },
	{ re: /\bgit\s+push\b[^|;]*(--force\b|-f\b)/, why: "rewrites remote history" },
	{ re: /\b(shutdown|reboot|halt|poweroff)\b/, why: "stops the machine" },
];

/** The reason a step needs explicit permission, or undefined when it is fine. */
export function dangerOf(step: string): string | undefined {
	for (const rule of DANGEROUS) if (rule.re.test(step)) return rule.why;
	return undefined;
}

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

export interface BindOptions {
	/** Explicit assignments; they win over everything else. */
	set?: Record<string, string>;
	/** Where a secret or environment gap is looked up. Defaults to process.env. */
	env?: Record<string, string | undefined>;
}

export interface BindResult {
	steps: string[];
	gaps: UnfilledGap[];
	/** Where each filled value came from, so the choice can be argued with. */
	notes: string[];
}

/**
 * Variable names that are always the shell's own, never a value someone meant to
 * hand to a recipe.
 *
 * Without this, an open gap called `path` was filled from `$PATH` and turned
 * `sudo rm -rf /` into a command with the whole search path in it. A gap whose
 * name collides with a well-known variable is a coincidence, not a binding.
 */
const SHELL_OWN_VARIABLES = new Set([
	"PATH",
	"HOME",
	"PWD",
	"OLDPWD",
	"SHELL",
	"USER",
	"LOGNAME",
	"TERM",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"EDITOR",
	"PAGER",
	"HOSTNAME",
	"SHLVL",
	"OSTYPE",
	"MACHTYPE",
	"RANDOM",
	"SECONDS",
	"IFS",
]);

/** Gap names too generic to be looked up by name. */
const TOO_GENERIC = new Set([
	"path",
	"target",
	"dir",
	"directory",
	"file",
	"name",
	"arg",
	"package",
	"template",
	"version",
	"script",
	"branch",
	"service",
	"image",
	"repository",
	"port",
	"host",
	"url",
	"endpoint",
	"server",
	"address",
	"command",
	"id",
	"user",
]);

/**
 * Environment variable names a gap could plausibly come from.
 *
 * Only credentials and environment facts are looked up in the environment: those
 * are the two kinds that are *supposed* to live there. A path to a file or a name
 * someone chose is not something the environment can answer, and guessing produced
 * exactly the wrong answer above.
 */
function envCandidates(gap: UnfilledGap): string[] {
	if (gap.kind !== "secret" && gap.kind !== "env") return [];
	if (TOO_GENERIC.has(gap.name.toLowerCase())) return [];
	const upper = gap.name.toUpperCase();
	return [upper, `PI_TAPE_${upper}`, `TAPE_${upper}`].filter((candidate) => !SHELL_OWN_VARIABLES.has(candidate));
}

/**
 * Fill what the recipe left open.
 *
 * A `secret` gap is looked up in the environment under its own name, because that
 * is the one place a credential is meant to live and the one place it does not end
 * up in a file. Everything else follows the same ordering — explicit setting first,
 * then the environment — and whatever is still open stays open, reported with its
 * kind so the caller knows whether to ask, probe or choose.
 */
export function bindRecipe(recipe: Recipe, options: BindOptions = {}): BindResult {
	const assignments = { ...(options.set ?? {}) };
	const env = options.env ?? process.env;
	const notes: string[] = [];

	for (const gap of unfilledGaps(recipe, composeRecipe(recipe, assignments))) {
		if (assignments[gap.name] !== undefined) continue;
		const found = envCandidates(gap).find((candidate) => (env[candidate] ?? "") !== "");
		if (!found) continue;
		assignments[gap.name] = env[found] as string;
		notes.push(`${gap.name} ← $${found} (${gap.kind})`);
	}

	const steps = composeRecipe(recipe, assignments);
	const gaps = unfilledGaps(recipe, steps);
	for (const gap of gaps) notes.push(`${gap.name} left open (${gap.kind}): ${gap.hint}`);

	return { steps, gaps, notes };
}

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

export interface ProbeResult {
	command: string;
	status: "available" | "missing" | "unknown";
	detail?: string;
}

export interface ProbeOptions {
	exec?: Executor;
	cwd?: string;
	timeoutMs?: number;
}

/**
 * Find out what this machine has.
 *
 * A missing command is the most common reason a recorded procedure does not
 * transfer, and it is cheap to check before rather than after. An inconclusive
 * answer — the probe itself could not run — is `unknown`, never `available`.
 */
export async function probeCommands(commands: string[], options: ProbeOptions = {}): Promise<ProbeResult[]> {
	const exec = options.exec ?? shellExecutor;
	const cwd = options.cwd ?? process.cwd();
	const timeoutMs = options.timeoutMs ?? 10_000;

	const results: ProbeResult[] = [];
	for (const command of [...new Set(commands)].sort()) {
		try {
			const result = await exec(`command -v ${JSON.stringify(command)}`, { cwd, timeoutMs });
			if (result.code === 0 && result.stdout.trim()) {
				results.push({ command, status: "available", detail: result.stdout.trim().split("\n")[0] });
				continue;
			}
			// Exit code 1 from `command -v` means "not found". Anything else means the
			// probe did not do what it was asked, which is not evidence either way.
			results.push(
				result.code === 1
					? { command, status: "missing" }
					: { command, status: "unknown", detail: (result.stderr.trim().split("\n")[0] ?? "").slice(0, 160) },
			);
		} catch (error) {
			results.push({ command, status: "unknown", detail: (error as Error).message.slice(0, 160) });
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

export interface ConditionCheck {
	condition: Condition;
	status: "met" | "unmet" | "unverifiable";
	detail?: string;
}

export interface VerifyOptions {
	cwd: string;
	/** Injectable for tests; defaults to the real filesystem. */
	exists?: (path: string) => boolean;
	isDirectory?: (path: string) => boolean;
}

function resolveTarget(target: string, cwd: string): string {
	if (isAbsolute(target)) return target;
	if (target.startsWith("~")) return resolve(process.env.HOME ?? "~", target.slice(2));
	return resolve(cwd, target);
}

/**
 * Check the conditions a chain claimed it would deliver.
 *
 * Only file and directory conditions can be checked without leaving the machine. A
 * dependency or an image needs a registry or a daemon, and saying so is more useful
 * than a guess.
 */
export function verifyConditions(conditions: Condition[], options: VerifyOptions): ConditionCheck[] {
	const exists = options.exists ?? existsSync;
	const isDirectory =
		options.isDirectory ?? ((path: string) => (existsSync(path) ? statSync(path).isDirectory() : false));

	const seen = new Set<string>();
	const checks: ConditionCheck[] = [];

	for (const condition of conditions) {
		const key = `${condition.kind} ${condition.target}`;
		if (seen.has(key)) continue;
		seen.add(key);

		if (condition.target.includes("{{")) {
			checks.push({ condition, status: "unverifiable", detail: "the parameter was never filled" });
			continue;
		}

		if (condition.kind === "file" || condition.kind === "dir") {
			const path = resolveTarget(condition.target, options.cwd);
			const present = exists(path);
			const rightKind = condition.kind === "file" ? true : isDirectory(path);
			checks.push(
				present && rightKind
					? { condition, status: "met", detail: path }
					: {
							condition,
							status: "unmet",
							detail: present ? `${path} exists but is not a directory` : `${path} does not exist`,
						},
			);
			continue;
		}

		checks.push({
			condition,
			status: "unverifiable",
			detail:
				condition.kind === "command"
					? "checked by the probe, not by the filesystem"
					: condition.kind === "dependency"
						? "only a registry can answer; run pi-tape check"
						: "only a daemon can answer",
		});
	}

	return checks;
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

export interface RunnableStep {
	/** Position in the chain, which is what a report has to refer to. */
	index: number;
	command: string;
	kind: StepKind;
}

export type StepStatus = "ok" | "failed" | "skipped" | "refused" | "agent";

export interface StepResult {
	index: number;
	command: string;
	status: StepStatus;
	code: number;
	output: string;
	durationMs: number;
	/** Why a step was refused, or why it belongs to the agent. */
	reason?: string;
}

export interface ExecuteOptions {
	cwd: string;
	exec?: Executor;
	timeoutMs?: number;
	/** Run steps the safety gate flagged. */
	allowDangerous?: boolean;
	/** Keep going after a failure instead of stopping. Default false. */
	continueOnError?: boolean;
	/** Step through the agent's tool calls instead of stopping at them. */
	commandsOnly?: boolean;
	onStep?: (result: StepResult) => void;
}

/**
 * Run the steps in order.
 *
 * A procedure is a sequence, so the default is to stop at the first thing that
 * cannot be carried out: the remaining steps were recorded in a world where the
 * earlier one worked, and running them anyway is how a half-applied procedure
 * turns into a mess. That applies to a tool call as much as to a failure — pi-tape
 * cannot write a file, so it stops and says whose job it is.
 */
export async function executeSteps(steps: RunnableStep[], options: ExecuteOptions): Promise<StepResult[]> {
	const exec = options.exec ?? shellExecutor;
	const timeoutMs = options.timeoutMs ?? 600_000;
	const results: StepResult[] = [];
	let stopped = false;

	for (const step of steps) {
		if (stopped) {
			results.push({ ...step, status: "skipped", code: -1, output: "", durationMs: 0 });
			continue;
		}

		if (step.kind !== "command") {
			const result: StepResult = {
				...step,
				status: options.commandsOnly ? "skipped" : "agent",
				code: -1,
				output: "",
				durationMs: 0,
				reason: `"${step.kind}" is a pi tool call, not a shell command — the agent runs this one`,
			};
			results.push(result);
			options.onStep?.(result);
			if (!options.commandsOnly) stopped = true;
			continue;
		}

		const danger = options.allowDangerous ? undefined : dangerOf(step.command);
		if (danger) {
			const result: StepResult = {
				...step,
				status: "refused",
				code: -1,
				output: `refused: ${danger}. Pass --allow-dangerous to run it anyway.`,
				durationMs: 0,
				reason: danger,
			};
			results.push(result);
			options.onStep?.(result);
			stopped = true;
			continue;
		}

		const started = Date.now();
		let result: StepResult;
		try {
			const execResult = await exec(step.command, { cwd: options.cwd, timeoutMs });
			result = {
				...step,
				status: execResult.code === 0 ? "ok" : "failed",
				code: execResult.code,
				output: `${execResult.stdout}${execResult.stderr}`.trim(),
				durationMs: Date.now() - started,
			};
		} catch (error) {
			result = {
				...step,
				status: "failed",
				code: 1,
				output: (error as Error).message,
				durationMs: Date.now() - started,
			};
		}

		results.push(result);
		options.onStep?.(result);
		if (result.status === "failed" && !options.continueOnError) stopped = true;
	}

	return results;
}

// ---------------------------------------------------------------------------
// the whole plan
// ---------------------------------------------------------------------------

export interface PlanOptions extends BindOptions {
	exec?: Executor;
	cwd?: string;
	timeoutMs?: number;
}

export interface PlanStep extends RunnableStep {
	/** Why the safety gate would refuse this step. */
	danger?: string;
}

export interface Plan {
	/** Recipe names in the order they were chained. */
	fragments: string[];
	steps: PlanStep[];
	contracts: Contracts;
	gaps: UnfilledGap[];
	probe: ProbeResult[];
	/** Steps that are pi tool calls, so pi-tape cannot carry them out. */
	agentSteps: number[];
	notes: string[];
	text: string;
}

/**
 * Work out what would happen, without running anything.
 *
 * The order matters: bind first, because a gap filled from the environment changes
 * the commands; then probe, because a missing tool makes the rest pointless.
 */
export async function planRecipes(recipes: Recipe[], options: PlanOptions = {}): Promise<Plan> {
	const cwd = options.cwd ?? process.cwd();
	const bound: Array<{ recipe: Recipe; steps: string[] }> = [];
	const gaps: UnfilledGap[] = [];
	const notes: string[] = [];

	for (const recipe of recipes) {
		const result = bindRecipe(recipe, options);
		bound.push({ recipe, steps: result.steps });
		gaps.push(...result.gaps);
		notes.push(...result.notes.map((note) => `${recipe.name}: ${note}`));
	}

	// Kinds come from the recipes, in the same order the steps were concatenated.
	const kinds: StepKind[] = [];
	for (const { recipe, steps } of bound) {
		recipe.steps.forEach((step, index) => {
			if (index < steps.length) kinds.push(step.kind);
		});
	}
	const commands = bound.flatMap((item) => item.steps);
	const steps: PlanStep[] = commands.map((command, index) => {
		const kind = kinds[index] ?? "other";
		const danger = kind === "command" ? dangerOf(command) : undefined;
		return danger === undefined ? { index, command, kind } : { index, command, kind, danger };
	});

	// Derived from the bound steps, not from the templates: what gets probed and
	// verified has to be what would actually run.
	const contracts = contractsOfSteps(commands);
	const probed = contracts.requires.filter((item) => item.kind === "command").map((item) => item.target);
	const probe = probed.length ? await probeCommands(probed, { exec: options.exec, cwd }) : [];
	const agentSteps = steps.filter((step) => step.kind !== "command").map((step) => step.index);

	const lines: string[] = [];
	lines.push(`${recipes.length} fragment(s): ${recipes.map((recipe) => recipe.name).join(" → ")}`);
	lines.push("");

	if (notes.length) {
		lines.push("bound");
		for (const note of notes) lines.push(`  · ${note}`);
		lines.push("");
	}

	if (gaps.length) {
		lines.push("gaps — supply these before running");
		for (const gap of gaps) lines.push(`  ? [${gap.kind}] ${gap.name}: ${gap.hint}`);
		lines.push("");
	}

	if (probe.length) {
		lines.push("probe");
		for (const item of probe) {
			const mark = item.status === "available" ? "✓" : item.status === "missing" ? "✗" : "?";
			lines.push(`  ${mark} ${item.command}${item.detail ? `  ${item.detail}` : ""}`);
		}
		lines.push("");
	}

	lines.push("steps");
	for (const step of steps) {
		const marks = [step.danger ? `⚠ ${step.danger}` : "", step.kind === "command" ? "" : `→ agent (${step.kind})`]
			.filter(Boolean)
			.join(" · ");
		lines.push(`  ${String(step.index).padStart(2)}  ${step.command}${marks ? `   ${marks}` : ""}`);
	}

	return {
		fragments: recipes.map((recipe) => recipe.name),
		steps,
		contracts,
		gaps,
		probe,
		agentSteps,
		notes,
		text: lines.join("\n"),
	};
}

/** One line per condition check, for a report. */
export function formatChecks(checks: ConditionCheck[]): string {
	const lines: string[] = [];
	for (const check of checks) {
		const mark = check.status === "met" ? "✓" : check.status === "unmet" ? "✗" : "?";
		lines.push(`  ${mark} ${check.condition.kind} ${check.condition.target}${check.detail ? `  ${check.detail}` : ""}`);
	}
	return lines.join("\n");
}
