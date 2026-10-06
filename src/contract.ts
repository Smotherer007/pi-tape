/**
 * Contracts and linking: what makes composition checkable.
 *
 * You cannot concatenate two recordings — the second fragment's answers depend on a
 * context the first never produced. But you *can* say what a fragment needs before
 * it runs and what it leaves behind, and then ask whether fragment B's requirements
 * are met by fragment A's results. What is left over is the gap, and that gap is a
 * precise job description for a model or a human.
 *
 * This engine is deliberately small. It knows three things:
 *
 *   - a tool-shaped step (`write <path>`, `read <path>`) says what it does;
 *   - `sudo X` is a privilege request wrapped around X, so X is the real step;
 *   - a shell line is a sequence of `&&`-separated segments, each judged on its own.
 *
 * Everything else — which commands exist, what a `docker build` needs, what
 * `npm install` produces — comes from a **rule pack** (`rules.ts`). The engine has
 * no idea Docker is a thing, which is the point: ecosystem knowledge is replaceable
 * data, not a dependency of the core. A repository that has never heard of Docker
 * never has to care that a Docker pack exists.
 *
 * Nothing here is executed and no model is called.
 */

import type { Condition, Contracts } from "./recipe-types.ts";
import { emptyContracts } from "./recipe-types.ts";
import { condition, deriveConditions, type DeriveOptions, type Segment } from "./rules.ts";

export type StepContractOptions = DeriveOptions;

/**
 * Fold the conditions of many steps into one contract, preserving step order.
 *
 * Deduplicated per list: `npm install a` and `npm run build` both need `npm`, and a
 * contract that says "needs command npm" twice reads like two different
 * requirements. The first note wins, so a condition keeps the step that introduced
 * it as its provenance. Requires and provides are deduplicated separately, because
 * a step may legitimately sit on both sides.
 */
export function contractsOfSteps(steps: string[], options: DeriveOptions = {}): Contracts {
	const out = emptyContracts();
	const seenRequires = new Set<string>();
	const seenProvides = new Set<string>();

	for (const step of steps) {
		const conditions = stepConditions(step, options);
		for (const condition of conditions.requires) {
			const key = `${condition.kind} ${condition.target}`;
			if (seenRequires.has(key)) continue;
			seenRequires.add(key);
			out.requires.push(condition);
		}
		for (const condition of conditions.provides) {
			const key = `${condition.kind} ${condition.target}`;
			if (seenProvides.has(key)) continue;
			seenProvides.add(key);
			out.provides.push(condition);
		}
	}
	return out;
}

/**
 * The conditions implied by a single step.
 *
 * A step is either a tool-shaped step (`write <path>`, `read <path>`) or a shell
 * command, possibly several joined by `&&`, `;` or `|`.
 */
export function stepConditions(step: string, options: DeriveOptions = {}): Contracts {
	const out = emptyContracts();
	const text = step.trim();
	if (!text) return out;

	// Tool-shaped steps: the identity of the step already says what it does, and no
	// rule pack has to know about the tool a recording happened to use.
	const tool = /^(read|write|edit|glob|grep)\s+(\S.*)$/.exec(text);
	if (tool) {
		const verb = tool[1] as string;
		const path = (tool[2] as string).trim();
		if (verb === "read" || verb === "grep") out.requires.push(condition("file", path, text));
		if (verb === "write") out.provides.push(condition("file", path, text));
		if (verb === "edit") {
			out.requires.push(condition("file", path, text));
			out.provides.push(condition("file", path, text));
		}
		return out;
	}

	for (const segment of text.split(/&&|\|\||;|\|/)) segmentConditions(segment.trim(), out, options);
	return out;
}

function segmentConditions(segment: string, out: Contracts, options: DeriveOptions): void {
	if (!segment) return;
	const tokens = segment.split(/\s+/).filter(Boolean);
	const verb = tokens[0] as string;

	// Raising privilege is not the step; what runs under it is. Treating `sudo apt`
	// as a tool called `sudo` would hide the command that actually matters.
	if (verb === "sudo") {
		out.requires.push(condition("command", "sudo", segment));
		const rest = tokens.slice(1).filter((token) => !token.startsWith("-"));
		if (rest.length) segmentConditions(rest.join(" "), out, options);
		return;
	}

	const implied: Segment = { verb, argv: tokens.slice(1), text: segment };
	const derived = deriveConditions(implied, options);
	out.requires.push(...derived.requires);
	out.provides.push(...derived.provides);
}

function carriesPlaceholder(condition: Condition): boolean {
	return condition.target.includes("{{");
}

/** True when a provision covers a requirement. */
export function satisfies(provided: Condition, required: Condition): boolean {
	if (required.kind === "command") return false;
	if (provided.target === required.target) return true;
	// A directory provides everything inside it.
	if (provided.kind === "dir" && required.target.startsWith(`${provided.target}/`)) return true;
	return false;
}

export interface Fragment {
	name: string;
	/** Concrete steps, i.e. `composeRecipe` output. */
	steps: string[];
}

