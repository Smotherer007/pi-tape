/**
 * Extract a recipe from a single recording.
 *
 * This is the heuristic step, and the honest weak point of the whole pipeline: a
 * shell command is a string, not an AST, so "what was one meaningful step" is an
 * interpretation rather than a fact. Everything derived here is marked with how
 * much support it had, so the intersection pass and a human reader can tell
 * inference from observation.
 *
 * No model is involved. Given the same recording this always produces the same
 * recipe.
 */

import type { Recipe, Step, Slot, StepKind } from "./recipe-types.ts";
import { emptyRecipe } from "./recipe-types.ts";
import { resolveEntries } from "./tape.ts";
import { messageOf, toolCallsOf, type SessionEntry } from "./session.ts";
import { analyzeCommand, renderTemplate, categorizeFile, shapeAction, tokenizeShell } from "./normalize.ts";
import type { TapeFile } from "./types.ts";

/** Verbs that scaffold a new project, where a trailing bare argument is its name. */
const SCAFFOLD_VERBS = /^(npm|npx|pnpm|yarn|bun) create$|^cargo new$|^git clone$|^mkdir$|^ng new$|^vue create$/;

export interface ExtractOptions {
	name?: string;
	scope?: "global" | "project";
	/** Drop tool calls whose verb appears in this list (e.g. pure reconnaissance). */
	excludeVerbs?: string[];
}

export interface ExtractResult {
	recipe: Recipe;
	/** Every tool call in order, before any interpretation. */
	sequence: Array<{ key: string; verb: string; kind: StepKind; template: string; example: string }>;
	/** The raw entries walked, for diagnostics. */
	entries: SessionEntry[];
}

/** Guess a slot name from what was replaced and where. */
export function proposeSlotName(verb: string, literal: string, command: string): string {
	const tokens = tokenizeShell(command);

	// `git checkout -b feat/x` -> branch
	if (/(-b|--branch)$/.test(tokens[tokens.indexOf(literal) - 1] ?? "")) return "branch";

	if (/^v?\d+\.\d+/.test(literal)) return "version";
	if (literal.includes("/") || literal.startsWith(".") || literal.startsWith("~")) return "path";
	if (/^\d{4,}$/.test(literal)) return "id";
	if (/\.(ts|tsx|js|jsx|vue|svelte|json|py|go|rs|md|ya?ml|toml|sh)$/.test(literal)) return "file";

	// The trailing argument of a scaffolding command is the project name.
	if (SCAFFOLD_VERBS.test(verb)) {
		const last = tokens[tokens.length - 1];
		if (last === literal) return "name";
	}

	// `npm install <pkg>` / `npm i <pkg>` -> package
	if (/^(npm|pnpm|yarn|bun) (install|i|add|remove|rm|uninstall)$/.test(verb)) return "package";
	if (/^(npx|bunx)$/.test(verb)) return "package";

	return "arg";
}

function makeUnique(base: string, used: Set<string>): string {
	if (!used.has(base)) {
		used.add(base);
		return base;
	}
	let n = 2;
	while (used.has(`${base}${n}`)) n++;
	used.add(`${base}${n}`);
	return `${base}${n}`;
}

/** Build the step and slot candidates for one recorded tool call. */
function buildStep(
	toolName: string,
	args: Record<string, unknown>,
): { step: Step; slots: Array<{ name: string; value: string }> } {
	const shaped = shapeAction(toolName, args);

	if (shaped.kind === "command" && typeof args.command === "string") {
		const analyzed = analyzeCommand(args.command);
		const used = new Set<string>();
		const named = new Map<string, string>();

		const { template, slots } = renderTemplate(analyzed, (token, occurrence) => {
			const literal = token.literal ?? "";
			// Identical literals in one command share a slot; that is what makes
			// `cp a a` and `cp a b` differ in the right place.
			const existing = named.get(`${literal}#${occurrence}`);
			if (existing) return existing;
			// Position wins over content: normalization knows that the third argument
			// of `npm install` is a package regardless of what it is called.
			const name = makeUnique(token.suggested ?? proposeSlotName(analyzed.verb, literal, args.command as string), used);
			named.set(`${literal}#${occurrence}`, name);
			return name;
		});

		const step: Step = {
			key: shaped.key,
			verb: shaped.verb,
			kind: "command",
			template,
			example: shaped.example,
			usesSlots: [...new Set(slots.map((slot) => slot.name))],
			slotValues: Object.fromEntries(slots.map((slot) => [slot.name, slot.value])),
			noise: shaped.noise,
		};
		return { step, slots };
	}

	const isFileStep = shaped.kind === "read" || shaped.kind === "write" || shaped.kind === "edit";
	const step: Step = {
		key: shaped.key,
		verb: shaped.verb,
		kind: shaped.kind,
		template: shaped.template,
		example: shaped.example,
		usesSlots: isFileStep ? ["path"] : [],
		slotValues: isFileStep && shaped.literals[0] ? { path: shaped.literals[0].value } : {},
		noise: shaped.noise,
	};
	return { step, slots: shaped.literals };
}

