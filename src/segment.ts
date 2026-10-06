/**
 * Segments: cutting a recorded procedure at goal boundaries.
 *
 * A step is one tool call. That is the right unit for alignment — two recordings
 * agree on `npm install <*>` — but the wrong unit for reuse. Nobody wants "step 4
 * of the frontend recipe"; they want "the part that adds the router", so it can be
 * carried into another composition.
 *
 * So a segment is a **range of steps plus an intent**. The intent is the one thing
 * here that is a judgement rather than a fact, which is why it is a parameter and
 * not a guess: this module slices what it is told to slice and refuses to invent
 * boundaries. Deciding *where* to cut is the model's job, and
 * `segmentEvidence()` gives it exactly the material to decide with.
 *
 * Slicing is deterministic and checked: the ranges must tile the procedure exactly,
 * because overlapping segments would silently run a step twice.
 */

import type { Parameter, Recipe, Segment, Slot, Step } from "./recipe-types.ts";
import { emptyRecipe } from "./recipe-types.ts";
import { contractsOfSteps } from "./contract.ts";
import type { GapKind } from "./redact.ts";

export interface CutRequest {
	/** Inclusive first step index into the source recipe. */
	from: number;
	/** Inclusive last step index. */
	to: number;
	name: string;
	/** One line on what this piece is for. */
	intent?: string;
}

/**
 * A cut as the caller wrote it.
 *
 * The segment name is derived -- a slug of the intent, or the range when there is
 * no intent -- so an error message that uses it names something the caller never
 * typed. The range and the intent are what they did type.
 */
function describeCut(cut: CutRequest): string {
	const intent = cut.intent ? ` ("${cut.intent}")` : "";
	return `cut ${cut.from}-${cut.to}${intent}`;
}

export interface SliceResult {
	segments: Segment[];
	/** Parameters of the source that no segment could keep, with the reason. */
	droppedParameters: Array<{ name: string; reason: string }>;
	/** Step ranges no cut covered. Extraction is allowed to leave the rest behind. */
	uncovered: Array<{ from: number; to: number }>;
}

export interface SliceOptions {
	/**
	 * Require the cuts to cover every step.
	 *
	 * Off by default, because the normal use is extraction: "give me the part that
	 * adds the router" is allowed to leave the rest where it is. Turn it on when the
	 * segments are meant to be the whole procedure again, where a missing range is a
	 * silently dropped step.
	 */
	requireCoverage?: boolean;
}

/**
 * The material a model needs to propose boundaries: every step numbered, with what
 * it needs and what it leaves behind, and what varies.
 *
 * Numbered indices are the interface. A model that answers with `from`/`to` values
 * is answering a question this module can check, which is the difference between a
 * suggestion and a claim.
 */
export function segmentEvidence(recipe: Recipe): string {
	const lines: string[] = [];
	lines.push(`recipe "${recipe.name}" — ${recipe.steps.length} step(s), ${recipe.parameters.length} parameter(s)`);
	if (recipe.description) lines.push(recipe.description);
	lines.push("");
	lines.push("steps:");
	recipe.steps.forEach((step, index) => {
		const gapKinds = step.slotKinds ?? {};
		const gaps = step.usesSlots.map((slot) => `${slot}:${gapKinds[slot] ?? "free"}`).join(", ");
		lines.push(`  [${index}] ${step.template}`);
		lines.push(`      ${step.kind}${gaps ? ` · slots ${gaps}` : " · no slots"}`);
	});

	if (recipe.parameters.length) {
		lines.push("");
		lines.push("parameters (a cut must not split one):");
		for (const parameter of recipe.parameters) {
			const members = parameter.members.map((member) => `${member.stepIndex}#${member.slot}`).join(", ");
			const variants = parameter.variants.map((variant) => variant.label).join(" | ");
			lines.push(`  ${parameter.name} [${parameter.kind}]  members ${members}`);
			lines.push(`      ${variants}`);
		}
	}

	const contracts = contractsOfSteps(recipe.steps.map((step) => step.template));
	if (contracts.requires.length || contracts.provides.length) {
		lines.push("");
		lines.push("contracts of the whole recipe:");
		for (const condition of contracts.requires) lines.push(`  needs ${condition.kind} ${condition.target}`);
		for (const condition of contracts.provides) lines.push(`  gives ${condition.kind} ${condition.target}`);
	}

	return lines.join("\n");
}

/**
 * Slice a recipe into segments.
 *
 * Every step must land in exactly one segment: a gap in the ranges would drop a
 * step, and an overlap would run one twice. Both are refused rather than papered
 * over, because a segment chain that silently repeats a step is worse than no
 * segmentation at all.
 */
