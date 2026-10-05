/**
 * Normalization: turning a concrete action into a stable identity.
 *
 * This is the load-bearing part of the whole recipe idea. For a recording of
 * `npm create vue@latest my-app` to align with a recording of
 * `npm create react@latest other-app`, both must reduce to the same key. That
 * reduction is heuristic — a command is a string, not an AST — so it is kept
 * deliberately simple, conservative and testable.
 *
 * What is stripped: versions, paths, quoted arguments, numbers, flags whose
 * values are environment-specific.
 * What is kept: the leading verbs, subcommands, tool names, file categories.
 */

import { basename, extname } from "node:path";

/** Words that carry the action rather than the argument. */
const VERB_DEPTH = 2;

/** Flags whose value is environment-specific and must not enter the key. */
const VOLATILE_FLAGS = new Set([
	"--prefix",
	"--registry",
	"--cache",
	"-C",
	"--cwd",
	"--output",
	"-o",
]);

/** Placeholder used where a recording-specific literal was removed. */
export const WILDCARD = "<*>";

export interface CommandShape {
	key: string;
	verb: string;
	/** Literal fragments that were replaced, in order of appearance. */
	literals: string[];
}

/** One shell token, with the literal it replaced when it was normalized away. */
export interface AnalyzedToken {
	raw: string;
	text: string;
	/** Set when this token was replaced; the original text. */
	literal?: string;
}

export interface AnalyzedSegment {
	tokens: AnalyzedToken[];
	/** Tokens with literals replaced by `<*>` */
	key: string;
}

export interface AnalyzedCommand {
	segments: AnalyzedSegment[];
	/** Operators between segments: `&&`, `||`, `;`, `|`. */
	operators: string[];
	key: string;
	verb: string;
}

/**
 * Normalize a shell command.
 *
 *   npm create vue@latest my-app        -> "npm create <*>@<*> <*>"
 *   npm create react@latest other-app   -> "npm create <*>@<*> <*>"
 *   git checkout -b feat/login          -> "git checkout -b <*>"
 */
export function normalizeCommand(command: string): CommandShape {
	const analyzed = analyzeCommand(command);
	const literals: string[] = [];
	for (const segment of analyzed.segments) {
		for (const token of segment.tokens) {
			if (token.literal !== undefined) literals.push(token.literal);
		}
	}
	return { key: analyzed.key, verb: analyzed.verb, literals };
}

/** Same normalization, but keeping token positions so a template can be rendered. */
export function analyzeCommand(command: string): AnalyzedCommand {
	const raw = splitOnOperators(command);
	const segments: AnalyzedSegment[] = [];
	const operators: string[] = [];

	for (const part of raw) {
		if (part === "&&" || part === "||" || part === ";" || part === "|") {
			operators.push(part);
			continue;
		}
		const tokens = tokenizeShell(part)
			.filter((token) => !isRedirection(token))
			.map((token) => {
				const result = normalizeToken(token);
				return result.replaced === undefined
					? { raw: token, text: result.text }
					: { raw: token, text: result.text, literal: result.replaced };
			});
		segments.push({ tokens, key: tokens.map((token) => token.text).join(" ") });
	}

	const key = segments
		.map((segment) => segment.key)
		.filter(Boolean)
		.join(" && ")
		.replace(/\s+/g, " ")
		.trim();

	const verb = verbOf(key);
	for (const segment of segments) applyPositionalRules(verb, segment.tokens);

	// Positional rules can turn a token into a wildcard after the first key was
	// built, so rebuild it.
	const finalKey = segments
		.map((segment) => segment.tokens.map((token) => token.text).join(" "))
		.filter(Boolean)
		.join(" && ")
		.replace(/\s+/g, " ")
		.trim();

	return { segments, operators, key: finalKey || key, verb };
}

/**
 * Render a command back from its analysis, replacing each normalized-away literal
 * with a placeholder. `nameFor(token, occurrence)` decides the placeholder name.
 */
