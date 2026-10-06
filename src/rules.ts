/**
 * Rule packs: what an ecosystem knows about its own commands.
 *
 * The contract engine in `contract.ts` knows one thing — a step either writes a
 * file, reads one, or runs a command — and nothing about *which* commands exist in
 * the world. Everything else lives here, one pack per ecosystem.
 *
 * The distinction matters and is not cosmetic:
 *
 *   a rule pack is **knowledge about a tool**, not a dependency on it.
 *
 * Nothing here is installed, started, imported or required. Dropping a pack removes
 * a claim about how to read a command line; it changes nothing about whether pi-tape
 * runs, and a repository with no Docker in it never has to care that a Docker pack
 * exists. A pack is also replaceable: a shop that uses Podman or `uv` adds a pack
 * instead of editing the engine, and a pack that is wrong is one object to remove.
 *
 * The engine never calls a command. It reads one.
 */

import type { Condition, Contracts } from "./recipe-types.ts";

/** One `&&`-separated piece of a command line. */
export interface Segment {
	/** The first token, e.g. `docker`. */
	verb: string;
	/** The remaining tokens, in order. */
	argv: string[];
	/** The segment as written, used as the condition's note. */
	text: string;
}

export interface RulePack {
	/** Stable id, so a report can say where a condition came from. */
	name: string;
	/** One line on what this pack claims to understand. */
	description: string;
	/** First tokens this pack speaks for. Anything else falls through. */
	commands: readonly string[];
	/**
	 * Derive the conditions this segment implies, or `undefined` to let the next
	 * pack try. Returning an empty contract is a claim: "I know this command and it
	 * needs and provides nothing".
	 */
	derive: (segment: Segment, helpers: RuleHelpers) => Contracts | undefined;
}

export interface RuleHelpers {
	positionals: (argv: readonly string[], valueFlags?: ReadonlySet<string>) => string[];
	valueOfFlag: (argv: readonly string[], ...flags: string[]) => string | undefined;
}

/** Conditions implied by one segment. */
export function conditions(requires: Condition[], provides: Condition[]): Contracts {
	return { requires, provides };
}

export function condition(kind: Condition["kind"], target: string, note: string): Condition {
	return { kind, target, note };
}

/**
 * Normalize a path so `./src/` and `src` meet.
 *
 * Deliberately lexical: `..` is not resolved, because a recipe is applied in a
 * directory nobody has visited yet.
 */
export function normalizeTarget(target: string): string {
	return target
		.replace(/^\.\//, "")
		.replace(/\/+$/, "")
		.replace(/\/{2,}/g, "/");
}

/**
 * A redirection and its target say nothing about what a command produces for the
 * rest of a chain, and treating `/dev/null` as an output would invent artifacts.
 */
const REDIRECTION = /^\d?&?>>?&?\d*$|^\d?&?>>?\/dev\/(null|stderr|stdout)$|^\d?>&\d$|^&?>>?&$/;

export function withoutRedirections(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (REDIRECTION.test(argv[i] as string)) {
			i++;
			continue;
		}
		out.push(argv[i] as string);
	}
	return out;
}

/**
 * Positional arguments of a command, skipping flags and their values.
 *
 * `valueFlags` is per pack and not global, and the difference is not cosmetic:
 * `-p` means `--parents` to `mkdir` (no value) and `--publish` to `docker run`
 * (a value). One global set made `mkdir -p out` provide nothing, because `-p`
 * swallowed the directory it was supposed to create.
 */
export function positionals(argv: readonly string[], valueFlags: ReadonlySet<string> = new Set()): string[] {
	const args = withoutRedirections(argv);
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const token = args[i] as string;
		if (token.startsWith("-")) {
			if (valueFlags.has(token) && !token.includes("=")) i++;
			continue;
		}
		out.push(token);
	}
	return out;
}

export function valueOfFlag(argv: readonly string[], ...flags: string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] as string;
		for (const flag of flags) {
			if (token === flag) return argv[i + 1];
			if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
		}
	}
	return undefined;
}

/**
 * Commands that are always present, or that say nothing about the host.
 *
 * A pack that lists a command here is claiming: worth running, not worth asking
 * about.
 */
export const UBIQUITOUS: ReadonlySet<string> = new Set([
	"cd",
	"echo",
	"printf",
	"ls",
	"pwd",
	"cat",
	"rm",
	"cp",
	"mv",
	"mkdir",
	"rmdir",
	"touch",
	"sed",
	"awk",
	"grep",
	"rg",
	"find",
	"sort",
	"uniq",
	"head",
	"tail",
	"wc",
	"chmod",
	"chown",
	"ln",
	"test",
	"true",
	"false",
	"sleep",
	"export",
	"source",
	"which",
	"env",
	"xargs",
	"tar",
	"zip",
	"unzip",
	"curl",
	"wget",
]);

