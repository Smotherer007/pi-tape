# The `.tape` format, version 1

A tape is a portable, deterministic save-state of one pi agent run.

It is a single file. On disk it is gzip-compressed JSON; uncompressed JSON loads
just as well, so a tape can be inspected and hand-edited with any text tool.

- Extension: `.tape`
- Magic: `pi-tape`
- Current version: `1`
- Media type (suggested): `application/vnd.pi-tape+json`

## Design goals

1. **Self-contained.** A tape replays without the original `settings.json`,
   MCP servers, tool versions, or API keys. That is why the tool *declarations*
   are recorded alongside the results.
2. **Faithful by default.** The `normal` profile drops nothing. Lossiness is
   opt-in and always reported in `lossy` and `dropped`.
3. **Small.** gzip plus a string pool for repeated large payloads.
4. **Forgiving.** Unknown entry types, message roles and content blocks survive a
   record/playback round trip untouched. A debugger must not reject data it does
   not recognise.
5. **Verifiable.** `id` is a content address over the entries, so two recordings of
   the same branch are recognisably the same run.

## Top-level object

| Field | Type | Required | Meaning |
|---|---|---|---|
| `magic` | `"pi-tape"` | yes | Identifies the format. |
| `version` | `1` | yes | Format version. Readers reject unknown versions. |
| `id` | string | yes | `sha256:<hex>` over the canonical encoding of `entries`. |
| `created` | ISO 8601 string | yes | When the recording was made. |
| `name` | string | no | Human label, e.g. from `/tape record auth refactor`. |
| `profile` | `"full" \| "normal" \| "minimal"` | yes | Record profile used. |
| `lossy` | boolean | yes | True when the recording dropped information. |
| `dropped` | string[] | yes | Human-readable list of what was dropped. |
| `source` | object | yes | Provenance, see below. |
| `stats` | object | yes | Pre-computed run statistics, see below. |
| `outcome` | object | no | How the run ended, see below. Absent in tapes recorded before it existed. |
| `dict` | string[] | yes | String pool. May be empty. |
| `entries` | TapeEntry[] | yes | The recorded branch, in order. |

### `source`

| Field | Type | Meaning |
|---|---|---|
| `sessionFile` | string | Path of the pi session JSONL the recording came from. |
| `sessionId` | string | The session header's `id`. |
| `cwd` | string | Working directory of the session. |
| `piVersion` | string? | Version of pi that produced the session. |
| `leafId` | string \| null | The leaf whose ancestry was recorded. |

### `stats`

Aggregates over the recorded entries. Present so that `inspect` is cheap and so a
reader can summarise a tape without decoding the entries.

| Field | Type | Meaning |
|---|---|---|
| `entries` | number | Number of recorded entries. |
| `messages` | number | Entries with a `message` object. |
| `userMessages` | number | |
| `assistantMessages` | number | |
| `toolResults` | number | |
| `inputTokens` | number | Sum over recorded usage. |
| `outputTokens` | number | Sum over recorded usage. |
| `totalTokens` | number | Sum over recorded usage. |
| `costUsd` | number | Sum of recorded costs. |
| `tools` | string[] | Tool names seen in calls or results, sorted. |
| `models` | string[] | Model ids seen, sorted, first is used for replay. |

### `outcome`

Whether the run achieved anything is not visible in its transcript, so it is
derived at record time and stored. It is *not* part of `id`: the content address
covers `entries`, and how a run is judged is an interpretation of them.

| Field | Type | Meaning |
|---|---|---|
| `status` | `"success" \| "failed" \| "unknown"` | How the run ended. |
| `evidence` | string[] | Why, in a form that can be argued with. Credentials are redacted here too. |
| `declared` | boolean? | True when a human said so (`pi-tape record --status …`) rather than the recorder inferring it. |

How `status` is decided:

1. A declared status wins.
2. Otherwise the **last** verification command decides. `npm test`, `npm run build`,
   `pytest`, `cargo test`, `make`, `tsc` and friends are verification commands. A
   failed step that a later green verification made good is a successful run, and
   the failed attempt is still reported in `evidence`.
3. With no verification: any errored tool result makes it `failed`.
4. Otherwise `unknown` — never `success`. Absence of errors is not evidence that
   anything was achieved, the same rule the freshness check follows.

