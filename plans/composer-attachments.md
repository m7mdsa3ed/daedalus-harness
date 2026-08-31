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
  — read but currently unused at `acp-bridge.ts:367`).

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
- **Capability decides the block, never the feature.** An agent advertising
  `promptCapabilities.image` gets a real `image` block. One that does not gets the file
  materialised into the cwd and a `resource_link` plus its path in the text — the mentions
  bargain again, because a path in prose is the one thing every runtime reads. The composer
  looks the same either way; degrading to "you cannot attach that here" would make the
  affordance depend on which profile a thread happens to be on.
- **Attachments do not survive Retry or prompt history.** Both are string paths by
  construction (`turn_ended.text`, `items[].text`), and quietly re-attaching bytes to a
  re-sent string is a second send the user did not compose. Retry re-sends the text; the row
  says so.
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
`MAX_PROMPT_ATTACHMENT_BYTES = 20 MB` per prompt, `MAX_ATTACHMENTS = 10` per prompt. The
per-prompt cap is the one that matters and it is not about disk: an ACP prompt is a single
JSON-RPC frame written to the child's stdin, base64 is 4/3, and a 60 MB line is a stall in a
place with no backpressure story. 413 on oversize, matching `workspace-fs.ts:507`.

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
  - `{cmd:"prompt", text, attachmentIds?: string[]}`; same on `queue_add` and `queue_update`.
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

`server/src/attachment-blocks.ts` decides per file, and the decision is a fallback chain, not
a switch:

1. `image/*` and `promptCapabilities.image` → `{type:"image", data: <base64>, mimeType}`.
2. `audio/*` and `promptCapabilities.audio` → `{type:"audio", …}` (nothing produces one yet;
   the branch exists so the store does not have to grow a special case later).
3. `promptCapabilities.embeddedContext` and the file is text-ish → `{type:"resource", …}` with
   the text inline.
4. Otherwise → **materialise and link.** The file is written to
   `<cwd>/.daedalus/attachments/<id>-<name>`, a `resource_link` names it, and the *path is
   appended to the prompt text* as `@.daedalus/attachments/…`. The path in the text is what
   makes this work at all: a runtime that ignores `resource_link` still reads the path, which
   is the entire finding `mentions.ts` was written around.

The materialised directory is swept by the same rule `materializeWorkspace` uses for skills
and commands — it takes back only what it wrote, tracked by a manifest beside it — and it is
`.daedalus/`, which the project's own gitignore may not cover; the sweep is therefore the only
thing keeping it from growing, and it runs per spawn in `SessionManager.start` where the other
materialisation already does.

Base64 is read from disk at prompt time and never held between turns. A file over
`MAX_ATTACHMENT_BYTES` cannot reach here (Phase 2 rejected it), and the per-prompt cap is
re-checked server-side rather than trusted from the client.

---

## Phase 5 — Rendering

- `store.tsx`: `TextItem` gains `attachments?: AttachmentRef[]`; `pushUserMessage` (`:675`) and
  the `user-message` reducer case (`:920`) carry them; `onTurnStarted` (`actions.ts:455`)
  reads them off the event so a replayed turn is identical to a live one — the one code path
  rule, unchanged.
- **`user_message_chunk` stops discarding non-text blocks.** `store.tsx:417` bails on
  `content.type !== "text"` today, which is why a `session/load` replay of a prompt that
  carried an image currently shows the prose and silently loses the picture. An `image` block
  arriving there becomes an `AttachmentRef`-shaped item with an inline data URL instead of an
  id — the agent's copy, which the harness has no row for. Keep the existing drops (a
  subagent's chunks, task-notification blocks) exactly as they are.
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
  `if (!value) return` guard at `thread-view.tsx:653` has to learn about attachments, and it is
  the only place the empty-prompt rule lives.
- **Tests.** `server/test/fake-agent.mjs` gains an `attachments:` prompt that echoes the block
  kinds it received, and a `pnpm test:attachments` drives upload → claim → prompt → block
  shape → sweep, plus the capability fallback with `promptCapabilities` empty. `expandPastes`
  and the fence computation are pure and get a unit test beside `test:workflow-schema`.
- **Typecheck** with `pnpm exec tsc -b` (client) and `pnpm exec tsc --noEmit` (server); no
  visual testing, per the convention.

---

## Build order

Phase 1 ships on its own and is worth shipping on its own — it is the half people hit daily
and it costs no schema, no protocol and no journal shape. Phases 2–4 are one unit (a store
with no bridge sends nothing; a bridge with no store has nothing to send) and 5 immediately
follows, because an attachment that is sent but not drawn makes the transcript lie about what
the user said. Phase 6 is the ordinary tail.