export interface LinkReport {
	/** Conditions met by an earlier fragment, with the fragment that met them. */
	satisfied: Array<{ condition: Condition; providedBy: string }>;
	/** Conditions nothing provided. This is the job for a model or a human. */
	gaps: Array<{ condition: Condition; requiredBy: string }>;
	/** Host tools and other commands to probe before running. */
	environment: string[];
	/** Conditions still carrying `{{placeholders}}`, so they could not be judged. */
	unresolved: Array<{ condition: Condition; inFragment: string }>;
	/** A condition provided by more than one fragment. Not fatal, but worth seeing. */
	overlaps: Array<{ condition: Condition; providers: string[] }>;
	/**
	 * What the chain leaves behind: provisions no later fragment consumed. This is
	 * the end state of the composition, and it is what tells you the fragments
	 * joined up instead of quietly dropping each other's results.
	 */
	result: Condition[];
	resolved: boolean;
	text: string;
}

function label(condition: Condition): string {
	return `${condition.kind} ${condition.target}`;
}

/**
 * Chain fragments and report the seam between them.
 *
 * Fragments are checked in the order given, and so are their steps: a fragment that
 * writes `Dockerfile` and then builds an image satisfies its own requirement, which
 * is the honest reading — the two steps really are in the same recording.
 */
export function linkFragments(fragments: Fragment[], options: DeriveOptions = {}): LinkReport {
	const available: Array<{ condition: Condition; by: string }> = [];
	const satisfied: LinkReport["satisfied"] = [];
	const gaps: LinkReport["gaps"] = [];
	const unresolved: LinkReport["unresolved"] = [];
	const overlaps: LinkReport["overlaps"] = [];
	const environment = new Set<string>();

	for (const fragment of fragments) {
		for (const step of fragment.steps) {
			const conditions = stepConditions(step, options);

			for (const requirement of conditions.requires) {
				if (requirement.kind === "command") {
					environment.add(requirement.target);
					continue;
				}
				if (carriesPlaceholder(requirement)) {
					unresolved.push({ condition: requirement, inFragment: fragment.name });
					continue;
				}
				const hit = available.find((candidate) => satisfies(candidate.condition, requirement));
				if (hit) satisfied.push({ condition: requirement, providedBy: hit.by });
				else gaps.push({ condition: requirement, requiredBy: fragment.name });
			}

			for (const provision of conditions.provides) {
				if (carriesPlaceholder(provision)) {
					unresolved.push({ condition: provision, inFragment: fragment.name });
					continue;
				}
				const existing = available.filter((candidate) => satisfies(candidate.condition, provision));
				if (existing.length) {
					const providers = [...new Set(existing.map((candidate) => candidate.by))].filter(
						(provider) => provider !== fragment.name,
					);
					if (providers.length) overlaps.push({ condition: provision, providers: [...providers, fragment.name] });
				}
				available.push({ condition: provision, by: fragment.name });
			}
		}
	}

	// What the chain leaves behind. The last fragment's own provisions are usually
	// here, but a fragment that only *consumes* (running a container, deploying)
	// would otherwise make the result look empty even though the chain worked.
	const consumed = new Set<string>();
	for (const item of satisfied) {
		for (const candidate of available) {
			if (satisfies(candidate.condition, item.condition)) consumed.add(label(candidate.condition));
		}
	}
	const result: Condition[] = [];
	const seenResult = new Set<string>();
	for (const candidate of available) {
		const key = label(candidate.condition);
		if (consumed.has(key) || seenResult.has(key) || carriesPlaceholder(candidate.condition)) continue;
		seenResult.add(key);
		result.push(candidate.condition);
	}

	const resolved = gaps.length === 0 && unresolved.length === 0;
	const lines: string[] = [];
	lines.push(`linking ${fragments.length} fragment(s): ${fragments.map((fragment) => fragment.name).join(" → ")}`);
	lines.push("");

	if (satisfied.length) {
		lines.push("met");
		for (const item of satisfied) lines.push(`  ✓ ${label(item.condition)}  ← ${item.providedBy}`);
		lines.push("");
	}

	if (gaps.length) {
		lines.push("gaps — nothing in the chain provides these");
		for (const item of gaps) lines.push(`  ✗ ${label(item.condition)}  (needed by ${item.requiredBy})`);
		lines.push("");
	}

	if (unresolved.length) {
		lines.push("unresolved — a parameter is still unset");
		for (const item of unresolved) lines.push(`  ? ${label(item.condition)}  (in ${item.inFragment})`);
		lines.push("");
	}

	if (environment.size) {
		lines.push(`probe before running: ${[...environment].sort().join(", ")}`);
		lines.push("");
	}

	if (result.length) {
		lines.push(`left behind: ${result.map(label).join(", ")}`);
		lines.push("");
	}

	if (overlaps.length) {
		lines.push("provided more than once");
		for (const item of overlaps) lines.push(`  ~ ${label(item.condition)}  (${item.providers.join(", ")})`);
		lines.push("");
	}

	return {
		satisfied,
		gaps,
		environment: [...environment].sort(),
		unresolved,
		overlaps,
		result,
		resolved,
		text: lines.join("\n").trimEnd(),
	};
}

export { condition } from "./rules.ts";