A recipe learned from several tapes carries the combined verdict, and
`pi-tape splice` keeps `failed` recordings out of the skeleton unless
`--include-failed` is passed. They are counted either way: a recording of what did
not work is evidence, but not about what the procedure is.

## Entries

`entries` holds the captured branch essentially verbatim, using pi's own session
entry shape (see pi's `docs/session-format.md`). Preserving it means a tape
can be turned back into a session file without loss.

Every entry has `type`, `id`, `parentId`, `timestamp`. A `message` entry adds a
`message` object with a `role`. The relevant roles are:

- `system` — carries `sections` (the prompt) and `toolsAdded` (the tool
  declarations). This is what makes replay self-contained.
- `user`
- `assistant` — carries `content`, plus `model`, `provider`, `usage`,
  `stopReason` and `responseId`.
- `toolResult` — carries `toolCallId`, `toolName`, `content` and `isError`.
  `toolCallId` is how a replay pairs a tool call with its recorded result.

Other entry types (`model_change`, `thinking_level_change`, `compaction`,
`context_edit`, `branch_summary`, `custom`, `custom_message`, `label`, `usage`,
`session_info`) are captured as-is. `usage`, `label` and `session_info` are
omitted by the `minimal` profile.

## The string pool

Any string of 256 characters or more is replaced by a reference and stored once
in `dict`:

```jsonc
{ "type": "text", "text": { "$d": 0 } }
```

`$d` is an index into `dict`. Identical strings share one slot, so a tool result
repeated across a long session is stored once. A reader expands references before
use; the pool is invisible to everything downstream.

An object is a reference **only** if it has exactly one key, `$d`, whose value is
a number. Any other object is ordinary data.

## Capture profiles

| Profile | Drops | `lossy` |
|---|---|---|
| `full` | nothing | `false` |
| `normal` | nothing; pools long strings | `false` |
| `minimal` | thinking blocks, `usage`/`label`/`session_info` entries, tool-result `details`/`nestedCalls`/`usage`, tool results truncated to 4000 characters | `true` |

`pi-tape record --redact` is not a profile. It runs a credential pass over the whole
recording — tool arguments, tool results, assistant text — replacing what looks like a
secret with `[redacted]`, and marks the tape `lossy` so nobody mistakes it for the same
run. It is the difference between a tape you keep and a tape you send. It catches what
is recognisable as a credential, which is not the same as catching everything: read a
tape before sharing it, and treat a shared tape as public.

A `minimal` tape still replays, but the request prefixes differ from the
original, so hash lookups fall back to position matching. Truncated results are
marked inline with a `[tape: truncated, N characters dropped]` suffix.

## Compatibility rules for readers

1. Reject a file whose `magic` is not `pi-tape`.
2. Reject a `version` you do not implement, with a message naming the version.
3. Accept unknown `type` values in entries and unknown `role` values in messages,
   and preserve them.
4. Treat unknown `stats` fields as absent rather than an error.
5. Expand `$d` references before interpreting any entry.
6. Treat a missing `outcome` as `unknown`, never as a success.

## Recording a tape

```bash
pi-tape record <session> --profile normal --name "auth refactor" -o run.tape
```

or from inside pi: `/tape record auth refactor`.

## Verifying a tape

```bash
pi-tape verify run.tape
```

`verify` walks the recording with the replay engine and reports whether every
recorded assistant answer and tool result can be served.

It replays the recording against itself, so it proves **internal consistency** —
that no entry is mangled, out of order, or unresolvable — and not fidelity to the
original run. A `minimal` capture always verifies, because it is consistent with
itself; it is simply not the same run any more. For that reason `verify` prints an
explicit note whenever it is asked to check a lossy capture.

## Comparison with pi's session files

| | Session JSONL | `.tape` |
|---|---|---|
| Purpose | live, append-only history | portable save-state of one run |
| Scope | every branch, forever | one root-to-leaf branch |
| Format | one JSON object per line | gzipped JSON, pooled strings |
| Portability | paths, no tool declarations guarantee | self-contained, shareable |
| Replay | not deterministic | deterministic, offline, free |

A tape is not a replacement for the session file; it is a distilled
extract that can be replayed anywhere.
