/**
 * Freshness: is a recipe still true?
 *
 * A recording is a snapshot of a moment. A recipe derived from it names tools,
 * packages and versions that the world can move out from under. The only honest
 * answer is to check, so a recipe carries validators — shell commands that should
 * keep succeeding while the recipe remains valid — and this module runs them.
 *
 * Where a validator cannot be run (no network, no npm), the result says so
 * instead of guessing. Silence is not freshness.
 */

import { execFile } from "node:child_process";
import type { Recipe } from "./recipe-types.ts";

export type FreshnessStatus = "fresh" | "stale" | "unknown" | "unchecked";

export interface ValidatorOutcome {
	command: string;
	describes: string;
	status: FreshnessStatus;
	/** First line of stderr, or the reason the check could not run. */
	detail?: string;
	durationMs: number;
}

export interface FreshnessReport {
	recipe: string;
	status: FreshnessStatus;
	checkedAt: string;
	/** Age of the recipe's last update, in days. */
	ageDays: number;
	validators: ValidatorOutcome[];
	/** Validators that failed. */
	staleChecks: ValidatorOutcome[];
	/** Validators that could not be evaluated. */
	unknownChecks: ValidatorOutcome[];
}

export interface FreshnessOptions {
	timeoutMs?: number;
	/** Skip execution and report everything as unchecked (dry runs, tests). */
	dryRun?: boolean;
	/** Treat a recipe older than this many days as at least "unknown". Default 30. */
	maxAgeDays?: number;
}

function run(command: string, timeoutMs: number): Promise<{ code: number; stderr: string }> {
	return new Promise((resolve) => {
		// Run through a shell because validators are authored as command lines, and
		// the argv is not ours to split confidently on every platform.
		execFile(
			"/bin/sh",
			["-c", command],
			{ timeout: timeoutMs, maxBuffer: 1024 * 256 },
			(error, _stdout, stderr) => {
				if (!error) {
					resolve({ code: 0, stderr: "" });
					return;
				}
				const code = typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
				resolve({ code, stderr: String(stderr || (error as Error).message) });
			},
		);
	});
}

export async function checkFreshness(recipe: Recipe, options: FreshnessOptions = {}): Promise<FreshnessReport> {
	const timeoutMs = options.timeoutMs ?? 20_000;
	const maxAgeDays = options.maxAgeDays ?? 30;
	const ageDays = Math.max(0, (Date.now() - Date.parse(recipe.updatedAt || recipe.createdAt)) / 86_400_000);

	const outcomes: ValidatorOutcome[] = [];

	for (const validator of recipe.validators) {
		if (options.dryRun) {
			outcomes.push({
				command: validator.command,
				describes: validator.describes,
				status: "unchecked",
				detail: "dry run",
				durationMs: 0,
			});
			continue;
		}

		const started = Date.now();
		const result = await run(validator.command, timeoutMs);
		const durationMs = Date.now() - started;

		if (result.code === 0) {
			outcomes.push({
				command: validator.command,
				describes: validator.describes,
				status: "fresh",
				durationMs,
			});
			continue;
		}

		const stderr = result.stderr.trim().split("\n")[0] ?? "";
		// A missing tool or a dead network is not evidence that the recipe is wrong.
		const inconclusive = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network|offline|command not found|ENOENT|EACCES/i.test(stderr);
		outcomes.push({
			command: validator.command,
			describes: validator.describes,
			status: inconclusive ? "unknown" : "stale",
			detail: stderr.slice(0, 200),
			durationMs,
		});
	}

	const staleChecks = outcomes.filter((outcome) => outcome.status === "stale");
	const unknownChecks = outcomes.filter((outcome) => outcome.status === "unknown" || outcome.status === "unchecked");

	let status: FreshnessStatus;
	if (staleChecks.length > 0) status = "stale";
	else if (outcomes.length === 0) status = ageDays > maxAgeDays ? "unknown" : "unchecked";
	else if (unknownChecks.length === outcomes.length) status = "unknown";
	else status = "fresh";

	// Age alone never marks a recipe stale — only a failed check may — but an old
	// recipe with inconclusive checks is reported as unknown rather than trusted.
	if (status === "fresh" && ageDays > maxAgeDays && unknownChecks.length > 0) status = "unknown";

	return {
		recipe: recipe.name,
		status,
		checkedAt: new Date().toISOString(),
		ageDays: Math.round(ageDays * 10) / 10,
		validators: outcomes,
		staleChecks,
		unknownChecks,
	};
}

export function formatFreshness(report: FreshnessReport): string {
	const icon =
		report.status === "fresh" ? "✓" : report.status === "stale" ? "✗" : report.status === "unknown" ? "?" : "·";
	const lines = [
		`${icon} ${report.recipe}: ${report.status} (recipe is ${report.ageDays} day(s) old, ${report.validators.length} validator(s))`,
	];

	for (const outcome of report.validators) {
		const mark = outcome.status === "fresh" ? "  ✓" : outcome.status === "stale" ? "  ✗" : "  ?";
		lines.push(`${mark} ${outcome.command}${outcome.detail ? ` — ${outcome.detail}` : ""}`);
		if (outcome.status === "stale") lines.push(`      ${outcome.describes}`);
	}

	if (report.status === "unknown" && report.validators.length === 0) {
		lines.push("  no validators recorded: freshness cannot be established from this recipe alone");
	}
	if (report.status === "stale") {
		lines.push("  → the recipe needs re-learning: record a fresh tape and splice again");
	}

	return lines.join("\n");
}
