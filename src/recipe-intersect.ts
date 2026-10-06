/**
 * Intersect several recipes into one.
 *
 * This is what turns recordings into knowledge that composes. Given k recordings
 * of the same kind of task, it produces:
 *
 *   skeleton    steps present in at least `minSupport` of the recordings
 *   slots       positions where the recordings consistently differed
 *   fillers     the values observed at each slot, one per variant
 *   parameters  groups of slots that vary *together* across recordings
 *
 * The alignment is a longest-common-subsequence match against a medoid
 * reference, which is robust to insertions and deletions: a recording that
 * skipped or repeated a step still aligns on the rest.
 *
 * Two numbers matter:
 *   orthogonality   invariant steps / longest observed run. High means the family
 *                   really shares a skeleton, so a filler swap transfers
 *                   knowledge instead of requiring a rewrite.
 *   parameters      a parameter is the thing you actually swap. One parameter
 *                   change rewrites every slot in its group at once, which is
 *                   what makes "Vue -> React" a value change and not a rewrite.
 */

import type { Parameter, Recipe, Slot, Step, GapKind } from "./recipe-types.ts";
import { emptyRecipe } from "./recipe-types.ts";
import { proposeSlotName, renameTemplate } from "./recipe-extract.ts";
import { classifyGapKind, mustStayOpen } from "./redact.ts";
import { contractsOfSteps } from "./contract.ts";
import { combineOutcomes } from "./outcome.ts";

/** Standard dynamic-programming LCS, returning matched index pairs. */
export function lcsAlignment(a: string[], b: string[]): Array<[number, number]> {
	const n = a.length;
	const m = b.length;
	if (n === 0 || m === 0) return [];

	// lengths[i][j] = LCS of a[i..] and b[j..]
	const lengths: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		const row = lengths[i] as Uint32Array;
		const next = lengths[i + 1] as Uint32Array;
		for (let j = m - 1; j >= 0; j--) {
			row[j] = a[i] === b[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number);
		}
	}

	const pairs: Array<[number, number]> = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			pairs.push([i, j]);
			i++;
			j++;
			continue;
		}
		const down = (lengths[i + 1] as Uint32Array)[j] as number;
		const right = (lengths[i] as Uint32Array)[j + 1] as number;
		if (down >= right) i++;
		else j++;
	}
	return pairs;
}

export function lcsLength(a: string[], b: string[]): number {
	return lcsAlignment(a, b).length;
}

/** The recording most similar to all the others, by summed LCS length. */
export function medoid(sequences: string[][]): number {
	if (sequences.length <= 1) return 0;
	let best = 0;
	let bestScore = -1;
	for (let i = 0; i < sequences.length; i++) {
		let score = 0;
		for (let j = 0; j < sequences.length; j++) {
			if (i === j) continue;
			score += lcsLength(sequences[i] as string[], sequences[j] as string[]);
		}
		if (score > bestScore) {
			bestScore = score;
			best = i;
		}
	}
	return best;
}

export interface IntersectOptions {
	name?: string;
	scope?: "global" | "project";
	/** Fraction of recordings a step must appear in to join the skeleton. 0.6 default. */
	minSupport?: number;
	/** Keep reconnaissance steps in the skeleton. Off by default. */
	includeNoise?: boolean;
	/** Splice failed recordings too. Off by default: a failure is not knowledge. */
	includeFailed?: boolean;
}

export interface IntersectResult {
	recipe: Recipe;
	/** Support fraction per reference position, in reference order. */
	support: number[];
	/** referencePosition -> recording indices that contained it. */
	contributors: number[][];
	/** Steps that did not make the skeleton, with the recordings that had them. */
	variants: Array<{ key: string; verb: string; inRecordings: number[] }>;
	sharedSteps: number;
	longestSteps: number;
	/** Number of reconnaissance steps left out of the skeleton. */
	noiseExcluded: number;
	/** Ids of failed recordings kept out of the skeleton, counted but not learned from. */
	excludedFailed: string[];
}

/** A recipe reduced to the steps that participate in alignment. */
interface Prepared {
	steps: Step[];
	keys: string[];
	/** Step ordinal in the original recipe, per prepared index. */
	origin: number[];
	noise: number;
}