const HELPERS: RuleHelpers = { positionals, valueOfFlag };

// ---------------------------------------------------------------------------
// filesystem and version control
// ---------------------------------------------------------------------------

/** Directories, repositories and manifests: true of any machine, no ecosystem. */
const filesystem: RulePack = {
	name: "filesystem",
	description: "creating directories, cloning repositories, package manifests",
	commands: ["mkdir", "git"],
	derive(segment) {
		const { verb, argv, text } = segment;

		if (verb === "mkdir") {
			return conditions(
				[],
				positionals(argv).map((dir) => condition("dir", normalizeTarget(dir), text)),
			);
		}

		if (verb === "git" && argv[0] === "clone") {
			const target = positionals(argv.slice(1))[1];
			return conditions(
				[condition("command", "git", text)],
				target ? [condition("dir", normalizeTarget(target), text)] : [],
			);
		}

		return undefined;
	},
};

// ---------------------------------------------------------------------------
// javascript and node
// ---------------------------------------------------------------------------

const NODE_VALUE_FLAGS: ReadonlySet<string> = new Set(["--prefix", "--registry", "-C", "--cwd", "--tag"]);

const node: RulePack = {
	name: "node",
	description: "npm, pnpm, yarn and bun: scaffolding, installing, running scripts",
	commands: ["npm", "pnpm", "yarn", "bun", "npx", "bunx"],
	derive(segment) {
		const { verb, argv, text } = segment;
		const manager = condition("command", verb, text);

		if (argv[0] === "create") {
			const args = positionals(argv.slice(1), NODE_VALUE_FLAGS);
			const name = args[1] ?? args[0];
			return conditions([manager], name ? [condition("dir", normalizeTarget(name), text)] : []);
		}

		if (argv[0] === "init") {
			return conditions([manager], [condition("file", "package.json", text)]);
		}

		if (argv[0] === "install" || argv[0] === "i" || argv[0] === "add" || argv[0] === "ci") {
			const packages = positionals(argv.slice(1), NODE_VALUE_FLAGS);
			// A bare install reads the manifest, so the manifest has to be there.
			const provides = packages.map((name) => condition("dependency", name.split("@")[0] as string, text));
			return conditions([manager, ...(packages.length ? [] : [condition("file", "package.json", text)])], provides);
		}

		return undefined;
	},
};

// ---------------------------------------------------------------------------
// python
// ---------------------------------------------------------------------------

const python: RulePack = {
	name: "python",
	description: "virtual environments and pip installs",
	commands: ["python", "python3", "pip", "pip3"],
	derive(segment) {
		const { verb, argv, text } = segment;

		if (/^(python|python3)$/.test(verb) && argv[0] === "-m" && argv[1] === "venv") {
			const dir = positionals(argv.slice(2))[0];
			return conditions(
				[condition("command", verb, text)],
				dir ? [condition("dir", normalizeTarget(dir), text)] : [],
			);
		}

		// `pip install x` and `python -m pip install x` are the same act.
		const args = /^pip/.test(verb) ? argv : argv[0] === "-m" && /^pip3?$/.test(argv[1] ?? "") ? argv.slice(2) : [];
		if (args[0] !== "install") return undefined;

		const rest = args.slice(1);
		const requirements = valueOfFlag(rest, "-r", "--requirement");
		const requires = [condition("command", /^pip/.test(verb) ? verb : "pip", text)];
		if (requirements) requires.push(condition("file", normalizeTarget(requirements), text));

		return conditions(
			requires,
			positionals(rest).map((name) => condition("dependency", name.split("==")[0] as string, text)),
		);
	},
};

// ---------------------------------------------------------------------------
// containers
// ---------------------------------------------------------------------------

const DOCKER_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"-p",
	"--publish",
	"-e",
	"--env",
	"-v",
	"--volume",
	"--name",
	"-w",
	"--workdir",
	"-u",
	"--user",
	"-m",
	"--memory",
	"-h",
	"--host",
	"--network",
	"--restart",
]);

/**
 * Docker, as one pack.
 *
 * The engine has no idea this file exists; remove the entry from `BUILTIN_PACKS`
 * and pi-tape simply stops reading `docker build` as "needs a Dockerfile, produces
 * an image". Nothing else changes, because nothing else knew.
 */