export function renderTemplate(
	analyzed: AnalyzedCommand,
	nameFor: (token: AnalyzedToken, occurrence: number) => string,
): { template: string; slots: Array<{ name: string; value: string }> } {
	const slots: Array<{ name: string; value: string }> = [];
	let occurrence = 0;
	const pieces: string[] = [];

	analyzed.segments.forEach((segment, index) => {
		if (index > 0) pieces.push(analyzed.operators[index - 1] ?? "&&");
		pieces.push(
			segment.tokens
				.map((token) => {
					if (token.literal === undefined) return token.raw;
					const name = nameFor(token, occurrence++);
					slots.push({ name, value: token.literal });
					return `{{${name}}}`;
				})
				.join(" "),
		);
	});

	return { template: pieces.join(" "), slots };
}

/** Split a command on `&&`, `||`, `;` and pipes, keeping the operators. */
export function splitOnOperators(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: string | undefined;

	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		if (quote) {
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			current += char;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			parts.push(current.trim());
			parts.push(two);
			current = "";
			i++;
			continue;
		}
		if (char === ";" || char === "|") {
			parts.push(current.trim());
			parts.push(char);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current.trim());
	return parts.filter(Boolean);
}

/** Quote-aware whitespace split. */
export function tokenizeShell(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: string | undefined;

	for (const char of segment) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Shell redirections carry no meaning for a step and are dropped. */
function isRedirection(token: string): boolean {
	return (
		/^\d?&?>>?&?\d*$/.test(token) ||
		/^\d?&?>>?\/dev\/(null|stderr|stdout)$/.test(token) ||
		/^\d?>&\d$/.test(token) ||
		/^&?>>?&$/.test(token)
	);
}

/**
 * Pure reconnaissance. Kept in the recording, marked on the step, and left out of
 * the skeleton by default: `ls` before `npm create` is how the agent oriented
 * itself, not part of the procedure.
 */
const NOISE_VERBS = new Set([
	"ls",
	"pwd",
	"echo",
	"date",
	"which",
	"whoami",
	"env",
	"printenv",
	"uname",
	"stat",
	"wc",
	"file",
	"du",
	"df",
	"head",
	"tail",
	"tree",
]);

const NOISE_SUBCOMMANDS = /^(git (status|log|diff|branch|remote)|npm (ls|list|view|--version|-v)|node (--version|-v)|cat |rg |grep |find )/;

export function isNoiseCommand(normalized: string): boolean {
	const first = normalized.split("&&")[0]?.trim() ?? "";
	const verb = first.split(/\s+/)[0] ?? "";
	if (NOISE_VERBS.has(verb)) return true;
	return NOISE_SUBCOMMANDS.test(first);
}

interface TokenResult {
	text: string;
	replaced?: string;
}

/** Replace the recording-specific part of one token, or keep it verbatim. */
function normalizeToken(token: string): TokenResult {
	if (!token) return { text: "" };

	// A shell variable is environment-specific by definition. Normalizing it to the
	// same wildcard makes `ls $R/dist` and `ls $PKG/src` align.
	if (/^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(token) || /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(token)) {
		return { text: WILDCARD, replaced: token };
	}

	// Quoted content already lost its quotes in tokenizeShell.
	// Absolute paths and relative paths with separators are environment-specific.
	if (/^(\.{0,2}\/|\/|~\/)/.test(token) || token.includes("/")) {
		// Keep well-known relative targets readable: src/index.ts -> src/<*>.ts
		const ext = extname(token);
		const dir = token.includes("/") ? token.slice(0, token.lastIndexOf("/")) : "";
		if (dir && !dir.startsWith("/")) {
			return { text: `${dir}/${WILDCARD}${ext}`, replaced: token };
		}
		return { text: WILDCARD, replaced: token };
	}

	// name@version or name@tag
	const at = token.match(/^(@?[a-zA-Z0-9._-]+)@([a-zA-Z0-9.^~<>=*-]+)$/);
	if (at) {
		return { text: `${at[1]}@${WILDCARD}`, replaced: token };
	}

	// Bare semver
	if (/^v?\d+\.\d+(\.\d+)?([-.+][\w.]+)?$/.test(token)) {
		return { text: WILDCARD, replaced: token };
	}

	// Long numeric literals (ports, ids, timestamps)
	if (/^\d{4,}$/.test(token)) {
		return { text: WILDCARD, replaced: token };
	}

	// Project names and file names: a bare token with a known source extension
	const ext = extname(token);
	if (ext && /^\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|json|md|py|go|rs|java|kt|rb|sh|yml|yaml|toml)$/.test(ext)) {
		return { text: `${WILDCARD}${ext}`, replaced: token };
	}

	return { text: token };
}