function prepare(recipes: Recipe[], includeNoise: boolean): Prepared[] {
	return recipes.map((recipe) => {
		const steps: Step[] = [];
		const keys: string[] = [];
		const origin: number[] = [];
		let noise = 0;
		recipe.steps.forEach((step, index) => {
			if (step.noise && !includeNoise) {
				noise++;
				return;
			}
			steps.push(step);
			keys.push(step.key);
			origin.push(index);
		});
		return { steps, keys, origin, noise };
	});
}

export function intersectRecipes(allRecipes: Recipe[], options: IntersectOptions = {}): IntersectResult {
	if (allRecipes.length === 0) throw new Error("intersectRecipes needs at least one recipe");

	const minSupport = options.minSupport ?? 0.6;
	const includeNoise = options.includeNoise ?? false;

	// A failed recording is evidence about what does *not* work, not about what the
	// procedure is, so it is counted and reported but kept out of the skeleton.
	const failed = options.includeFailed
		? []
		: allRecipes.filter((recipe) => recipe.outcome?.status === "failed");
	const recipes = failed.length ? allRecipes.filter((recipe) => !failed.includes(recipe)) : allRecipes;
	if (recipes.length === 0) {
		throw new Error(
			"every recording failed: a failed run is evidence about what does not work, not about the procedure — pass --include-failed to splice it anyway",
		);
	}

	const prepared = prepare(recipes, includeNoise);
	const sequences = prepared.map((item) => item.keys);

	const reference = medoid(sequences);
	const referencePrepared = prepared[reference] as Prepared;
	const referenceKeys = referencePrepared.keys;

	// Align every recording onto the reference.
	const contributors: number[][] = referenceKeys.map(() => [reference]);
	const matchedSteps: Array<Map<number, Step>> = referenceKeys.map(() => new Map());

	prepared.forEach((item, recordingIndex) => {
		if (recordingIndex === reference) return;
		for (const [refIndex, otherIndex] of lcsAlignment(referenceKeys, item.keys)) {
			(contributors[refIndex] as number[]).push(recordingIndex);
			const other = item.steps[otherIndex];
			if (other) (matchedSteps[refIndex] as Map<number, Step>).set(recordingIndex, other);
		}
	});

	const k = recipes.length;
	const support = contributors.map((list) => list.length / k);
	const now = new Date().toISOString();

	// --- skeleton ------------------------------------------------------------
	const skeleton: Step[] = [];
	const skeletonRefIndex: number[] = [];
	referenceKeys.forEach((_key, index) => {
		if ((support[index] as number) >= minSupport) {
			const step = referencePrepared.steps[index] as Step;
			const copy = structuredClone(step);
			// The template is rebuilt below; start from the reference's spelling.
			skeleton.push(copy);
			skeletonRefIndex.push(index);
		}
	});

	// --- slots ---------------------------------------------------------------
	// Values observed at each (skeleton position, slot name), per recording.
	const slotObservations: Array<Map<string, Map<string, number[]>>> = skeleton.map(() => new Map());

	skeleton.forEach((_step, skeletonIndex) => {
		const refIndex = skeletonRefIndex[skeletonIndex] as number;
		const perSlot = slotObservations[skeletonIndex] as Map<string, Map<string, number[]>>;

		const observe = (candidate: Step, recordingIndex: number) => {
			for (const [name, value] of Object.entries(candidate.slotValues)) {
				const byValue = perSlot.get(name) ?? new Map<string, number[]>();
				const list = byValue.get(value) ?? [];
				list.push(recordingIndex);
				byValue.set(value, list);
				perSlot.set(name, byValue);
			}
		};

		observe(referencePrepared.steps[refIndex] as Step, reference);
		for (const [recordingIndex, candidate] of matchedSteps[refIndex] as Map<number, Step>) {
			observe(candidate, recordingIndex);
		}
	});

	const slots: Slot[] = [];
	/** globalSlotKey -> the values per recording, used for parameter grouping. */
	const slotValueMatrix = new Map<string, Map<number, string>>();

	skeleton.forEach((step, skeletonIndex) => {
		const perSlot = slotObservations[skeletonIndex] as Map<string, Map<string, number[]>>;
		const mapping: Record<string, string> = {};
		// Canonical names can collide inside one step (two package arguments), so
		// only disambiguate on an actual collision. A blanket counter produced
		// `name`, `name1`, `name2` for slots that had nothing to do with each other.
		const usedNames = new Set<string>();

		for (const [name, byValue] of perSlot) {
			const values = [...byValue.keys()];
			// What kind of gap this slot was, decided when the recording was extracted.
			// A credential or a machine-specific path is not a constant merely because
			// every recording agreed on it: inlining it would bake a secret into the
			// recipe and make the procedure non-portable. Only ordinary knowledge folds in.
			const kind: GapKind =
				step.slotKinds?.[name] ?? classifyGapKind({ name, value: (values[0] as string) ?? "" });

			// A slot with one observed value is a constant: inline it so the recipe
			// stays as concrete as it can be. Unless the value is one that must stay
			// open — agreement about a credential or a machine path is not knowledge.
			if (values.length === 1 && !mustStayOpen(kind, values[0] as string)) {
				step.template = step.template.replaceAll(`{{${name}}}`, values[0] as string);
				step.usesSlots = step.usesSlots.filter((slot) => slot !== name);
				delete step.slotValues[name];
				if (step.slotKinds) delete step.slotKinds[name];
				continue;
			}

			// Varying: keep the name the extractor already chose when it is a real name,
			// and only re-derive when it is a placeholder like `arg`. Re-deriving a good
			// name from the value loses information the command shape already had.
			const canonical =
				!GENERIC_SLOT_NAMES.has(name) && name
					? name
					: proposeSlotName(step.verb, values[0] as string, step.example) || name;
			let slotName = canonical;
			let suffix = 2;
			while (usedNames.has(slotName)) slotName = `${canonical}${suffix++}`;
			usedNames.add(slotName);
			mapping[name] = slotName;

			const fillers = [...byValue.entries()]
				.sort((a, b) => b[1].length - a[1].length)
				.map(([value, recordingIndices]) => ({
					value,
					observedIn: recordingIndices.length,
					learnedAt: now,
					sources: recordingIndices.map((index) => (recipes[index] as Recipe).id),
				}));

			slots.push({
				name: slotName,
				stepIndex: skeletonIndex,
				stepKey: step.key,
				description: `Varies across tapes at step "${step.verb}"`,
				variance: 1 - (fillers[0]?.observedIn ?? 0) / k,
				kind,
				fillers,
			});

			const matrix = new Map<number, string>();
			for (const [value, recordingIndices] of byValue) {
				for (const recordingIndex of recordingIndices) matrix.set(recordingIndex, value);
			}
			slotValueMatrix.set(`${skeletonIndex}#${slotName}`, matrix);
		}

		if (Object.keys(mapping).length) {
			step.template = renameTemplate(step.template, mapping);
			step.slotValues = Object.fromEntries(
				Object.entries(step.slotValues).map(([name, value]) => [mapping[name] ?? name, value]),
			);
			step.slotKinds = Object.fromEntries(
				Object.entries(step.slotKinds ?? {}).map(([name, kind]) => [mapping[name] ?? name, kind]),
			);
			step.usesSlots = step.usesSlots.map((name) => mapping[name] ?? name);
		}
	});

	// --- parameters ----------------------------------------------------------
	const parameters = groupCoVaryingSlots(slots, slotValueMatrix, recipes, skeleton);

	// --- variants ------------------------------------------------------------
	const variantMap = new Map<string, { key: string; verb: string; inRecordings: number[] }>();
	prepared.forEach((item, recordingIndex) => {
		const matched = new Set(
			lcsAlignment(referenceKeys, item.keys).map(([, otherIndex]) => otherIndex),
		);
		item.steps.forEach((step, stepIndex) => {
			if (matched.has(stepIndex)) return;
			const entry = variantMap.get(step.key) ?? { key: step.key, verb: step.verb, inRecordings: [] };
			if (!entry.inRecordings.includes(recordingIndex)) entry.inRecordings.push(recordingIndex);
			variantMap.set(step.key, entry);
		});
	});

	// `longestSteps` counts the meaningful steps, so orthogonality compares like
	// with like instead of being deflated by reconnaissance.
	const longestSteps = Math.max(...sequences.map((sequence) => sequence.length), 0);
	const merged = emptyRecipe(options.name ?? commonName(recipes), options.scope ?? "global");
	merged.description = `Spliced from ${k} tapes`;
	merged.learnedFrom = [...new Set(recipes.flatMap((recipe) => recipe.learnedFrom))];
	merged.observations = k;
	merged.steps = skeleton;
	merged.slots = slots;
	merged.parameters = parameters;
	merged.orthogonality = longestSteps ? skeleton.length / longestSteps : 0;
	merged.compatibility.constraints = mergeConstraints(recipes);
	merged.validators = dedupeValidators(recipes);
	merged.contracts = contractsOfSteps(skeleton.map((step) => step.template));

	const combined = combineOutcomes(
		allRecipes.map((recipe) => recipe.outcome),
		failed.length
			? [
					`${failed.length} failed recording(s) excluded from the skeleton: ` +
						// The recipe name is whatever the caller called the splice; the
						// description is what the recording was called. Naming the tape is
						// the only one of the two that identifies it.
						failed.map((recipe) => recipe.description.replace(/^Learned from "|"$/g, "") || recipe.name).join(", "),
				]
			: [],
	);
	merged.outcome = {
		status: combined.status,
		successes: combined.successes,
		failures: combined.failures,
		evidence: combined.evidence,
	};

	return {
		recipe: merged,
		support,
		contributors,
		variants: [...variantMap.values()].sort((a, b) => b.inRecordings.length - a.inRecordings.length),
		sharedSteps: skeleton.length,
		longestSteps,
		noiseExcluded: prepared.reduce((sum, item) => sum + item.noise, 0),
		excludedFailed: failed.map((recipe) => recipe.id),
	};
}

