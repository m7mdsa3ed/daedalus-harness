# Daedalus Harness — Composer attachments and long-text paste

## Context

Today **the prompt is a `string` end to end**, and that is not an accident of implementation —
it is the shape every layer was allowed to stay simple because of. The draft is a
localStorage string (`lib/drafts.ts`), the wire command is `{cmd:"prompt", text}`
(`protocol.ts:183`), the queue row is a SQLite `TEXT` column (`schema.ts:610`), the journal's
`turn_started` carries `text` (`protocol.ts:344`), the transcript item is `TextItem.text`
(`store.tsx:30`), Retry re-sends `turn_ended.text`, and prompt history is derived from the
transcript's own user turns (`thread-view.tsx:531`). Six independent readers of one shape.

The single place a richer payload already reaches the agent is `AcpBridge.prompt`
(`acp-bridge.ts:734`):

```ts
prompt: [{ type: "text", text }, ...mentionLinks(this.cwd, text)]
```

which is also the precedent this plan follows. `server/src/mentions.ts` added a *protocol*
half — ACP `resource_link` blocks — without any of the six string readers learning a second
shape, because the text stayed the text and the links were **derived from it** at the last
moment. The file says so in its own header comment: dropping the text in favour of the links
"would make the transcript — which is the text — stop saying what the user typed."

Two features are asked for here, and the useful discovery is that **they are not the same
feature**:

- **Long-text paste** is a *composer* problem. A 4,000-line stack trace pasted into the
  textarea is still exactly the prompt the user means to send; it just must not fill the
  screen while they type the sentence around it. Nothing downstream needs to change — this
  can be, and therefore will be, an entirely client-side affordance that resolves back to a
  string before `actions.send` is called.
- **Attachments** (an image on the clipboard, a PDF dragged onto the composer, a file
  picked) are bytes that were never text. They cannot be spliced into a string, so they are
  the part that costs protocol, persistence and rendering. They are also the part that
  depends on a capability the agent may not have (`agentCapabilities.promptCapabilities.image`
  — read but currently unused at `acp-bridge.ts:367`) **and on a capability the model may not
  have, which is not the same question**. A thread is a (profile, agent) pair spending a
  model: Claude Code advertises `image` because the runtime can carry the block, while the
  GLM behind the gateway shim cannot see it. Trusting the runtime alone base64s the image
  into the prompt frame, the gateway answers 400, and the turn dies *after* the upload and
  *after* the send — the worst place to learn it, and one no fallback chain keyed on the
  agent can reach, because the agent said yes.

Splitting them this way means Phase 1 ships alone, with no schema push, no protocol version
skew and no journal shape change.

### Decisions locked

- **A paste chip is a token in the text, not a field beside it.** Pasting a long block
  inserts `[pasted text #1]` at the caret and parks the body in a device-local sidecar; on
  send the token is expanded back in place. The user can move it, delete it, or type around
  it exactly as they can any other text, placement is free, and a chip whose token is gone is
  simply dropped. The alternative — a list of pastes appended at send — makes the composer own
  an ordering the user cannot see or change.
- **Attachment bytes never enter the journal, the queue row or the store.** All three carry
  *references* (`{id, name, mimeType, size}`); the bytes live once on disk under `data/` and
  are fetched by id. This is the `REPLAY_CHUNK_BYTES` lesson (`protocol.ts:223`) stated ahead
  of time rather than after: a 6 MB base64 image journaled into `session_events` is a frame
  held whole as a string on both ends of every replay, forever, of a thread whose transcript
  is otherwise a few hundred bytes per event.
- **An attachment is uploaded before the session exists.** Threads start as drafts and
  `POST /api/sessions` is deliberately not called until the first message, so an upload route
  scoped to a session id would 404 on exactly the composer that needs it most. Attachments are
  therefore owned by nobody at upload time and **claimed** by the prompt that references them;
  unclaimed rows are swept.
