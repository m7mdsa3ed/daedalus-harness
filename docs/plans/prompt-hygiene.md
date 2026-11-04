# Prompt hygiene: a local scanner for secrets before a message is sent

_Status: proposal. Nothing here is built. Slice one is a deterministic scanner that runs in the browser
and sends nothing anywhere. A decision-model pass is described last and is explicitly a second slice._

## Why

A message is the one place the reader can leak a credential without noticing: a pasted `.env`, a `curl`
with a bearer token, a stack trace with a connection string, a private key from a terminal. Once sent, the
text goes to a model provider, is written to the journal (`session-journal.ts`), is replayed to every
peer, and may be copied into search (`FTS`) and a trace. Taking it back is not possible.

The check wanted is narrow and exact: *does this text contain something shaped like a credential?* That is
a pattern question, not a judgement one. A scanner answers it instantly, for free, and the same way
every time, which a model does not.

## Why local first, and why not the decision model

The obvious design, ask the decision lane (`decide.ts`) "does this contain a secret?", is wrong for this
check. **Sending the message to a decision model is itself the leak.** The decision profile is a third
party endpoint; a secret in the text arrives there before the answer comes back. A feature that protects
secrets by shipping them elsewhere has the failure it exists to prevent.

So slice one never leaves the device. Slice two (the model pass) may only run on text that has already
passed the local scan, and only for questions that are not about secrets.

## Where it runs

**At send, in the composer, on the text that is actually leaving.** `composer.tsx` builds `outgoing` (the
typed words with paste tokens expanded) and `beforeSend` runs after the box is cleared. The scan must read
`outgoing`, not `value`: a pasted `.env` is a token (`[Pasted text #1]`) in `value`, and the secret is in
the document behind it. Scanning the typed words would miss exactly the case that matters.

- **Not per keystroke.** A warning that flickers while typing is noise, and a half-typed `sk-` is not a
  key. It also keeps the scan off the typing path.
- **Not on the server.** The server cannot ask the reader anything; by the time a prompt reaches it, the
  decision has been made. (A server-side scan has one legitimate home, the agent tool path, which is
  out of scope here: see "Not in this plan".)
- **A pause in the send, not a gate before the box clears.** Today the box clears first on purpose (see the
  comment in `composer.tsx` above `beforeSend`). A hygiene hold must run *before* that clear, or the
  recovery path (`onUnsent`) has to put the words back, which is the case `onUnsent` refuses when the
  reader has started typing again. Scan first; only on a clean result does the existing sequence run.

## The scanner

One pure module, `client/src/lib/prompt-scan.ts`, no dependencies, no network, returns findings and never
the text.

```ts
export interface ScanFinding {
  kind: string;            // "aws-access-key", "private-key", "bearer-token", ...
  label: string;           // the words the chip uses: "an AWS access key"
  line: number;            // 1-based, in the scanned text
  preview: string;         // masked: "AKIA************MPLE"
}
export function scanPrompt(text: string): ScanFinding[];
```

**Two kinds of rule, kept apart because their error rates differ:**

1. **Prefixed tokens (high confidence).** A vendor prefix plus a length and alphabet, anchored on a word
   boundary: AWS access key ids (`AKIA`/`ASIA` + 16), GitHub (`ghp_`, `gho_`, `github_pat_`), Slack
   (`xox[baprs]-`), Stripe (`sk_live_`, `rk_live_`), Anthropic and OpenAI style (`sk-ant-`, `sk-` with a
   long tail), Google API (`AIza` + 35), JWT (three base64url segments starting `eyJ`), PEM blocks
   (`-----BEGIN ... PRIVATE KEY-----`), and URLs with embedded credentials (`scheme://user:pass@host`).
   These almost never misfire.
2. **Assignments (medium confidence).** A key name that says it is secret, then a value:
   `(api[_-]?key|secret|token|passw(or)?d|authorization)\s*[:=]\s*<value>`, and `Authorization: Bearer
   <value>`. The value must be long (>= 12), not a placeholder (`your_key_here`, `xxxxxxxx`,
   `<token>`, `${...}`, `process.env.`, `os.environ`), and not an obvious reference. Reading a variable
   name is not leaking it.

**No generic entropy rule in slice one.** "High-entropy string" flags git SHAs, UUIDs, hashes, base64
images and minified code; a warning that fires on every pasted diff gets turned off, and then it protects
nothing. If it is ever added it is a third, off-by-default tier.

**Masking is a hard rule.** A finding carries a preview with the middle replaced, and the scanner's output
is never logged, never put in `console`, never sent to the server, never stored in drafts or history. The
detail that identifies the secret must not exist anywhere but the composer's own text.

### Allowlist