const GENERIC_SLOT_NAMES = new Set(["arg", "arg1", "arg2", "arg3", "arg4", "path", "path2", "path3", "file", "target"]);

/**
 * Group slots that vary together.
 *
 * Two slots belong to the same parameter when the values they take correspond
 * one-to-one across recordings: whenever slot A holds `vue`, slot B holds
 * `vue-router`; whenever A holds `react`, B holds `react-router`. That is a
 * bijection, and it is a much stronger signal than "both slots changed".
 */
export function groupCoVaryingSlots(
	slots: Slot[],
	matrix: Map<string, Map<number, string>>,
	recipes: Recipe[],
	skeleton: Step[],
): Parameter[] {
	const parent = new Map<string, string>();
	const find = (key: string): string => {
		let root = key;
		while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root) as string;
		return root;
	};
	const union = (a: string, b: string) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent.set(ra, rb);
	};

	const keys = [...matrix.keys()];
	for (const key of keys) parent.set(key, key);

	for (let i = 0; i < keys.length; i++) {
		for (let j = i + 1; j < keys.length; j++) {
			const a = keys[i] as string;
			const b = keys[j] as string;
			if (coVary(matrix.get(a) as Map<number, string>, matrix.get(b) as Map<number, string>)) {
				union(a, b);
			}
		}
	}

	const groups = new Map<string, string[]>();
	for (const key of keys) {
		const root = find(key);
		const group = groups.get(root) ?? [];
		group.push(key);
		groups.set(root, group);
	}

	const parameters: Parameter[] = [];
	const usedParameterNames = new Set<string>();

	// A varying slot is a parameter even when it varies alone: you still have to be
	// able to set the project name even though nothing co-varies with it.
	for (const group of groups.values()) {
		const members = group.map((key) => {
			const [stepIndex, slot] = key.split("#");
			return { stepIndex: Number(stepIndex), slot: slot as string };
		});

		// Name the parameter deterministically: the earliest member step defines it,
		// preferring a name that says something over `arg`/`path`.
		const ordered = [...members].sort((a, b) => a.stepIndex - b.stepIndex);
		const names = ordered.map((member) => member.slot);
		const specific = names.find((candidate) => !GENERIC_SLOT_NAMES.has(candidate));
		let name = specific ?? names[0] ?? "param";
		let suffix = 2;
		while (usedParameterNames.has(name)) name = `${specific ?? "param"}${suffix++}`;
		usedParameterNames.add(name);

		// One variant per recording, listing every member's value.
		const variants = new Map<string, Parameter["variants"][number]>();
		for (let recordingIndex = 0; recordingIndex < recipes.length; recordingIndex++) {
			const values: Record<string, string> = {};
			let complete = true;
			for (const key of group) {
				const value = matrix.get(key)?.get(recordingIndex);
				if (value === undefined) {
					complete = false;
					break;
				}
				const [stepIndex, slot] = key.split("#");
				values[`${stepIndex}#${slot}`] = value;
			}
			if (!complete) continue;

			const label = values[group[0] as string] as string;
			const existing = variants.get(JSON.stringify(values));
			if (existing) {
				existing.observedIn++;
				existing.sources.push(recipes[recordingIndex]?.id ?? "");
			} else {
				variants.set(JSON.stringify(values), {
					label,
					observedIn: 1,
					values,
					sources: [recipes[recordingIndex]?.id ?? ""],
				});
			}
		}

		if (variants.size < 2) continue;

		const verbs = [...new Set(members.map((member) => (skeleton[member.stepIndex] as Step)?.verb ?? "?"))];
		const firstMember = ordered[0] as { stepIndex: number; slot: string };
		// A parameter with several members is a `choice`: the values have to move
		// together or not at all. A single member keeps the kind of its slot, so a
		// caller can tell a secret from a path without reading the step.
		const kind: GapKind =
			members.length > 1
				? "choice"
				: ((skeleton[firstMember.stepIndex] as Step)?.slotKinds?.[firstMember.slot] ?? "free");
		parameters.push({
			name,
			kind,
			description:
				members.length > 1
					? `Co-varies across ${members.length} slots in: ${verbs.join(", ")}`
					: `Varies across tapes at: ${verbs.join(", ")}`,
			// Several slots moving together means the caller must choose a coherent set:
			// picking a React template without the React router would be wrong. A single
			// slot is free-form — a project name is whatever the caller says it is.
			enumerated: members.length > 1,
			members,
			variants: [...variants.values()].sort((a, b) => b.observedIn - a.observedIn),
		});
	}

	return parameters.sort((a, b) => b.members.length - a.members.length);
}

