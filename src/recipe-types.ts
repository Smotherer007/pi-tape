/**
 * Recipe types.
 *
 * A recipe is the distilled, parameterized form of one or more recordings: the
 * parts that stayed the same are the skeleton, the parts that varied are slots
 * with fillers. It is the intermediate representation between raw recordings and
 * compiled scripts.
 *
 * Design rule: a step's identity is its `key` (the normalized shape), never its
 * literal text. Two recordings that ran `npm create vue@latest my-app` and
 * `npm create react@latest other-app` must produce the *same* step key so they
 * can be aligned. Everything literal lives in `template`.
 */

export const RECIPE_MAGIC = "pi-tape-recipe";
export const RECIPE_VERSION = 1;
export const RECIPE_EXTENSION = ".recipe.json";

export type RecipeScope = "global" | "project";

/** How a step originated, so a reader knows how much to trust it. */
export type StepKind = "command" | "read" | "write" | "edit" | "other";

export interface Step {
	/** Normalized shape. Two runs of the same action share a key. */
	key: string;
	/** The leading verb, e.g. "npm create". Used for grouping. */
	verb: string;
	kind: StepKind;
	/**
	 * Literal text with `{{slot}}` placeholders where a recording differed.
	 * Present when this step came from a single recording; the intersection pass
	 * rewrites it once slots are known.
	 */
	template: string;
	/** Literal form as first observed, for humans. */
	example: string;
	/** Slots referenced by `template`, in order. */
	usesSlots: string[];
	/**
	 * The concrete value behind each placeholder, e.g. `{ name: "my-app" }`.
	 * Needed by the intersection pass: without the values it can see that two
	 * recordings differ but not what they differed by.
	 */
	slotValues: Record<string, string>;
	/** Pure reconnaissance rather than part of the procedure. */
	noise: boolean;
}

/** One observed value of a slot. */
export interface Filler {
	value: string;
	observedIn: number;
	learnedAt: string;
	/** Tape ids this value was seen in. */
	sources: string[];
}

/**
 * A positional slot: one placeholder inside one step.
 *
 * Slots are scoped to a step, never aggregated across steps by name. `{{path}}`
 * in a `read` step and `{{path}}` in a `mkdir` step are different slots even
 * though they are spelled the same, and treating them as one is how a recipe
 * silently corrupts itself.
 */
export interface Slot {
	name: string;
	/** Ordinal of the owning step in `Recipe.steps`. */
	stepIndex: number;
	/** Key of the owning step, for readers. */
	stepKey: string;
	description: string;
	/** Fraction of recordings in the family that varied at this position. */
	variance: number;
	fillers: Filler[];
}

/**
 * A semantic parameter: several positional slots that vary *together*.
 *
 * This is the composition primitive. If "vue" appears at step 3 and
 * "vue-router" at step 8 in one recording, and "react"/"react-router" at the
 * same positions in another, then both slots are the same parameter, and swapping
 * the parameter transfers a whole variant. That is what makes Vue -> React a
 * value swap instead of a rewrite.
 */
export interface Parameter {
	name: string;
	description: string;
	/** Positional slots belonging to this parameter, as `step index # slot`. */
	members: Array<{ stepIndex: number; slot: string }>;
	/**
	 * True when the caller must pick one of the observed variants, because several
	 * slots have to move together consistently (a framework and its router).
	 *
	 * False for a free parameter: a project name, path or branch is set to whatever
	 * the caller wants, and the observed values are only examples.
	 */
	enumerated: boolean;
	/** One entry per observed variant, with the value each member takes. */
	variants: Array<{
		/** Value of the first member, used as the variant's label. */
		label: string;
		observedIn: number;
		values: Record<string, string>;
		sources: string[];
	}>;
}

export interface Validator {
	/** A shell command that should succeed while the recipe is still valid. */
	command: string;
	/** What a failure means. */
	describes: string;
}

export interface Compatibility {
	/** Free-form constraints, e.g. "vue >= 3.4", "node >= 20". */
	constraints: string[];
}

export interface Recipe {
	magic: typeof RECIPE_MAGIC;
	version: typeof RECIPE_VERSION;
	id: string;
	name: string;
	description: string;
	scope: RecipeScope;
	createdAt: string;
	updatedAt: string;
	/** Tape ids this recipe was learned from. */
	learnedFrom: string[];
	/** 1 for a single recording, >1 once intersect() was applied. */
	observations: number;
	/** Shared fraction: core steps / longest observed step count. */
	orthogonality: number;
	steps: Step[];
	slots: Slot[];
	/** Cross-step parameters, derived from slots that co-vary. */
	parameters: Parameter[];
	compatibility: Compatibility;
	validators: Validator[];
	/** Cluster id assigned by the graph, if it has been indexed. */
	cluster?: number;
}

export interface RecipeIndexEntry {
	id: string;
	name: string;
	description: string;
	scope: RecipeScope;
	path: string;
	observations: number;
	orthogonality: number;
	steps: number;
	slots: number;
	learnedFrom: string[];
	cluster?: number;
}

export interface RecipeIndex {
	magic: "pi-tape-index";
	version: 1;
	builtAt: string;
	/** Content hash per recipe file, so the index can be refreshed incrementally. */
	digests: Record<string, string>;
	recipes: RecipeIndexEntry[];
	/** Normalized step key -> recipes containing it. */
	stepUsage: Record<string, string[]>;
	/** Cluster id -> recipe ids. */
	clusters: Record<string, string[]>;
	/** Steps ranked by graph centrality ("god steps"). */
	godSteps: Array<{ key: string; verb: string; recipes: number; centrality: number }>;
	stats: {
		recipes: number;
		steps: number;
		distinctSteps: number;
		clusters: number;
		meanOrthogonality: number;
	};
}

export function emptyRecipe(name: string, scope: RecipeScope): Recipe {
	const now = new Date().toISOString();
	return {
		magic: RECIPE_MAGIC,
		version: RECIPE_VERSION,
		id: "",
		name,
		description: "",
		scope,
		createdAt: now,
		updatedAt: now,
		learnedFrom: [],
		observations: 0,
		orthogonality: 0,
		steps: [],
		slots: [],
		parameters: [],
		compatibility: { constraints: [] },
		validators: [],
	};
}