const docker: RulePack = {
	name: "docker",
	description: "building and running images, and compose files",
	commands: ["docker", "podman"],
	derive(segment) {
		const { verb, argv, text } = segment;
		const tool = condition("command", verb, text);

		if (argv[0] === "build") {
			const tag = valueOfFlag(argv, "-t", "--tag");
			return conditions(
				[condition("file", "Dockerfile", text), tool],
				tag ? [condition("image", tag, text)] : [],
			);
		}

		if (argv[0] === "run") {
			const image = positionals(argv.slice(1), DOCKER_VALUE_FLAGS)[0];
			return conditions(image ? [condition("image", image, text), tool] : [tool], []);
		}

		if (argv[0] === "compose") {
			return conditions([condition("file", "docker-compose.yml", text), tool], []);
		}

		return undefined;
	},
};

// ---------------------------------------------------------------------------
// orchestration and clouds
// ---------------------------------------------------------------------------

/** Manifests applied to a cluster, and the cloud CLIs: a tool, and nothing else. */
const orchestration: RulePack = {
	name: "orchestration",
	description: "kubectl manifests and the cloud CLIs",
	commands: ["kubectl", "helm", "terraform", "aws", "gcloud", "az"],
	derive(segment) {
		const { verb, argv, text } = segment;
		const tool = condition("command", verb, text);

		if (verb === "kubectl" && argv[0] === "apply") {
			const file = valueOfFlag(argv, "-f", "--filename");
			return conditions([...(file ? [condition("file", normalizeTarget(file), text)] : []), tool], []);
		}

		return conditions([tool], []);
	},
};

// ---------------------------------------------------------------------------
// the fallback
// ---------------------------------------------------------------------------

/**
 * What is known about a command nobody has a pack for: it is a command.
 *
 * That is not a gap in the design, it is the design. An unknown tool still gets
 * probed, so `run` can say "claude is not on this machine" before starting, and it
 * simply claims nothing about what the command produces — which is exactly as much
 * as can honestly be said without knowing the tool.
 */
const generic: RulePack = {
	name: "generic",
	description: "an unknown command is a command, and claims nothing else",
	commands: [],
	derive(segment) {
		const { verb, text } = segment;
		if (!verb || UBIQUITOUS.has(verb)) return undefined;
		return conditions([condition("command", verb.replace(/^.*\//, ""), text)], []);
	},
};

/**
 * Everything pi-tape knows about ecosystems, in one place.
 *
 * Order matters: the first pack that claims a command wins, and `generic` is last
 * because it claims every command.
 */
export const BUILTIN_PACKS: readonly RulePack[] = [
	filesystem,
	node,
	python,
	docker,
	orchestration,
	generic,
];

export interface DeriveOptions {
	/** Replace the built-in knowledge, for a repository that wants its own. */
	packs?: readonly RulePack[];
}

/**
 * The packs that may speak for a verb, in order.
 *
 * A pack with an empty `commands` list is the catch-all and is consulted last, on
 * purpose: it claims everything, so anything specific has to get its turn first.
 * Dispatch and reporting share this, because a report that used a different rule
 * than the dispatch would describe a program that does not exist.
 */
function* candidates(verb: string, packs: readonly RulePack[]): Generator<RulePack> {
	for (const pack of packs) {
		if (pack.commands.length && !pack.commands.includes(verb)) continue;
		yield pack;
	}
}

/** Conditions a single segment implies, or an empty contract if nothing is known. */
export function deriveConditions(segment: Segment, options: DeriveOptions = {}): Contracts {
	for (const pack of candidates(segment.verb, options.packs ?? BUILTIN_PACKS)) {
		const contracts = pack.derive(segment, HELPERS);
		if (contracts) return contracts;
	}
	return conditions([], []);
}

/**
 * The pack that owns a command, for a report.
 *
 * Owning is not the same as claiming: the Docker pack owns `docker`, and may still
 * decline `docker ps` and let the catch-all answer. This answers "whose business is
 * this command", which is the question a report asks.
 */
export function packFor(command: string, options: DeriveOptions = {}): RulePack | undefined {
	const packs = options.packs ?? BUILTIN_PACKS;
	return packs.find((pack) => pack.commands.includes(command)) ?? packs.find((pack) => pack.commands.length === 0);
}

/** The packs in play, so a caller can print what it is relying on. */
export function describePacks(options: DeriveOptions = {}): Array<{ name: string; description: string }> {
	return (options.packs ?? BUILTIN_PACKS).map((pack) => ({ name: pack.name, description: pack.description }));
}