/** True when two slot value maps form a bijection over the recordings they share. */
function coVary(a: Map<number, string>, b: Map<number, string>): boolean {
	const forward = new Map<string, string>();
	const backward = new Map<string, string>();
	let shared = 0;

	for (const [recordingIndex, valueA] of a) {
		const valueB = b.get(recordingIndex);
		if (valueB === undefined) continue;
		shared++;
		const seenB = forward.get(valueA);
		if (seenB !== undefined && seenB !== valueB) return false;
		const seenA = backward.get(valueB);
		if (seenA !== undefined && seenA !== valueA) return false;
		forward.set(valueA, valueB);
		backward.set(valueB, valueA);
	}

	// A single shared recording cannot establish co-variation.
	return shared >= 2 && forward.size >= 2;
}

function commonName(recipes: Recipe[]): string {
	const names = recipes.map((recipe) => recipe.name);
	const first = names[0] ?? "recipe";
	let prefix = first;
	for (const name of names.slice(1)) {
		let i = 0;
		while (i < prefix.length && i < name.length && prefix[i] === name[i]) i++;
		prefix = prefix.slice(0, i);
	}
	const trimmed = prefix.replace(/[\s\-_.]+$/, "");
	return trimmed.length >= 3 ? trimmed : `family of ${recipes.length}`;
}