- **Capability decides the block, never the feature — and capability is the agent *and* the
  model, intersected.** `promptCapabilities` is the **runtime's** capability, advertised once
  at `initialize` and identical for every thread on that binary: claude-agent-acp says
  `image: true` because it can carry an image block, which says nothing about the text-only
  gateway model the thread is actually spending. The model's half is `ModelDef.modalities`,
  which already exists (`db/schema.ts:33`), is already filled from models.dev
  (`provider-models.ts:148`), is already hand-editable (`settings/profile-models.tsx:396`)
  and already reaches the browser (`lib/settings.ts:390`) — and whose schema comment today
  says it is *"display/enrichment only — nothing at spawn time reads it"*. This plan gives it
  a reader. See **Phase 3.5**, which is where the intersection lives; the fallback below is
  what a veto from either side falls to. The composer looks the same either way — degrading
  to "you cannot attach that here" would make the affordance depend on which profile a thread
  happens to be on — but the chip **says which branch it took**, because a thumbnail the
  model never saw looks identical to one it did.
- **A catalog that lists modalities is a statement; a catalog that lists none is text.** A
  `ModelDef` whose `modalities` lack `image` is a positive "this model cannot see pictures",
  and a `ModelDef` with no `modalities` at all is read the same conservative way — a gateway
  id models.dev has never heard of is not an invitation to guess. The one carve-out is a
  profile with **no `models[]` at all**, which is a different silence: `defaultProfileFor`
  ships no catalog precisely to mean *defer to the agent*, and a Default thread is the agent
  running on its own subscription, which is exactly where `promptCapabilities` is
  authoritative. Without the carve-out, Claude Code on its own login — the most capable image
  path there is — would never inline an image.
- **Attachments do not survive Retry or prompt history.** Both are string paths by
  construction (`turn_ended.text`, `items[].text`), and quietly re-attaching bytes to a
  re-sent string is a second send the user did not compose. Retry re-sends the text; the row
  says so — and reads **"Retry (text only)"** when the turn it belongs to carried
  attachments, since a plain Retry on a turn that had an image produces prose referring to a
  picture that is no longer there, which looks like a bug rather than a rule.
  The **one** exception is the failure this whole capability story exists around: a turn that
  died with inline attachment blocks in it gets a second variant, **"Retry as file paths"**,
  which re-sends the same bytes pinned to the materialise-and-link branch. See Phase 6.
- **No new chord.** `lib/shortcuts.ts` holds the rule that a bound key is a listed key; an
  attach button and ⌘V/drop cover this without spending a chord or a `SHORTCUTS` row.

### Non-goals