/**
 * Command-position rules: which argument of which command is a recording-specific
 * value. Token content cannot answer this, position can.
 */
const PACKAGE_MANAGERS = /^(npm|pnpm|yarn|bun)$/;
const INSTALL_SUBCOMMANDS = /^(install|i|add|remove|rm|uninstall|up|update|link)$/;

interface PositionalRule {
	test: (verb: string) => boolean;
	/** Suggested name for the token at index `i`, or undefined to leave it alone. */
	suggest: (argv: string[], i: number) => string | undefined;
}

const POSITIONAL_RULES: PositionalRule[] = [
	{
		// npm install <pkg...>, npm i -D <pkg>
		test: (verb) => {
			const [head, sub] = verb.split(" ");
			return !!head && !!sub && PACKAGE_MANAGERS.test(head) && INSTALL_SUBCOMMANDS.test(sub);
		},
		suggest: (argv, i) => (i >= 2 && !argv[i]?.startsWith("-") ? "package" : undefined),
	},
	{
		// npm create <template> <name>
		test: (verb) => /^(npm|pnpm|yarn|bun) create$/.test(verb),
		suggest: (_argv, i) => (i === 2 ? "template" : i === 3 ? "name" : undefined),
	},
	{
		// npx <package> [name] / bunx <package>
		test: (verb) => /^(npx|bunx)$/.test(verb),
		suggest: (_argv, i) => (i === 1 ? "package" : i === 2 ? "name" : undefined),
	},
	{
		test: (verb) => /^git clone$/.test(verb),
		suggest: (_argv, i) => (i === 2 ? "repository" : undefined),
	},
	{
		test: (verb) => /^docker (run|pull|build|create)$/.test(verb),
		suggest: (_argv, i) => (i === 2 ? "image" : undefined),
	},
	{
		test: (verb) => /^(cargo|go) (add|get)$/.test(verb),
		suggest: (argv, i) => (i >= 2 && !argv[i]?.startsWith("-") ? "package" : undefined),
	},
	{
		test: (verb) => /^git (checkout|switch)$/.test(verb),
		suggest: (argv, i) => {
			const previous = argv[i - 1];
			return i >= 2 && (previous === "-b" || previous === "-B" || previous === "-c" || previous === "--branch")
				? "branch"
				: undefined;
		},
	},
	{
		test: (verb) => /^(systemctl|service) \w+$/.test(verb),
		suggest: (argv, i) => (i >= 2 && !argv[i]?.startsWith("-") ? "service" : undefined),
	},
	{
		test: (verb) => /^npm run$/.test(verb),
		suggest: (_argv, i) => (i === 2 ? "script" : undefined),
	},
	{
		test: (verb) => /^(mkdir|touch|rmdir)$/.test(verb),
		suggest: (_argv, i) => (i === 1 ? "target" : undefined),
	},
];

/** Attach position-derived slot names and literal marks to a segment's tokens. */
function applyPositionalRules(verb: string, tokens: AnalyzedToken[]): void {
	const argv = tokens.map((token) => token.raw);
	for (const rule of POSITIONAL_RULES) {
		if (!rule.test(verb)) continue;
		for (let i = 0; i < tokens.length; i++) {
			const suggested = rule.suggest(argv, i);
			if (suggested === undefined) continue;
			const token = tokens[i] as AnalyzedToken;
			token.suggested = suggested;
			// The token has to become a *whole* wildcard, even when the tokenizer had
			// already rewritten part of it. `vue@latest` normalizes to `vue@<*>` on its
			// own, which would still differ from `react@<*>`; as the template argument
			// of a create command it is one recording-specific value and must vanish.
			if (/^[A-Za-z@~.][\w@./~-]*$/.test(token.raw)) {
				token.literal = token.raw;
				token.text = WILDCARD;
			}
		}
		break;
	}
}

/** The leading verbs of a normalized command. */
export function verbOf(normalized: string): string {
	const first = normalized.split("&&")[0] ?? "";
	const tokens = first.trim().split(/\s+/).filter((token) => token && !token.startsWith("-"));
	return tokens.slice(0, VERB_DEPTH).join(" ");
}