The false positives that matter are *the reader's own examples*: a doc that shows `AKIAIOSFODNN7EXAMPLE`
(AWS's published example) or `sk-xxxxxxxx`. Rules skip values containing `EXAMPLE`, `example`, `dummy`,
`placeholder`, `changeme`, or a run of one repeated character. Beyond that, the reader's answer to a
warning is "Send anyway", and nothing is remembered about it (see below).

## The hold

When the scan finds something, the send is **held, not refused**.

> **This looks like an AWS access key (line 4).** Send anyway - Edit message

- The words are in the composer's own notice slot, the way a held turn is drawn: the message is still in
  the box, the caret is where it was, nothing has been sent, nothing was cleared.
- **Edit** just dismisses the hold and returns focus. The reader finds the line themselves; the finding
  names the line, and a masked preview, not the secret.
- **Send anyway** sends exactly what was typed. The agent receives the message unchanged: **the scanner
  never rewrites, redacts or drops text**. A silent edit to a prompt is a worse bug than a leaked key,
  because the reader cannot see it and the agent acts on words nobody wrote.
- **Several findings are one hold,** listed by kind and line, capped at five with "and N more".
- **One hold per message.** After "Send anyway" the same text is not re-scanned. Editing and sending again
  scans again, which is correct: the reader changed it.

### What is deliberately not remembered

"Send anyway" is not persisted: no "don't warn me about this key", no per-project allowlist of secrets.
Remembering a secret to ignore it means storing it. The only durable controls are the switch below and the
rule set itself.

## Scope: where the scanner applies

| Door | Scanned | Why |
| --- | --- | --- |
| Composer send, steer, queue | yes | the main path |
| Draft first message (New tab, project +) | yes | same composer |
| `!` shell command | no | the reader is running it on their own machine; the text goes to a shell, not a model |
| Slash commands | no | a name and arguments the agent resolves; scanned as text if it carries a pasted block |
| Paste into the composer | no | a warning at paste time is too early to be useful, and the paste may be trimmed |
| Voice | not applicable | no text to scan until transcribed; revisit if transcripts are sent as text |

A queued row is scanned when it is **added**, not when it drains, so the hold appears where the reader is
looking.

## Settings

- **One reader switch,** `View options` / composer: *Warn before sending something that looks like a
  secret*. **On by default.** It is device-local like the other composer behaviours (`lib/view-options.ts`),
  because how the box behaves is the reader's property, not the conversation's.
- **No server flag, no per-project flag in slice one.** A scan that never leaves the device has nothing for
  a server to govern. (If a team wants it enforced, that is a different feature: policy, not hygiene.)
- **No `FEATURES` entry.** It is client-only and an older server is unaffected.

## Not in this plan

- **Agent output and tool results.** A model echoing a secret back, or a tool printing `.env`, is a
  different surface: the text is already in the journal. It deserves its own plan (a server-side scan
  where `update` frames are journaled, and a decision on whether to mask on replay). Do not conflate it
  with the composer.
- **Redacting stored history.** `composer-history.ts` records what was typed. A message sent with "Send
  anyway" stays in history; scrubbing it is a separate, destructive operation.
- **Blocking.** Nothing in this plan can stop a send the reader insists on.

## Slice two: the decision-model pass (optional, later)

Only for questions a pattern cannot answer, and only after the local scan came back clean:

- `noul`: *asks for something irreversible* ("drop the production database", "force push to main",
  "delete everything under /").
- `noul`: *contains personal data* (names with addresses, national ids, medical detail).

Constraints, in order of importance:

1. **Opt-in, per reader, off by default.** The text goes to the decision profile's endpoint, so the reader
   must know that and choose it. The switch says which profile receives the text.
2. **Never the secret path.** If the local scan found anything, the model is not asked, full stop.
3. **Same machinery as persona:** `sideTarget("decision", {})`, a `GateSkip` per case, a short timeout, and
   every failure answering "no warning" quietly. A 429 on the free tier is the usual case, not an edge.
4. **Advisory, same chip.** It can use the same hold. The wording is a question ("This asks to delete
   data. Send anyway?"), never a verdict.
5. **Off the send path's critical latency?** It is not: a hold needs the answer before the send. That makes
   the timeout a direct cost on every message. Budget 800ms and fail open; if the real gateway cannot meet
   that, this slice does not ship.

## What to build, in order

1. `client/src/lib/prompt-scan.ts` with the rule table and `scanPrompt`.
2. Tests (`client/src/lib/prompt-scan.test.ts`): every prefixed rule with a real-shaped fixture; every
   assignment rule; the allowlist and placeholders; a pasted-document case; previews are masked and
   contain no more than 4 characters of the original; and a corpus of ordinary prompts (code, diffs, git
   SHAs, UUIDs, base64) that must produce **zero** findings.
3. The hold in `composer.tsx`: scan `outgoing` before the box clears, draw the notice, Send anyway / Edit.
4. The View options switch and its default.
5. Wire the queue-add path.

## What this plan cannot verify

- **The false-positive rate on real prompts.** The corpus test is the guard, but the real measure is this
  install's own history. Before shipping, run the scanner over `composer_history` locally and read every
  hit, which is a one-off script that prints counts per rule and nothing else.
- **Rule drift.** Vendors change token formats. The rule table is a list of data, not logic, so a change
  is one line, but nobody is watching for them. A comment with a date per rule is the cheapest signal.
- **Whether holding feels right in the composer.** The hold sits where a held turn is drawn; whether it
  reads as a warning or as a blocker needs a look at the real composer, not a spec.

## Open questions

- **Scan attachments?** Files added through "+" go the attachment path (`files`). A `.env` attached as a
  file is the same leak as a pasted one. Recommend yes for text files under a size cap, as a fast follow.
- **Mask the preview at all?** Showing `AKIA************MPLE` helps the reader find the line but leaks 8
  characters into the UI. Recommend keeping 4 and 4 for prefixed tokens and nothing for private keys and
  assignments (the line number is enough).
- **Does a hold apply to a workflow step prompt or a schedule's text?** Those are written ahead of time in
  forms, not the composer. Out of scope here; the same module could serve them.
