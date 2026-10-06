/**
 * The recipe store.
 *
 * Two layers, project shadowing global:
 *
 *   ~/.pi/agent/tape/     global      recipes learned once, useful anywhere
 *   <project>/.tape/      project     recipes that only make sense here
 *
 * Recipes are plain JSON, so they live in git and travel with a repository fork —
 * which is the point: forking a repo can bring its procedures with it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { agentDir } from "./discover.ts";
import { stableStringify } from "./hash.ts";
import {
	emptyContracts,
	emptyOutcome,
	RECIPE_EXTENSION,
	RECIPE_MAGIC,
	RECIPE_VERSION,
	type Recipe,
	type RecipeIndex,
	type RecipeScope,
} from "./recipe-types.ts";

export function globalStoreDir(): string {
	return process.env.PI_TAPE_DIR ?? join(agentDir(), "tape");
}

export function projectStoreDir(cwd: string): string {
	return join(cwd, ".tape");
}

export function recipesDir(storeDir: string): string {
	return join(storeDir, "recipes");
}

export function indexFile(storeDir: string): string {
	return join(storeDir, "index.json");
}

export interface StoreLocation {
	scope: RecipeScope;
	dir: string;
	exists: boolean;
}

export function storeLocations(cwd: string): StoreLocation[] {
	const locations: StoreLocation[] = [
		{ scope: "global", dir: globalStoreDir(), exists: false },
		{ scope: "project", dir: projectStoreDir(cwd), exists: false },
	];
	for (const location of locations) location.exists = existsSync(location.dir);
	return locations;
}

/** Content address over the meaningful fields, so re-saving unchanged content is stable. */
export function recipeId(recipe: Recipe): string {
	const payload = stableStringify({
		name: recipe.name,
		scope: recipe.scope,
		steps: recipe.steps.map((step) => ({ key: step.key, template: step.template, slotKinds: step.slotKinds ?? {} })),
		slots: recipe.slots.map((slot) => ({
			name: slot.name,
			stepIndex: slot.stepIndex,
			kind: slot.kind,
			fillers: slot.fillers.map((f) => f.value),
		})),
		parameters: recipe.parameters.map((parameter) => ({
			name: parameter.name,
			kind: parameter.kind,
			variants: parameter.variants.map((v) => v.label),
		})),
	});
	return `recipe:${createHash("sha256").update(payload).digest("hex").slice(0, 32)}`;
}

export function slugifyRecipeName(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 64) || "recipe"
	);
}

export function saveRecipe(storeDir: string, recipe: Recipe): { path: string; recipe: Recipe } {
	recipe.id = recipe.id || recipeId(recipe);
	recipe.updatedAt = new Date().toISOString();

	const dir = recipesDir(storeDir);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${slugifyRecipeName(recipe.name)}${RECIPE_EXTENSION}`);
	writeFileSync(path, `${JSON.stringify(recipe, null, "\t")}\n`, "utf8");
	return { path, recipe };
}

export class RecipeFormatError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RecipeFormatError";
	}
}

export function validateRecipe(value: unknown, path: string): Recipe {
	if (typeof value !== "object" || value === null) {
		throw new RecipeFormatError(`${path}: not an object`);
	}
	const recipe = value as Partial<Recipe>;
	if (recipe.magic !== RECIPE_MAGIC) {
		throw new RecipeFormatError(`${path}: expected magic "${RECIPE_MAGIC}", got ${JSON.stringify(recipe.magic)}`);
	}
	if (recipe.version !== RECIPE_VERSION) {
		throw new RecipeFormatError(`${path}: unsupported recipe version ${String(recipe.version)}`);
	}
	if (typeof recipe.name !== "string" || !recipe.name) {
		throw new RecipeFormatError(`${path}: missing a name`);
	}
	if (!Array.isArray(recipe.steps)) {
		throw new RecipeFormatError(`${path}: \`steps\` must be an array`);
	}
	// Tolerate recipes written by an older build that had no parameters.
	if (!Array.isArray(recipe.parameters)) recipe.parameters = [];
	if (!Array.isArray(recipe.slots)) recipe.slots = [];
	if (!Array.isArray(recipe.validators)) recipe.validators = [];
	if (!recipe.compatibility || typeof recipe.compatibility !== "object") {
		recipe.compatibility = { constraints: [] };
	}

	// Backfill `enumerated` for recipes written before it existed: a multi-member
	// parameter must be enumerated, or composing would silently allow an
	// incoherent combination such as a React template with a Vue router.
	for (const parameter of recipe.parameters) {
		if (typeof parameter.enumerated !== "boolean") {
			parameter.enumerated = Array.isArray(parameter.members) && parameter.members.length > 1;
		}
		// Recipes written before gap kinds existed: a multi-member parameter was a
		// choice, anything else was free. Assuming more than that would invent
		// information the file never carried.
		if (typeof parameter.kind !== "string") {
			parameter.kind = parameter.enumerated ? "choice" : "free";
		}
	}

	for (const slot of recipe.slots) {
		if (typeof slot.kind !== "string") slot.kind = "free";
	}
	for (const step of recipe.steps) {
		if (step.slotKinds === undefined || typeof step.slotKinds !== "object") step.slotKinds = {};
	}

	if (!recipe.contracts || typeof recipe.contracts !== "object") recipe.contracts = emptyContracts();
	if (!Array.isArray(recipe.contracts.requires)) recipe.contracts.requires = [];
	if (!Array.isArray(recipe.contracts.provides)) recipe.contracts.provides = [];
	if (!recipe.outcome || typeof recipe.outcome !== "object") recipe.outcome = emptyOutcome();
	if (!Array.isArray(recipe.outcome.evidence)) recipe.outcome.evidence = [];

	return recipe as Recipe;
}