/** File categories, used as the identity of read/write/edit steps. */
export type FileCategory =
	| "manifest"
	| "lockfile"
	| "tsconfig"
	| "build-config"
	| "source"
	| "test"
	| "docs"
	| "config"
	| "ci"
	| "container"
	| "asset"
	| "other";

export function categorizeFile(path: string): FileCategory {
	const base = basename(path).toLowerCase();
	const lower = path.toLowerCase();

	if (base === "package.json" || base === "pyproject.toml" || base === "cargo.toml" || base === "go.mod") {
		return "manifest";
	}
	if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|cargo\.lock|poetry\.lock)$/.test(base)) {
		return "lockfile";
	}
	if (/^tsconfig.*\.json$/.test(base) || /^jsconfig.*\.json$/.test(base)) return "tsconfig";
	if (/^(vite|webpack|rollup|esbuild|next|nuxt|astro|svelte|tailwind|postcss|babel|jest|vitest)\.config\./.test(base)) {
		return "build-config";
	}
	if (/(^|\/)(\.github\/workflows|\.gitlab-ci|\.circleci)(\/|$)/.test(lower) || /^(\.travis\.yml|azure-pipelines\.yml)$/.test(base)) {
		return "ci";
	}
	if (/^(dockerfile|docker-compose\.ya?ml|\.dockerignore)$/.test(base)) return "container";
	if (/\.(test|spec)\.[a-z]+$/.test(base) || /(^|\/)(tests?|__tests__)\//.test(lower)) return "test";
	if (/\.(md|mdx|txt|rst)$/.test(base) || /(^|\/)docs?\//.test(lower)) return "docs";
	if (/^\.(env|editorconfig|eslintrc|prettierrc|gitignore|npmrc)/.test(base) || /\.(ya?ml|toml|ini)$/.test(base)) {
		return "config";
	}
	if (/\.(png|jpe?g|svg|gif|webp|ico|woff2?|ttf)$/.test(base)) return "asset";
	if (/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|py|go|rs|java|kt|rb|sh|css|scss|html)$/.test(base)) {
		return "source";
	}
	return "other";
}

export interface ActionShape {
	key: string;
	verb: string;
	kind: "command" | "read" | "write" | "edit" | "other";
	/** Literal text with `{{argN}}` placeholders where a value was normalized away. */
	template: string;
	example: string;
	/** The literal values behind the placeholders, in order. */
	literals: Array<{ name: string; value: string }>;
	/** True for pure reconnaissance commands (ls, echo, git status, ...). */
	noise: boolean;
}

/**
 * Reduce one recorded tool call to a stable shape.
 *
 * Tool names come from pi (`bash`, `read`, `write`, `edit`, plus MCP tools), so
 * unknown tools fall back to a shape built from the tool name and its argument
 * names — still alignable, just less informative.
 */
export function shapeAction(toolName: string, args: Record<string, unknown>): ActionShape {
	const path = typeof args.path === "string" ? args.path : undefined;

	if (toolName === "bash" && typeof args.command === "string") {
		const analyzed = analyzeCommand(args.command);
		const { template, slots } = renderTemplate(
			analyzed,
			(token, occurrence) => token.suggested ?? `arg${occurrence + 1}`,
		);
		return {
			key: `bash::${analyzed.key}`,
			verb: analyzed.verb || "bash",
			kind: "command",
			template,
			example: args.command,
			literals: slots,
			noise: isNoiseCommand(analyzed.key),
		};
	}

	if ((toolName === "read" || toolName === "write" || toolName === "edit") && path) {
		const category = categorizeFile(path);
		const kind = toolName === "read" ? "read" : (toolName as "write" | "edit");
		return {
			key: `${toolName}::${category}`,
			verb: `${toolName} ${category}`,
			kind,
			template: `${toolName} {{path}}`,
			example: `${toolName} ${path}`,
			literals: [{ name: "path", value: path }],
			noise: kind === "read" && (category === "docs" || category === "other"),
		};
	}

	// Unknown tool: identity from the tool name plus its sorted argument names.
	const argNames = Object.keys(args).sort().join(",");
	return {
		key: `${toolName}::${argNames}`,
		verb: toolName,
		kind: "other",
		template: `${toolName}(${argNames})`,
		example: `${toolName} ${JSON.stringify(args).slice(0, 120)}`,
		literals: [],
		noise: /^(web_search|fetch_content|get_search_content|memory_search)$/.test(toolName),
	};
}
