/**
 * Gaps: the parts of a recorded procedure that are *not* knowledge.
 *
 * A recipe is supposed to carry the procedure and leave the environment-specific
 * parts open. Two things go wrong if it does not:
 *
 *   a credential or an absolute path that happened to be the same in every
 *   recording is folded into the recipe as a constant, so the recipe silently
 *   carries a secret and stops being portable;
 *
 *   a value nobody can supply from the recipe alone is inlined as if it were
 *   knowledge, so a reader cannot tell "this is fixed" from "this was just what
 *   my machine happened to have".
 *
 * So every slot that is not plain knowledge gets a `GapKind`, and credentials are
 * replaced by a marker before they can reach a recipe file. This is deliberately
 * conservative: masking one thing too many costs a question, masking one too few
 * leaks a key.
 *
 * Nothing here is a model call. Given the same text this always decides the same
 * way, which is what makes a masked recipe reproducible.
 */

/**
 * What kind of thing a slot holds.
 *
 * - `secret`  a credential. Never stored, never inlined; the caller must supply it.
 * - `path`    a location on this machine. Resolvable by probing, not by knowledge.
 * - `env`     a fact about the environment: a version, port, host, OS.
 * - `choice`  one of several observed variants that must move together.
 * - `free`    ordinary knowledge or a name the caller simply decides.
 */
export type GapKind = "secret" | "path" | "env" | "choice" | "free";

/**
 * What replaces a credential inside a recipe.
 *
 * ASCII on purpose: the marker ends up in JSON, in logs and in `dub` output, and
 * a reader must be able to grep for it without remembering a code point.
 */
export const REDACTED_MARK = "[redacted]";

export interface SecretSpan {
	label: string;
	/** Start offset of the secret inside the text. */
	start: number;
	/** End offset, exclusive. */
	end: number;
}

interface SecretRule {
	label: string;
	/**
	 * Must expose the credential itself as a named group `secret`. The `d` flag
	 * gives `match.indices`, which is how the span is located; without it a rule
	 * that keeps scaffolding such as `Authorization: Bearer ` around the value
	 * could not say which part to remove.
	 */
	re: RegExp;
}

/**
 * Credential shapes, most specific first.
 *
 * False positives are the expensive kind of error here — masking a port mapping
 * or a `--prefix` path as a secret makes the recipe useless — so every rule needs
 * a value that is unambiguously a credential, not merely a word that sounds like
 * one.
 */