Audio capture (the `audio` block exists; nothing in the UI records), attachments on a
*scheduled* prompt, attachments inside a workflow step's brief, editing an attachment on a
queued message (a queued item's chips are shown and removable, not addable), and any attempt
to render a PDF inline — a non-image attachment is a chip with a download.

---

## Phase 1 — Long-text paste (client only)

No server, no protocol, no schema. `client/src/lib/pastes.ts` + composer wiring.

**`lib/pastes.ts`** — device-local, per-session, same reactive-store shape as `lib/drafts.ts`
and `lib/pins.ts`, which is also what it must sit beside: `drafts.ts` persists a *string* and
every one of its callers depends on that, so the sidecar is a second key
(`ui.draft-pastes.<sessionId>`) rather than a widened value. Same 300 ms debounce, same
`pagehide`/`visibilitychange` flush, and it joins the `refreshSessions` prune with the other
three.

```ts
export type Paste = { n: number; text: string; lines: number; chars: number }
export const PASTE_MIN_CHARS = 1200
export const PASTE_MIN_LINES = 12
export function pasteToken(n: number): string   // `[pasted text #${n}]`
export function expandPastes(text: string, pastes: Paste[]): string
```

- **The threshold is either/or.** A 40-line YAML file is under 1200 chars and is still the
  thing that must not eat the composer; a single 3,000-character minified line has no
  newlines at all. Below both, paste behaves as it always has and no chip appears — the
  feature must be invisible for the pastes people actually make most often (a URL, an error
  message, a name).
- **Expansion is fenced with a computed fence.** `expandPastes` wraps each body in a run of
  backticks one longer than the longest run inside it (the markdown rule), because pasted
  content is very often itself code containing triple backticks, and a fence that closes
  early turns the rest of the prompt into prose the agent reads as narration. The block is
  preceded by nothing else: no `<pasted text>` pseudo-tag, since that is a shape the agent has
  to be taught, where a fence is one it already knows.
- **Numbering is stable, not positional.** `n` is assigned monotonically per draft and never
  reused within it; deleting chip #2 leaves #1 and #3 as they were, because renumbering would
  silently repoint a token the user had already moved somewhere in their sentence.
- **A token the user deleted drops its paste**, checked at send (`text.includes(pasteToken(n))`)
  and also on every keystroke so the chip disappears as the token does — the chip is a *view*
  of a token, and a chip with no token is a claim the composer cannot honour.

**Composer wiring** (`components/thread-view.tsx`, `Composer` at `:599`):

- `onPaste` on the textarea: read `event.clipboardData.getData("text/plain")`; if it clears
  either threshold, `preventDefault`, mint a `Paste`, and insert `pasteToken(n)` at the caret.
  Caret placement after the insert is the same hazard `file-mentions.tsx` documents — the
  rewrite of `text` is a render, and the caret it wants must be re-applied *after* that render
  and ahead of the `selectionStart` sync, or the effect that follows the selection undoes the
  placement. Reuse that file's approach rather than inventing a second one.
- `send()` (`:651`) composes `expandPastes(text.trim(), pastes)` and passes the result to
  `actions.send`. Everything downstream — the optimistic user bubble, the queue, the journal,
  the transcript, prompt history — sees the same string it always did, which is the whole
  point: the transcript says what was sent, including the pasted body, and a reload of a sent
  turn has nothing new to reconstruct.
- `clearDraft` gains a `clearPastes` beside it on every path that clears (send, and the
  `/schedule` interception at `:660` that deliberately does *not* clear — pastes follow the
  draft's rule exactly, including that one).

**Chip rendering** — the chip row is a new segment on `components/composer-strip.tsx` (summary
id `attachments`), which already owns the shelf above the composer and its collapse behaviour.
A paste chip shows `Pasted text #1 · 412 lines` and opens a read-only preview popover on
click; its ✕ deletes both the chip and its token. Per the container rule in CLAUDE.md the row
is `@panel-sm:`-driven, not `sm:` — a chat panel docked beside a terminal is 320 px wide in a
1600 px window, and this row is exactly the kind of thing that was drawing the desktop layout
there.

---

## Phase 2 — The attachment store (server)

**Schema** (`server/src/db/schema.ts`, then `pnpm db:push` — no migration file; this is a pure
add):

```ts
export const attachments = sqliteTable("attachments", {
  id: text("id").primaryKey(),              // client-minted UUID, like a session id
  sessionId: text("session_id"),            // NULL until claimed. NOT a foreign key — see below
  name: text("name").notNull(),             // the user's filename, for display only
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  sha256: text("sha256").notNull(),
  createdAt: integer("created_at").notNull(),
  claimedAt: integer("claimed_at"),
})
```

`session_id` is **not** an FK, and for the same reason `sessions.parent_session_id` is not:
a row is created before any session exists, and a cascade would take the file's row out from
under a manager that still owns the bytes on disk. `purge` and `softDelete` in `sessions.ts`
delete an attachment's row and file by hand, children first, exactly as they already cascade
to `childrenOf`.

**Bytes** live at `data/attachments/<id>` (flat; the id is a UUID, and a per-session directory
would have to be moved on claim). `server/src/attachments.ts` owns the directory, mirroring
`model-catalog.ts`'s use of `DATA_DIR`.

**Routes** (`server/src/routes/attachments.ts`, registered in `index.ts` beside the others, so
it is under the `/api/*` bearer middleware — unlike `/gw` and `/ide`, this route has no child
process for a caller and no reason to leave the fence):

- `POST /api/attachments` — **raw body, not multipart.** `Content-Type` is the mime type and
  `X-Filename` (RFC 2047-free; percent-encoded) is the name; the client mints the id and sends
  it as `X-Attachment-Id`. Nothing in this codebase parses multipart today and adding a parser
  to accept one file per request is a dependency bought for nothing. Answers
  `{id, name, mimeType, size}`.
- `GET /api/attachments/:id` — the bytes, with the exact header set `file-raw` already uses
  (`routes/workspace.ts:92`): `Content-Disposition: inline`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, and the `default-src 'none'; sandbox` CSP. That header
  block exists because the server serves user-controlled bytes from its own origin, and an
  uploaded file is more of that, not less.
- `DELETE /api/attachments/:id` — for a chip removed before send.

**Limits**, declared once and enforced on both ends: `MAX_ATTACHMENT_BYTES = 10 MB` per file,
`MAX_INLINE_PROMPT_BYTES = 20 MB` per prompt, `MAX_ATTACHMENTS = 10` per prompt. The
per-prompt cap is the one that matters and it is not about disk: an ACP prompt is a single
JSON-RPC frame written to the child's stdin, base64 is 4/3, and a 60 MB line is a stall in a
place with no backpressure story.

The two caps refuse differently, and that is the point. Per file is a **413** (matching
`workspace-fs.ts:507`) — the harness will not hold those bytes. Per prompt is an **inline
budget**, not a refusal: it is spent only by the branches that put bytes in the frame
(`image`/`audio`/`resource`), and a file that would overrun it **degrades to a path** rather
than failing the send. A path costs the frame nothing, so the user should only ever be
refused for something the harness genuinely cannot deliver. That is `resolveDelivery`'s first
rule (Phase 3.5), which is also why the budget is threaded down through the loop rather than
checked once.

**`sha256` has a reader.** `POST /api/attachments` is idempotent on content: a client that
hashes before uploading gets back the existing id, and the bytes are written once. That makes
retry-after-a-failed-upload free (Phase 6 draws an error chip with a retry, and the retry is
then a no-op on the wire), and makes the same screenshot dropped into five threads cost one
file. Rows stay one per claim — a claim is a thread's, a file is content's — so the sweep
deletes bytes only when no row still references that hash.

**Sweep**: unclaimed rows older than 24 h, and rows whose file is missing, on the same idle
timer the session sweep uses. An upload whose prompt was never sent is a draft the user
abandoned; keeping it forever is a disk leak with no reader.

**Backup**: attachment rows are **excluded**, the same way `history_*` rows already are
(`backup.ts` — "meaningless without the snapshot files"). The journaled `turn_started` refs
still travel, so a restored transcript draws the chips and the thumbnail resolves to a 404 —
which the chip renders as a "missing" state in Phase 5. That is honest; a bundle that inlined
every image would be the install's disk in a JSON document.

---

## Phase 3 — Plumbing the references

The additive half. Every change here is a new **optional** field, so an event journaled before
this phase keeps its exact shape and replays unchanged — the rule `update.sessionId` was added
under for subagents.

- `protocol.ts`: `export type AttachmentRef = { id, name, mimeType, size }`. One declaration,
  imported by both ends, like `QuotaSnapshot`.
  - `{cmd:"prompt", text, attachmentIds?: string[], forceLink?: boolean}`; the ids are the
    same on `queue_add` and `queue_update`. `forceLink` pins every attachment on this one
    prompt to the materialise-and-link branch whatever the capabilities say, and it has
    exactly one caller: the "Retry as file paths" variant in Phase 6.
  - `turn_started` gains `attachments?: AttachmentRef[]` — **journaled**, which is what makes a
    replayed user bubble still show what was attached with nothing else stored.
  - `turn_ended` does *not* gain them (Retry is text; see Decisions).
- `session_queue` gains `attachment_ids TEXT` (a JSON array). A queued message with an image
  must survive a tab closing and a server restart like every other queued message, and the
  bytes are already on disk under a row — the queue only needs the pointer.
  `combineQueued` (`queue.ts:90`) joins the texts as it does now and **unions the id lists in
  row order**, deduped: a drain is one prompt, so it is one attachment set.
- `sessions.ts`: `prompt()` and `queueAdd()` take the ids, `claimAttachments(ids, sessionId)`
  runs before the turn starts (so a row exists to sweep against), and unknown or already-claimed-
  by-another-session ids are **dropped, not rejected** — a stale draft id must not fail a send
  whose text is fine. The dropped count is worth a `console.warn`; a silent drop with no trace
  is the failure mode this codebase's error convention exists to avoid.
- Client `lib/thread-socket.ts`: `prompt(text, opts)` and `queueAdd(text)` take
  `attachmentIds`; `actions.send` threads them through and stamps the optimistic
  `user-message` dispatch with the refs it already has locally, so the bubble draws its chips
  before the round trip.

---

## Phase 3.5 — Capability resolution

The phase the first draft of this plan did not have, and the reason it would have shipped a
feature that fails on a gateway. What can be sent is the **intersection** of three things —
the frame budget, the runtime, and the model — and none of the three knows about the other
two today.

### One pure function, two ends

It lives in `protocol.ts`, beside `AttachmentRef`, for the reason `QuotaSnapshot` lives
there: one declaration imported by both ends, so the chip's note and the bridge's branch
cannot drift into disagreeing about the same file.

```ts
export type Delivery = "image" | "audio" | "resource" | "link"

export interface DeliveryContext {
  caps: acp.PromptCapabilities | undefined   // the agent's, from `initialize`
  modalities: string[] | undefined           // the model's, from ModelDef
  hasCatalog: boolean                        // profile.models.length > 0
  inlineBudgetLeft: number                   // bytes still spendable in this prompt
  forceLink?: boolean
}

export function resolveDelivery(
  mimeType: string,
  size: number,
  ctx: DeliveryContext,
): { delivery: Delivery; reason: string }
```

Evaluated as vetoes, in this order, falling through to Phase 4's chain:

1. **`forceLink`** → `link`. The retry variant's whole implementation.
2. **Budget.** `size > inlineBudgetLeft` → `link`, "too large to inline". Not a 413; see the
   limits note in Phase 2.
3. **The agent.** `image/*` with falsy `caps.image` → not `image`. A negative here is
   authoritative: the runtime will drop or reject the block whatever the model could do.
4. **The model.** `hasCatalog && !(modalities ?? []).includes("image")` → not `image`. A
   catalog is a statement, including when it is silent; a profile with no catalog skips this
   rule entirely and defers to (3). Both halves of that are Decisions, above.

`reason` is a short human sentence, because it is what the chip prints (Phase 5) and what the
server logs when it degrades. A silent degrade with no trace is the failure mode
`lib/errors.ts` exists to prevent, and it is worse here than elsewhere: the user's evidence
for "the model read my screenshot" is that nothing went wrong.

### Getting the two halves to the two ends

**The model half needs no carrier at all.** `SessionMeta` already holds `profileId`,
`agentId` and `model` (`lib/settings.ts:422`), `state.profiles` already holds the catalog, and
`spawn_config`/`session_config` are both **absolute** and already fan out — so the composer
resolves it locally and the chip's note **re-renders the moment the model changes on a live
thread**, which is the point of the live-reconfiguration work rather than a new claim on it.
The server reads the same `ModelDef` through `getProfile`, which `spawnAgent` already calls
from a sync path.

**The agent half rides two carriers that already exist**, and neither costs a spawn:

- **Probe.** `AgentOptions` (`probe.ts:21`) gains `promptCapabilities`. `withAgentConnection`
  already hands `runProbe` the `initialize` response and `runProbe` currently ignores it, so
  this is a field off an object already in hand. It inherits the DB cache keyed
  `profileId:agentId:cwd:allowlistHash` and lands on the client in `lib/agent-options.ts`,
  already keyed `optionKey(profileId, agentId)`. That is what lets a **draft** composer —
  which has no process, by construction — resolve delivery before its first send, and it is
  the same reason the probe exists at all.
- **Live.** `session_config` gains `promptCapabilities?: acp.PromptCapabilities`. Optional,
  absolute, journaled: the exact rule `update.sessionId` was added under for subagents, so
  every event journaled before this replays with its shape unchanged. Emitted from the
  `session/new` and `session/load` responses, where `AcpBridge` already assigns
  `this.agentCapabilities` (`:367`).

### Where the decision is binding

**At send, inside the bridge — never at attach time.** The composer's note is a *forecast*;
`attachmentBlocks` is what decides. That distinction is load-bearing for the queue: a message
queued while an image-capable model was selected and drained twenty minutes later, after a
live model change, must be resolved against the model it is actually being sent to. The queue
carries ids, not blocks, which is what makes that possible.

---

## Phase 4 — Content blocks (the bridge)

`AcpBridge.prompt` is the one function that changes, and it is where the capability read at
`:367` finally has a use.

```ts
prompt: [
  { type: "text", text },
  ...attachmentBlocks(this.agentCapabilities.promptCapabilities, refs, this.cwd),
  ...mentionLinks(this.cwd, text),
]
```

`server/src/attachment-blocks.ts` decides per file by calling `resolveDelivery` (Phase 3.5),
threading `inlineBudgetLeft` down as it spends it, and the decision is a fallback chain, not
a switch:

1. `image/*`, no veto → `{type:"image", data: <base64>, mimeType}`.
2. `audio/*`, no veto → `{type:"audio", …}` (nothing produces one yet; the branch exists so
   the store does not have to grow a special case later).
3. `promptCapabilities.embeddedContext` and the file is text-ish → `{type:"resource", …}` with
   the text inline. **"Text-ish" is a real test, not a vibe**: a mime allowlist (`text/*`,
   `application/json`, `application/xml`, `+json`/`+xml` suffixes) *and* a NUL-byte sniff of
   the first 8 KB *and* a size cap. A browser will label a binary `text/plain` given half a
   chance, and inlining one is a corrupted turn — strictly worse than a missing attachment,
   which is at least legible as a missing attachment.
4. Otherwise → **materialise and link.** `application/pdf` always lands here, and it is worth
   saying so where somebody would otherwise "fix" it: the Anthropic API takes PDF documents,
   but **ACP has no `document` content block**, and a path is what an agent with a Read tool
   actually wants. The file is written to
   `<cwd>/.daedalus/attachments/<id>-<name>`, a `resource_link` names it, and the *path is
   appended to the prompt text* as `@.daedalus/attachments/…`. The path in the text is what
   makes this work at all: a runtime that ignores `resource_link` still reads the path, which
   is the entire finding `mentions.ts` was written around.

The materialised directory is swept by the same rule `materializeWorkspace` uses for skills
and commands — it takes back only what it wrote, tracked by a manifest beside it — and it is
`.daedalus/`, which the project's own gitignore may not cover; the sweep is therefore the only
thing keeping it from growing, and it runs per spawn in `SessionManager.start` where the other
materialisation already does. Growing is not the only hazard, though: this writes user files
into a directory that is very often a git worktree, so creating `.daedalus/` also writes a
`.gitignore` containing `*` into it — the standard one-line trick — because a screenshot
turning up in somebody's commit is a worse failure than a stale file, and it is the one the
sweep cannot prevent.

Base64 is read from disk at prompt time and never held between turns. A file over
`MAX_ATTACHMENT_BYTES` cannot reach here (Phase 2 rejected it), and the inline budget is spent
server-side from `MAX_INLINE_PROMPT_BYTES` rather than trusted from the client — which is a
degrade to a path (Phase 3.5, rule 2), not a rejection.

Whatever branch a file takes, it is also **named in the prose**: `[attached: shot.png]`, or
the `@.daedalus/attachments/…` path for branch 4. That is the `mentions.ts` bargain restated
for the same two reasons — the text is what every runtime reads without being taught anything,
and it is what keeps the transcript saying what the user actually sent.

---

## Phase 5 — Rendering

- `store.tsx`: `TextItem` gains `attachments?: AttachmentRef[]`; `pushUserMessage` (`:675`) and
  the `user-message` reducer case (`:920`) carry them; `onTurnStarted` (`actions.ts:455`)
  reads them off the event so a replayed turn is identical to a live one — the one code path
  rule, unchanged.
- **The composer chip carries its delivery.** One muted line under the name, from the same
  `resolveDelivery` the bridge calls — *"sent as a file path — this model can't read images"*
  — and it re-renders on a model change for free, because everything it reads is absolute
  state that already fans out. This is the whole of "degrade, and say so": the affordance
  never changes, but the outcome is stated, because the user's only other evidence that the
  model saw their screenshot is that nothing went wrong.
- **`user_message_chunk` stops discarding non-text blocks.** `store.tsx:433` bails on
  `content.type !== "text"` today, which is why a `session/load` replay of a prompt that
  carried an image currently shows the prose and silently loses the picture. An `image` block
  arriving there becomes an `AttachmentRef`-shaped item with an inline data URL instead of an
  id — the agent's copy, which the harness has no row for. Keep the existing drops (a
  subagent's chunks, task-notification blocks) exactly as they are.
  **This has a cost worth pricing before it is paid**, and it is the refs-not-bytes decision
  arriving from the other side: those updates are *journaled*, so loading a history with
  twenty images writes twenty base64 blobs into `session_events`. The convention says the
  server does not interpret a `session/update` payload — it forwards them whole — so the
  answer here is to keep forwarding and **cap the client**: an inline `image` over ~256 KB
  draws as a "large image (from history)" chip rather than a data URL held in the store. The
  journal cost is then bounded by the agent's own history rather than by anything the composer
  does, which is a different and much smaller problem. If that turns out to be unacceptable,
  the alternative is a narrow documented exception that rewrites inbound image blocks to
  `{mimeType, size}` before journaling — and it should be taken knowingly, as an exception,
  rather than discovered.
- `components/thread-items.tsx` `case "user"` (`:1188`): the chips render **above** the prose
  inside the same tinted `Bubble`. An image chip is a thumbnail (fetched through
  `readFileObjectUrl`'s pattern in `lib/workspace/fs-api.ts:187` — a bearer-header `fetch` to a
  blob URL, because `<img src>` cannot carry the header and a `?token=` in an `src` puts the
  credential in every referrer and cache key), everything else is a name/size row with a
  download. Clicking a thumbnail opens a lightbox; a 404 draws the "missing" state Phase 2's
  backup exclusion makes reachable.
- `composer-queue.tsx`: a queued item's chips show in both the collapsed summary (as a count)
  and the edit form, removable there, since `queue_update` carries the ids.
- `lib/sources.ts` and the palette's transcript text ignore attachments; they read prose.

---

## Phase 6 — Edges

- **Drag and drop.** A drop target over the whole composer (not just the textarea), with a
  `dragover` overlay. Dropped text with no files falls through to the Phase 1 threshold, so
  dragging a selection behaves like pasting one.
- **Clipboard images.** `onPaste` checks `clipboardData.files` *before* the text branch — a
  screenshot on the clipboard usually carries a text/plain fallback too, and reading text first
  would turn every screenshot paste into an empty chip.
- **Mobile.** The attach button is the touch path; `useIsMobile` governs the target size, per
  the two-questions rule (the chip row's *layout* stays `@panel-*`).
- **Upload progress and failure.** A chip is drawn optimistically the moment a file is chosen,
  in an uploading state, and a failed upload turns it into an error chip with a retry —
  through `reportError(err, "Couldn't attach the file")`, never `String(err)`.
- **Send is blocked while an upload is in flight**, and `send()` with no text but with
  attachments is allowed (an image with no sentence is a real prompt) — which means the
  `if (!value) return` guard in `Composer.send` (`thread-view.tsx:742`) has to learn about
  attachments, and it is the only place the empty-prompt rule lives.
- **A rejected image is recoverable in one click.** The failure Phase 3.5 exists to prevent is
  the one it *cannot* prevent: a model whose catalog entry claims `image` and whose provider
  refuses it anyway. When a turn ends in error and its journaled `turn_started.attachments`
  were delivered inline, the error row (`recordError`'s existing shape — title, reason, folded
  detail, retry) offers a second action beside "Retry (text only)": **"Retry as file paths"**,
  which re-sends with `forceLink: true`. The same row links to the profile's model entry,
  where `Input modalities` is already a hand-editable field
  (`settings/profile-models.tsx:396`) — so the one failure no configuration could have
  predicted teaches the catalog, once, and the next thread on that model never inlines again.
- **Tests.** `server/test/fake-agent.mjs` gains an `attachments:` prompt that echoes the block
  kinds it received, and a `pnpm test:attachments` drives upload → claim → prompt → block
  shape → sweep, plus the capability fallback with `promptCapabilities` empty. `resolveDelivery`
  is pure and gets a table test beside `test:workflow-schema` covering all four vetoes, the
  no-catalog carve-out, and the case that motivated the phase — `promptCapabilities: {}`
  against a catalog claiming `["text","image"]`, where the agent's no must still win.
  `expandPastes` and the fence computation are pure and are tested the same way.
- **Typecheck** with `pnpm exec tsc -b` (client) and `pnpm exec tsc --noEmit` (server); no
  visual testing, per the convention.

---

## Build order

Phase 1 ships on its own and is worth shipping on its own — it is the half people hit daily
and it costs no schema, no protocol and no journal shape. Phases 2–4 are one unit (a store
with no bridge sends nothing; a bridge with no store has nothing to send), **3.5 is inside
that unit and not after it** — a bridge that sends an image to a model that cannot read one
is the failure this plan was revised around, and it is not a polish pass — and 5 immediately
follows, because an attachment that is sent but not drawn makes the transcript lie about what
the user said. Phase 6 is the ordinary tail, with the one exception that the "Retry as file
paths" action is the tail of 3.5 rather than of the edges, and should land with it.

A note on line numbers: several in this document have drifted since it was written.
`Composer.send` is `thread-view.tsx:740`, `user_message_chunk` is `store.tsx:433`, and
`SUMMARY_ORDER` (which the chip row joins) is `composer-strip.tsx:60`. Prefer the symbol
names; they are what will still be true.