export interface LoadedRecipe {
	recipe: Recipe;
	path: string;
	scope: RecipeScope;
	/** True when a project recipe shadows a global one of the same name. */
	shadowed?: string;
}

export interface LoadResult {
	recipes: LoadedRecipe[];
	errors: Array<{ path: string; message: string }>;
}

function readRecipesFrom(storeDir: string, scope: RecipeScope): LoadResult {
	const dir = recipesDir(storeDir);
	const result: LoadResult = { recipes: [], errors: [] };
	if (!existsSync(dir)) return result;

	let files: string[];
	try {
		files = readdirSync(dir);
	} catch (error) {
		result.errors.push({ path: dir, message: (error as Error).message });
		return result;
	}

	for (const file of files) {
		if (!file.endsWith(RECIPE_EXTENSION) && !file.endsWith(".json")) continue;
		const path = join(dir, file);
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8"));
			const recipe = validateRecipe(parsed, path);
			recipe.scope = scope;
			result.recipes.push({ recipe, path, scope });
		} catch (error) {
			result.errors.push({ path, message: (error as Error).message });
		}
	}
	return result;
}

/**
 * Load every recipe, with project recipes shadowing global ones of the same name.
 * Shadowing is by name, so a project can override a global procedure with a local
 * variant without renaming it.
 */
export function loadRecipes(cwd: string): LoadResult {
	const globalResult = readRecipesFrom(globalStoreDir(), "global");
	const projectResult = readRecipesFrom(projectStoreDir(cwd), "project");

	const byName = new Map<string, LoadedRecipe>();
	for (const loaded of globalResult.recipes) byName.set(loaded.recipe.name, loaded);
	for (const loaded of projectResult.recipes) {
		const existing = byName.get(loaded.recipe.name);
		if (existing) loaded.shadowed = existing.path;
		byName.set(loaded.recipe.name, loaded);
	}

	return {
		recipes: [...byName.values()].sort((a, b) => a.recipe.name.localeCompare(b.recipe.name)),
		errors: [...globalResult.errors, ...projectResult.errors],
	};
}

/** Total recipe files on disk, including shadowed ones, for status output. */
export function countRecipeFiles(cwd: string): number {
	let total = 0;
	for (const location of storeLocations(cwd)) {
		const dir = recipesDir(location.dir);
		if (!existsSync(dir)) continue;
		try {
			total += readdirSync(dir).filter((file) => file.endsWith(RECIPE_EXTENSION)).length;
		} catch {
			// unreadable dir counts as empty
		}
	}
	return total;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export function writeIndex(storeDir: string, index: RecipeIndex): string {
	mkdirSync(storeDir, { recursive: true });
	const path = indexFile(storeDir);
	writeFileSync(path, `${JSON.stringify(index, null, "\t")}\n`, "utf8");
	return path;
}

export function readIndex(storeDir: string): RecipeIndex | undefined {
	const path = indexFile(storeDir);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as RecipeIndex;
		if (parsed.magic !== "pi-tape-index") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * Content digest per recipe file.
 *
 * Staleness is decided by content, not by mtime: two writes inside the same
 * millisecond are indistinguishable by timestamp, and "the index did not notice
 * your change" is a bug with no symptom until it is expensive.
 */
export function recipeFileDigests(cwd: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const location of storeLocations(cwd)) {
		const dir = recipesDir(location.dir);
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(RECIPE_EXTENSION)) continue;
				const path = join(dir, file);
				out[path] = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
			}
		} catch {
			// An unreadable store counts as changed, so the caller rebuilds.
			out[`${dir}/*`] = "unreadable";
		}
	}
	return out;
}

/**
 * True when the persisted index does not match the recipe files on disk.
 *
 * mtime is deliberately not consulted: a rebuild that produced identical content
 * is not a change, and a same-millisecond write is a change even though no
 * timestamp can show it.
 */
export function indexIsStale(cwd: string): boolean {
	const index = readIndex(globalStoreDir());
	if (!index) return true;

	const current = recipeFileDigests(cwd);
	const recorded = index.digests ?? {};
	const paths = new Set([...Object.keys(current), ...Object.keys(recorded)]);
	for (const path of paths) {
		if (current[path] !== recorded[path]) return true;
	}
	return false;
}

export function ensureStoreDirs(cwd: string): void {
	for (const location of storeLocations(cwd)) {
		if (location.scope === "global") mkdirSync(recipesDir(location.dir), { recursive: true });
	}
}