function mergeConstraints(recipes: Recipe[]): string[] {
	const out = new Set<string>();
	for (const recipe of recipes) for (const constraint of recipe.compatibility.constraints) out.add(constraint);
	return [...out];
}

function dedupeValidators(recipes: Recipe[]): Recipe["validators"] {
	const seen = new Set<string>();
	const out: Recipe["validators"] = [];
	for (const recipe of recipes) {
		for (const validator of recipe.validators) {
			if (seen.has(validator.command)) continue;
			seen.add(validator.command);
			out.push(validator);
		}
	}
	return out;
}

/**
 * How orthogonal a family of recipes is: the mean pairwise LCS relative to the
 * shorter run. This is the number that decides whether the whole idea pays off
 * for a given family, so it is reported separately and never inferred.
 */
export function familyOrthogonality(recipes: Recipe[], includeNoise = false): number {
	if (recipes.length < 2) return 0;
	const sequences = recipes.map((recipe) =>
		recipe.steps.filter((step) => includeNoise || !step.noise).map((step) => step.key),
	);

	let total = 0;
	let pairs = 0;
	for (let i = 0; i < sequences.length; i++) {
		for (let j = i + 1; j < sequences.length; j++) {
			const a = sequences[i] as string[];
			const b = sequences[j] as string[];
			const shorter = Math.min(a.length, b.length);
			if (shorter === 0) continue;
			total += lcsLength(a, b) / shorter;
			pairs++;
		}
	}
	return pairs ? total / pairs : 0;
}