export function sliceRecipe(recipe: Recipe, cuts: CutRequest[], options: SliceOptions = {}): SliceResult {
	if (cuts.length === 0) throw new Error("sliceRecipe needs at least one cut");

	const ordered = [...cuts].sort((a, b) => a.from - b.from);
	let next = 0;
	for (const cut of ordered) {
		if (!Number.isInteger(cut.from) || !Number.isInteger(cut.to) || cut.from < 0 || cut.to < cut.from) {
			throw new Error(`${describeCut(cut)} is not a step range`);
		}
		if (cut.to > recipe.steps.length - 1) {
			throw new Error(
				`${describeCut(cut)} ends at step ${cut.to}, but the recipe has ${recipe.steps.length} step(s) ` +
					`(last index ${recipe.steps.length - 1})`,
			);
		}
		// Overlap is always a mistake: it would run a step twice.
		if (cut.from < next) {
			throw new Error(
				`${describeCut(cut)} starts at ${cut.from}, which is already inside an earlier cut (up to ${next - 1}). ` +
					`Segments must not overlap.`,
			);
		}
		next = cut.to + 1;
	}

	// Which steps no cut covers, so a missing piece is named instead of assumed.
	const uncovered: SliceResult["uncovered"] = [];
	let cursor = 0;
	for (const cut of ordered) {
		if (cut.from > cursor) uncovered.push({ from: cursor, to: cut.from - 1 });
		cursor = cut.to + 1;
	}
	if (cursor <= recipe.steps.length - 1) uncovered.push({ from: cursor, to: recipe.steps.length - 1 });
	if (options.requireCoverage && uncovered.length) {
		throw new Error(
			`the cuts do not cover every step: ${uncovered.map((range) => `${range.from}-${range.to}`).join(", ")} ` +
				`(of 0-${recipe.steps.length - 1}) would be dropped`,
		);
	}

	const droppedParameters: SliceResult["droppedParameters"] = [];
	const droppedNames = new Set<string>();
	const usedParameterNames = new Set<string>();
	const segments: Segment[] = [];

	for (const cut of ordered) {
		const steps = recipe.steps.slice(cut.from, cut.to + 1).map((step) => structuredClone(step));
		const slots = recipe.slots
			.filter((slot) => slot.stepIndex >= cut.from && slot.stepIndex <= cut.to)
			.map((slot) => ({ ...structuredClone(slot), stepIndex: slot.stepIndex - cut.from }));

		const parameters: Parameter[] = [];
		for (const parameter of recipe.parameters) {
			const inside = parameter.members.every((member) => member.stepIndex >= cut.from && member.stepIndex <= cut.to);
			if (!inside) {
				// A parameter that spans the cut is not lost by accident; it is
				// reported once, because the caller has to decide which side owns it.
				if (
					!droppedNames.has(parameter.name) &&
					parameter.members.some((member) => member.stepIndex >= cut.from && member.stepIndex <= cut.to)
				) {
					droppedNames.add(parameter.name);
					droppedParameters.push({
						name: parameter.name,
						reason: `spans the cut at ${cut.from}-${cut.to}; its members must move together`,
					});
				}
				continue;
			}
			parameters.push({
				...structuredClone(parameter),
				members: parameter.members.map((member) => ({ ...member, stepIndex: member.stepIndex - cut.from })),
			});
			usedParameterNames.add(parameter.name);
		}

		segments.push({
			name: cut.name,
			intent: cut.intent ?? "",
			from: cut.from,
			to: cut.to,
			source: recipe.name,
			steps,
			slots,
			parameters,
			contracts: contractsOfSteps(steps.map((step) => step.template)),
			outcome: structuredClone(recipe.outcome),
		});
	}

	return { segments, droppedParameters, uncovered };
}

/**
 * Turn a segment back into a recipe, so it can be stored, searched and linked like
 * any other piece of learned knowledge.
 */
export function segmentToRecipe(segment: Segment, options: { scope?: Recipe["scope"] } = {}): Recipe {
	const recipe = emptyRecipe(segment.name, options.scope ?? "global");
	recipe.description = segment.intent
		? `${segment.intent} (from "${segment.source}", steps ${segment.from}-${segment.to})`
		: `Segment of "${segment.source}", steps ${segment.from}-${segment.to}`;
	recipe.observations = 1;
	recipe.steps = segment.steps.map((step) => structuredClone(step));
	recipe.slots = segment.slots.map((slot) => structuredClone(slot));
	recipe.parameters = segment.parameters.map((parameter) => structuredClone(parameter));
	recipe.contracts = contractsOfSteps(recipe.steps.map((step) => step.template));
	recipe.outcome = structuredClone(segment.outcome);

	// A single segment of one procedure has no family to compare against, so
	// orthogonality is not measurable here. Saying 0 would read as "unrelated";
	// leaving the recipe without a number and describing the source is honest.
	recipe.orthogonality = 0;
	return recipe;
}

/** Parse `3-7` into a range. Accepts `5` as the single-step range `5-5`. */
export function parseRange(text: string): { from: number; to: number } {
	const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(text.trim());
	if (!match) throw new Error(`expected a step range like 0-2 or 4, got "${text}"`);
	const from = Number(match[1]);
	const to = match[2] === undefined ? from : Number(match[2]);
	if (to < from) throw new Error(`range "${text}" ends before it starts`);
	return { from, to };
}

/** The gap kinds a segment exposes, for a one-line summary. */
export function segmentGaps(segment: Segment): Array<{ name: string; kind: GapKind }> {
	const out = new Map<string, GapKind>();
	for (const step of segment.steps) {
		for (const [name, kind] of Object.entries((step as Step).slotKinds ?? {})) out.set(name, kind);
	}
	for (const slot of segment.slots as Slot[]) if (!out.has(slot.name)) out.set(slot.name, slot.kind);
	return [...out.entries()].map(([name, kind]) => ({ name, kind }));
}
