/**
 * Credential redaction.
 *
 * The expensive mistake here is the quiet one: a rule that matches a credential's
 * *header* and leaves the material behind looks like it worked. These tests assert
 * on the secret body, not on the marker.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED_MARK, containsSecret, findSecret, redactEntries, redactText } from "../src/redact.ts";

const OPENSSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACB0aGlzSXNBU0VDUkVUS0VZQk9EWVRIQVRTSE9VTERC
-----END OPENSSH PRIVATE KEY-----`;

const RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAx7VkSGVsbG9UaGlzSXNBVGVzdEtleUJvZHlGb3JSZWReY3Rpb24=
-----END RSA PRIVATE KEY-----`;

test("a private key is redacted whole, not just its header", () => {
	const out = redactText(OPENSSH_KEY);

	assert.equal(out, REDACTED_MARK, "the entire block is replaced, so nothing is left to grep for");
	assert.equal(out.includes("b3BlbnNzaC1rZXk"), false, "the base64 body must not survive");
	assert.equal(out.includes("END OPENSSH PRIVATE KEY"), false, "the trailer must not survive either");
});

test("an RSA key is redacted whole too", () => {
	const out = redactText(RSA_KEY);
	assert.equal(out.includes("MIIEowIBAAKCAQEA"), false);
	assert.equal(out, REDACTED_MARK);
});

test("a key embedded in surrounding text keeps the text and drops the key", () => {
	const out = redactText(`here is the deploy key:\n${OPENSSH_KEY}\nuse it sparingly`);
	assert.match(out, /^here is the deploy key:/);
	assert.match(out, /use it sparingly$/);
	assert.equal(out.includes("b3BlbnNzaC1rZXk"), false);
});

test("a key that was cut off still redacts to the end of the text", () => {
	// A truncated capture is exactly when a leak is easiest: there is no END line
	// for the rule to anchor on, so a block pattern alone would miss it entirely.
	const truncated = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\n`;
	const out = redactText(truncated);
	assert.equal(out, REDACTED_MARK);
	assert.equal(out.includes("b3BlbnNzaC1rZXk"), false);
});

test("two keys in one text are both replaced", () => {
	const out = redactText(`${OPENSSH_KEY}\n\n${RSA_KEY}`);
	assert.equal(out, `${REDACTED_MARK}\n\n${REDACTED_MARK}`);
});

test("redactEntries cleans a tool result and counts it once per string", () => {
	const entries = [
		{ type: "message", message: { role: "toolResult", output: OPENSSH_KEY } },
		{ type: "message", message: { role: "toolResult", output: "nothing to see" } },
	];
	const { entries: redacted, redactions } = redactEntries(entries);

	assert.equal(redactions, 1, "only the entry that held a credential is counted");
	assert.equal(JSON.stringify(redacted).includes("b3BlbnNzaC1rZXk"), false);
});

test("findSecret reports the whole block so the span is not a prefix", () => {
	const span = findSecret(OPENSSH_KEY);
	assert.ok(span);
	assert.equal(span.start, 0);
	assert.equal(span.end, OPENSSH_KEY.length, "the span covers the key through its END line");
	assert.equal(span.label, "private_key");
});

test("ordinary text stays untouched, and is not reported as a secret", () => {
	const text = "PRIVATE KEY ROTATION is a runbook section, not a credential";
	assert.equal(redactText(text), text);
	assert.equal(containsSecret(text), false);
});