const SECRET_RULES: SecretRule[] = [
	{ label: "private_key", re: /(?<secret>-----BEGIN [A-Z ]*PRIVATE KEY-----)/d },
	// user:password@host — the host stays, the userinfo cannot.
	{ label: "url_credentials", re: /(?<pre>\b[a-z][a-z0-9+.-]*:\/\/)(?<secret>[^\s/:@]+:[^\s/@]+)(?<post>@)/id },
	{ label: "bearer_header", re: /(?<pre>\bauthorization\s*:\s*bearer\s+)(?<secret>[A-Za-z0-9._~+/-]{12,}=*)/id },
	{ label: "bearer_header", re: /(?<pre>\bbearer\s+)(?<secret>[A-Za-z0-9._~+/-]{12,}=*)/id },
	// Provider prefixes are self-identifying.
	{
		label: "provider_key",
		re: /(?<secret>\b(?:sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9]{16,}|sk_test_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}))/d,
	},
	{ label: "jwt", re: /(?<secret>\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})/d },
	// A flag that announces itself as a credential.
	{
		label: "flag_value",
		re: /(?<pre>--(?:password|passwd|token|api-?key|secret|auth|credential)s?(?:=|\s+)["']?)(?<secret>[^\s"']{6,})/id,
	},
	// FOO_TOKEN=... / DB_PASSWORD=... — the variable name says what it is, and the
	// value must not be a reference (`$TOKEN` points elsewhere and holds nothing).
	{
		label: "assignment",
		re: /(?<pre>\b[A-Z0-9_]*(?:API_?KEY|ACCESS_?KEY|SECRET_?KEY|PRIVATE_?KEY|PASSWORD|PASSWD|TOKEN|SECRET|CREDENTIAL)[A-Z0-9_]*\s*=\s*["']?)(?<secret>(?!\$)[^\s"']{4,})/d,
	},
];

/**
 * Rules used only when the *text body* of a recording is being cleaned.
 *
 * A tape is shared whole, so a credential written in prose is as much a leak as one
 * in a command line. These are deliberately over-eager, and they are only applied
 * where over-masking costs a redacted span rather than a piece of knowledge — a
 * recipe keeps the rules above.
 */
const AGGRESSIVE_RULES: SecretRule[] = [
	{
		label: "prose_credential",
		re: /(?<pre>\b(?:token|key|secret|password|passwd|api[_-]?key|apikey|credential|bearer|auth)\b[^A-Za-z0-9]{0,6})(?<secret>[A-Za-z0-9_\-./+=]{12,})/id,
	},
];

export interface FindSecretOptions {
	/** Also match a credential written in prose. For tape bodies, not for recipes. */
	aggressive?: boolean;
}

/** Locate the first credential in a piece of text, if there is one. */
export function findSecret(text: string, options: FindSecretOptions = {}): SecretSpan | undefined {
	const rules = options.aggressive ? [...SECRET_RULES, ...AGGRESSIVE_RULES] : SECRET_RULES;
	for (const rule of rules) {
		const match = rule.re.exec(text);
		const span = match?.indices?.groups?.secret;
		if (match && span) return { label: rule.label, start: span[0], end: span[1] };
	}
	return undefined;
}

/** The credential label of a piece of text, for a slot name. */
export function secretLabelOf(text: string): string | undefined {
	return findSecret(text)?.label;
}

/**
 * Files that *are* credential material.
 *
 * Deliberately not `.env` and `.npmrc`: those are configuration that may name a
 * credential, so they are a `path` gap — you still have to write the file, but
 * the location is ordinary knowledge. A private key, by contrast, is the secret
 * itself, and naming where it lives tells a reader nothing worth keeping.
 */
const CREDENTIAL_FILE = /(^|\/)(\.netrc|\.pgpass|credentials|id_(rsa|ed25519|ecdsa))$/i;
const CREDENTIAL_EXTENSION = /\.(pem|key|p12|pfx|jks|keystore)$/i;
/** A template or example file is documentation *about* a secret, not one. */
const SECRET_EXAMPLE = /\.(example|sample|template|dist)$/i;

export function isSecretPath(path: string): boolean {
	if (SECRET_EXAMPLE.test(path)) return false;
	return CREDENTIAL_FILE.test(path) || CREDENTIAL_EXTENSION.test(path);
}

/**
 * Shell variables that hold a credential or a machine-specific location.
 *
 * A variable is the *reference*, not the value, so nothing leaks by naming it —
 * which is exactly why `$NPM_TOKEN` should become a named gap instead of being
 * folded into a constant.
 */
const SECRET_VARIABLE = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH)/i;

export function isSecretVariableName(name: string): boolean {
	return SECRET_VARIABLE.test(name);
}

/** Slot names that describe the environment rather than knowledge. */
const ENVIRONMENT_NAMES = new Set([
	"version",
	"port",
	"host",
	"hostname",
	"url",
	"endpoint",
	"server",
	"domain",
	"region",
	"zone",
	"os",
	"arch",
	"platform",
	"machine",
	"user",
	"username",
	"node",
	"ip",
	"address",
	"registry",
	"mirror",
]);

/** Slot names that describe a location. */
const LOCATION_NAMES = new Set(["path", "target", "dir", "directory", "folder", "cwd", "file"]);

/** Value shapes that are a location no matter what the slot is called. */
function looksLikeAbsolutePath(value: string): boolean {
	return /^(\.{1,2}\/|\/|~\/|[A-Za-z]:[\\/])/.test(value);
}

/**
 * True when a path would still mean the same thing on someone else's machine.
 *
 * `src/main.py` is part of the procedure. `/home/alice/src/main.py` is a fact
 * about one machine, and folding it in is how a recipe becomes non-portable.
 */
export function isPortablePath(value: string): boolean {
	return !looksLikeAbsolutePath(value);
}

/**
 * True when a slot has to stay open even if every recording agreed on it.
 *
 * This is the rule that keeps the recipe honest: agreement between recordings is
 * not evidence that a value is knowledge. Four recordings that used the same API
 * key agree about the key, not about the procedure.
 */
export function mustStayOpen(kind: GapKind, value: string): boolean {
	if (kind === "secret" || kind === "env") return true;
	if (kind === "path") return !isPortablePath(value);
	return false;
}

export interface GapKindInput {
	/** Slot name from the position rules or the command shape. */
	name?: string;
	/** The observed value (already masked when it was a credential). */
	value: string;
	/** Set when the text itself was recognised as a credential. */
	secretLabel?: string;
}

/**
 * What kind of gap a slot is.
 *
 * The credential check comes first and cannot be overridden: a secret is a secret
 * whatever the surrounding command calls it.
 */
export function classifyGapKind(input: GapKindInput): GapKind {
	if (input.secretLabel) return "secret";
	if (isSecretPath(input.value)) return "secret";

	const name = input.name?.toLowerCase();
	if (name && LOCATION_NAMES.has(name)) return "path";
	if (name && ENVIRONMENT_NAMES.has(name)) return "env";
	if (looksLikeAbsolutePath(input.value)) return "path";
	return "free";
}

/** Replace every credential in a text with the marker. Used for result payloads. */
export function redactText(text: string, options: FindSecretOptions = {}): string {
	let out = text;
	// Bounded: a pathological input must not make the recorder spin.
	for (let guard = 0; guard < 64; guard++) {
		const span = findSecret(out, options);
		if (!span) return out;
		// The scaffolding the aggressive rules keep in front of the value is dropped
		// only when it is part of the match; the marker replaces the secret itself.
		out = `${out.slice(0, span.start)}${REDACTED_MARK}${out.slice(span.end)}`;
	}
	return out;
}

/** True when a text still carries something credential-shaped. */
export function containsSecret(text: string, options: FindSecretOptions = {}): boolean {
	return findSecret(text, options) !== undefined;
}

/**
 * Redact every credential in a value tree, counting what was replaced.
 *
 * Used on a recording before it can be written to disk, so a tape can be handed
 * to someone else. Only strings are touched — keys are field names, and rewriting
 * `apiKey` into `[redacted]` would break the shape a reader depends on.
 */
function redactValue(value: unknown, counter: { count: number }, depth = 0): unknown {
	if (typeof value === "string") {
		const redacted = redactText(value, { aggressive: true });
		if (redacted !== value) counter.count++;
		return redacted;
	}
	// A depth cap keeps a pathological payload from being walked forever; a session
	// entry is a handful of levels deep, so nothing real is missed.
	if (depth > 12) return value;
	if (Array.isArray(value)) return value.map((item) => redactValue(item, counter, depth + 1));
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = redactValue(item, counter, depth + 1);
		}
		return out;
	}
	return value;
}

/**
 * Strip credentials from recorded entries.
 *
 * This is the difference between a tape you keep and a tape you send: tool
 * arguments, tool results and assistant text all pass through the same rules the
 * recipe layer uses, so what cannot reach a recipe cannot leave in a tape either.
 *
 * The result is deterministic, so a redacted tape still replays against itself —
 * but it is no longer the same run, which is why the caller has to mark it lossy.
 */
export function redactEntries<T>(entries: T[]): { entries: T[]; redactions: number } {
	const counter = { count: 0 };
	const out = entries.map((entry) => redactValue(entry, counter) as T);
	return { entries: out, redactions: counter.count };
}

/** One line for a reader who has to supply the value. */
export function gapHint(kind: GapKind, name: string): string {
	switch (kind) {
		case "secret":
			return `supply ${name} at run time — it was redacted from the recordings and is deliberately not stored`;
		case "path":
			return `resolve ${name} for this machine (probe or ask); the recorded location is not portable`;
		case "env":
			return `read ${name} from the environment (probe) rather than assuming the recorded value`;
		case "choice":
			return `choose one observed variant of ${name}`;
		case "free":
			return `supply ${name}`;
	}
}