/**
 * Derive validators from external dependencies referenced by the recording.
 *
 * This is what makes freshness checkable: a recipe learned months ago is only
 * trustworthy while the tools it names still resolve.
 *
 * Only arguments that the positional rules identified as a *package* or
 * *template* count. Taking every non-flag argument after `npm create` would treat
 * the project name as a dependency and produce a validator for `app-one`, which
 * does not exist and never will.
 */
export function deriveValidators(commands: string[]): Recipe["validators"] {
	const validators: Recipe["validators"] = [];
	const seen = new Set<string>();

	for (const command of commands) {
		const analyzed = analyzeCommand(command);
		if (!/^(npm|pnpm|yarn|bun|npx|bunx|cargo|go) /.test(analyzed.verb)) continue;

		for (const segment of analyzed.segments) {
			for (const token of segment.tokens) {
				if (token.suggested !== "package" && token.suggested !== "template") continue;
				// `vue@latest` and `vue` both name the package `vue`.
				const name = (token.literal ?? token.raw).split("@")[0] as string;
				if (!name || name.startsWith("-") || seen.has(name)) continue;
				seen.add(name);
				validators.push({
					command: `npm view ${name} version`,
					describes: `the "${name}" package this recipe depends on still exists and is fetchable`,
				});
				if (validators.length >= 12) return validators;
			}
		}
	}

	return validators;
}

/** Everything a recipe can be built from. */
export function extractRecipe(tape: TapeFile, options: ExtractOptions = {}): ExtractResult {
	const entries = resolveEntries(tape);
	const recipe = emptyRecipe(options.name ?? tape.name ?? tape.id.slice(7, 19), options.scope ?? "global");
	recipe.learnedFrom = [tape.id];
	recipe.description =
		tape.name !== undefined ? `Learned from "${tape.name}"` : `Learned from tape ${tape.id.slice(7, 19)}`;

	const sequence: ExtractResult["sequence"] = [];
	const commands: string[] = [];
	const slotsByName = new Map<string, Slot>();
	const exclude = new Set(options.excludeVerbs ?? []);

	for (const entry of entries) {
		for (const call of toolCallsOf(entry)) {
			const args = (call.arguments ?? {}) as Record<string, unknown>;
			const built = buildStep(call.name, args);
			if (exclude.has(built.step.verb)) continue;

			sequence.push({
				key: built.step.key,
				verb: built.step.verb,
				kind: built.step.kind,
				template: built.step.template,
				example: built.step.example,
			});
			const stepIndex = recipe.steps.length;
			recipe.steps.push(built.step);

			if (typeof args.command === "string") commands.push(args.command);

			for (const slot of built.slots) {
				// Slots are scoped to their step. Aggregating by name across steps would
				// silently merge unrelated positions.
				const mapKey = `${stepIndex}#${slot.name}`;
				const existing = slotsByName.get(mapKey);
				if (existing) {
					const filler = existing.fillers.find((item) => item.value === slot.value);
					if (filler) {
						filler.observedIn++;
					} else {
						existing.fillers.push({
							value: slot.value,
							observedIn: 1,
							learnedAt: new Date().toISOString(),
							sources: [tape.id],
						});
					}
				} else {
					slotsByName.set(mapKey, {
						name: slot.name,
						stepIndex,
						stepKey: built.step.key,
						description: `Values observed where the tape used "${slot.value}" in ${built.step.verb}`,
						// A single recording cannot tell variance from noise.
						variance: 0,
						fillers: [
							{
								value: slot.value,
								observedIn: 1,
								learnedAt: new Date().toISOString(),
								sources: [tape.id],
							},
						],
					});
				}
			}
		}
	}

	recipe.slots = [...slotsByName.values()];
	recipe.validators = deriveValidators(commands);
	recipe.observations = 1;

	const distinct = new Set(recipe.steps.map((step) => step.key)).size;
	const meaningful = recipe.steps.filter((step) => !step.noise).length;
	recipe.orthogonality = recipe.steps.length ? distinct / recipe.steps.length : 0;
	void meaningful;

	return { recipe, sequence, entries };
}

/** Rewrite a template's placeholders to canonical slot names. */
export function renameTemplate(template: string, mapping: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
		const target = mapping[name];
		return target === undefined ? match : `{{${target}}}`;
	});
}

/** File categories touched, for a one-line recipe summary. */
export function touchedCategories(recipe: Recipe): string[] {
	const out = new Set<string>();
	for (const step of recipe.steps) {
		if (step.kind === "read" || step.kind === "write" || step.kind === "edit") {
			out.add(step.verb);
		}
	}
	return [...out].sort();
}

export { categorizeFile };
