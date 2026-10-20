# FIM in the composer: ghost text at the caret

## Context — what already ships

- `ModelDef.kind` / `ModelDef.wire` and the profile editor that saves them are in the tree
  (`docs/plans/model-kinds.md`, "What ships now"). A `completion` model can be added to a profile,
  keeps its wire across a save, and is filtered out of every thread-facing picker (`chatModels`,
  `servesChat`).
- Nothing calls one. There is no adapter, no route, no surface: this plan is the first consumer.
- The composer is a Tiptap view of a plain string (`components/composer/composer-editor.tsx`).
  `text` stays the exact message sent; `editor-text.ts` already maps caret offset to document
  position (`posToOffset`, `offsetToPos`) and back, which is the whole difficulty of putting a
  suggestion at a caret inside chips.
- A **decoration** is already the house mechanism: the placeholder is one, and the editor
  dispatches a no-op transaction to redraw it when the string changes
  (`composer-editor.tsx`, "The placeholder is a decoration; a new one needs a transaction to
  redraw"). Ghost text is the same machinery with different content.
- Keys are taken in the **capture** phase and ProseMirror honours a `preventDefault`
  (`handleDOMEvents.keydown`). `composerKeyDown` (`components/composer/keys.ts`) is a plain chain of
  `KeyConsumer`s — menu first, then history, then Enter — and a consumer is free to decline.
- The harness's own non-chat calls have a settled shape (`server/src/ai.ts`): a timeout,
  `HttpError` with 409 for configuration and 502 for the provider, "came back empty" as an error.
- The harness's other side-call picks (enhance, git, the form builder) are **device-local**
  (`lib/ai-picks.ts` → `ui.<name>Profile` / `ui.<name>Model`): a habit of the hand, not a property of
  a thread. FIM is the exception and the reason is in its own data — a completion model is a row
  inside a profile, so the pick is a fact about this install's catalogue, not about this browser.
- `app_settings` is already the home for exactly that shape of fact: one row per key, user-authored,
  and it travels in a backup bundle (`backup.ts`, the `settings` record). It needs no schema push.
- `!` lines already have a **candidate menu** — project helpers, the project's `package.json`
  scripts, and what it keeps running. FIM is not that and must not compete with it: the menu is a
  lookup over known commands, FIM predicts the rest of what is being typed.

## The wire

`wire: "openai-completions"`, the legacy completions shape every FIM host speaks:

```
POST {baseUrl}/completions
{ "model": "...", "prompt": "<before the gap>", "suffix": "<after the gap>",
  "max_tokens": 64, "stop": ["\n"], "temperature": 0.2 }
→ { "choices": [{ "text": "<the gap>" }] }
```

`baseUrl` is the profile's, so `https://api.deepseek.com/beta` posts to
`…/beta/completions`; a `/v1` base posts to `…/v1/completions`. One path shape, no per-vendor
branch: a host that wants another (Mistral's `/v1/fim/completions`) is a second **wire** value,
which is what the column is for.

**The answer's envelope is not the request's.** Both hosts take that body and answer differently:
DeepSeek in the completions one (`choices[0].text`), Mistral's `/v1/fim/completions` in the chat one
(`choices[0].message.content`). The reader accepts either — it is the same fact spelled two ways, not
a second protocol — and a choice with neither is a 502 rather than an empty suggestion. Reading only
`text` made every Mistral completion `""`: a ghost that never drew, with nothing anywhere saying why.

## Design decisions

1. **Two callers, one adapter.** `server/src/fim.ts` owns the path, the body and the parse; the
   route and (later, if wanted) an MCP tool are thin. Nothing outside it spells `/completions`.
2. **No agent, no turn, no journal.** A completion is keystroke-scale: not a `session/update`, not
   a queued prompt, no permission. The route therefore must **not** require an agent for the profile
   — a FIM-only profile has no model any runtime could spawn on, and that is a valid profile.
3. **Configuration answers, not failures.** A chat model, a model with no wire, an empty prompt and
   a profile with no endpoint are 400/409 with a sentence; only the provider's own failure is 502.
4. **The default is the install's, not the device's** — one default FIM profile and model, chosen in
   Settings › AI, stored in `app_settings` under one key (`fim`, a JSON `{profileId, model}`), and
   read by every device and by the route itself. Two devices that disagree about which model finishes
   a command would be two different products. Storage is a key in a table that already exists, so
   there is no schema push and a backup carries the choice.
5. **The route resolves the default; the caller does not send it.** `POST /api/fim` with no
   `profileId`/`model` uses the stored default — so the composer's request carries only the text, and
   a keystroke cannot name a profile it should not. The Settings row's test box *may* name a
   candidate explicitly, which is how you prove one before saving it.
6. **The ghost is a widget decoration, never a patch of `text`.** `text` remains byte-exact, which is
   the composer's whole contract; the suggestion is drawn from editor state and disappears without
   ever having been in the string.
7. **Accepting is an ordinary programmatic edit.** Tab inserts through `setText` +
   `mentions.requestCaret`, the same path a quote or a paste takes, so chips reparse and the caret
   lands after the inserted gap.
8. **`!` lines first, prose second.** A `!` command is prefix-only — the exact shape FIM is for, one
   line, cheap to cap. Prose at a caret in the middle is prompt+suffix, which FIM also speaks, but it
   needs a bigger slice policy and costs a request per pause, so it lands behind its own toggle.
9. **On demand beats as-you-type for prose; as-you-type is right for `!`.** A `!` line is a whole
   command with a clear end (Tab or Enter), so a debounced request is predictable there. In prose the
   reader is thinking, not stalled, and a request per pause is a bill for silence.

## Files

| File | Change |
| --- | --- |
| `server/src/fim.ts` | new: `fillMiddle(profile, {model, prompt, suffix, maxTokens})` → `{text, model}`; the refusals; timeout |
| `server/src/side-models.ts` | new: the lane machinery — `sideDefault` / `setSideDefault` / `sideCandidates` / `sideTarget`, one implementation for both lanes |
| `server/src/routes/fim.ts` | new: `POST /api/fim` — the call. The lane's choice doors are `routes/side-models.ts`: `GET/PUT/DELETE` on `/api/fim` and `/api/decision` |
| `server/src/index.ts` | mount `fimRoutes(app)` |
| `server/test/fim.test.ts` | new: a real local HTTP server asserting path, bearer, body, the four refusals, and the default's resolution |
| `server/package.json` | `test:fim` script, added to the `test` chain |
| `client/src/lib/queries/side-models.ts` | new: `useSideModel(lane)` + `useSetSideModel(lane)`, invalidating the lane's key — shared with the decision lane |
| `client/src/components/settings/ai.tsx` | a "Composer" row: one profile pick and one model pick over `kind === "completion"`, saved to the server |
| `client/src/components/composer/fim-completion.ts` | new: `useFimCompletion` — debounce, abort, slice policy, the KeyConsumer |
| `client/src/components/composer/composer-editor.tsx` | `ghost?: {at, text}` prop + a `GhostText` extension drawing it |
| `client/src/components/composer/keys.ts` | a `completion` consumer in the chain, after the `!` menu |
| `client/src/components/composer/composer.tsx` | mount the hook, pass `ghost` and the consumer |
| `client/package.json` | `@tiptap/pm@3.31.3` as a direct dependency (it is a peer only today; `Plugin`/`Decoration` import from it) |
| `AGENT.md`, `docs/client.md` | one rule each, once it works |

## Order of work

**1. The wire and the default, server-side only** *(landed)* — `fim.ts` + `routes/fim.ts` + `test/fim.test.ts`
+ the script. The test is the deliverable, and it has two halves. The *call*: a local HTTP server
asserts the path (`/completions` under a `/beta` base), the bearer header, `prompt`/`suffix` (and no
`suffix` key when there is none), and the four configuration answers. The *default*: unset resolves
to the first visible profile holding a completable model; `PUT` stores `{profileId, model}` in
`app_settings`; a chat model, a virtual profile and a model with no wire are refused on the way in;
and a stored profile that was since deleted or emptied resolves as a fallback rather than an error.
Verify `pnpm test:fim`. Nothing in the client yet, so nothing can regress.

**2. The settings row** *(landed — both lanes, in Settings › AI)* — `lib/queries/side-models.ts` and the two rows in Settings › AI ("Composer" and "Decisions"): one profile
pick and one model pick over `kind === "completion"` (with `modelsOfKind`), a Test button that posts
to `/api/fim` with the candidate named explicitly, and a Save that puts it. It reads back what the
server resolved, so an unset install shows the fallback as the thing that runs rather than an empty
row. This is the first row on that page whose value belongs to the install rather than the device —
every other row there is an `AiPick` in local storage, so this one reads and writes through
`/api/fim`, invalidates its key on save, and mirrors nothing. The profile editor's Test button
dispatches on kind too (a completion row posts here; a decision row is offered no chat test at
all), so a row can be proven from either end — this row is the one that proves the *default*.
Verify `tsc -b`, then set it, reload, and confirm the same pair is drawn on another device.

**3. The ghost** *(landed, and it covers prose too: the composer's prompt autocomplete was the ask)* — the `composerGhost` extension beside `PasteToken`/`Mention` (`ComposerGhost` on the editor's props),
`useFimCompletion` with a 400ms debounce and an `AbortController`, Tab to accept, Escape to drop.
Fires only when: the server resolved a default, the caret is collapsed, not composing (IME), the
composer is enabled, and the line up to the caret holds a **space** — `!/name args`, which is
exactly where the `!` menu is closed, by the same regex that opens it (`^(\S*)$` in
`project-commands.tsx`). No new state has to be exposed for that: the two conditions are each
other's complement. Prompt is the line after `!` up to the caret, `stop: ["\n"]`, first line only.
Verify by hand in the dev client and `tsc -b`.

**4. Prose at the caret** *(landed in step 3)* — the same hook, a second slice policy: prompt is up to 2000 characters
before the caret, suffix up to 500 after, newlines allowed, behind an explicit switch on the same
settings row (off means `!` only).

**5. The rules** — `AGENT.md`'s composer paragraph gains one line ("a completion model may draw a
ghost at the caret; Tab takes it, Escape drops it, and it is never part of `text`"),
`docs/client.md` the same, and `docs/plans/model-kinds.md`'s "Still open" loses its FIM clause.

## What could go wrong

- **A stale reply at a caret that moved.** Every request carries a sequence number and the caret
  offset it was asked at; a reply is dropped unless the sequence is current *and* the document still
  holds that offset. Aborting on the next keystroke is not enough on its own — an abort can lose the
  race with a response already in flight.
- **Chips.** `posToOffset`/`offsetToPos` already account for a paste chip being many characters and
  one node; the ghost must be positioned from the *offset*, never from a remembered doc position.
- **A default that went stale.** The profile can be deleted, disabled, or lose its completion model
  between the pick and the keystroke. Resolution therefore happens **on read, every time**
  (`fimDefault()`), never from a cached id: a stored default that no longer resolves falls back, and
  a fallback that does not exist answers "no default" — the composer then draws no ghost and the
  settings row says why. A keystroke must never spend a 500 on a deleted row.
- **Tab doing two things.** The `!` menu's own Tab accepts its row. The two never overlap — the
  menu owns a lone `!token`, the ghost owns a line with a space in it — and `keys.ts` still states
  the menu first so the ordering is explicit rather than incidental.
- **Escape.** It already means "stop the turn" and "close the menus"; the completion consumer returns
  `true` only while a ghost is drawn, so nothing else changes when there is none.
- **Cost.** A debounce, a `max_tokens` cap (64 for `!`, 128 for prose), and a request refused outright
  when the typed slice is whitespace or shorter than two characters.
- **A provider that answers with prose.** The `!` slice keeps the first line only and trims trailing
  whitespace; anything containing a newline in prose mode is kept, because that is a real gap.

## Open questions

- Should the ghost also fire on a `!` line whose menu is open but has no match (a menu that offered
  nothing is the one case where both would help)? Recommend no for the first cut — one surface at a
  time.
- Should a suggestion that was *dismissed* with Escape be remembered for that line so it does not
  immediately return on the next pause? Recommend yes, keyed by the line's text.
- Is the prompt better for a `!` line with the leading `!` kept? Recommend stripped: it is composer
  syntax, not shell syntax, and a model asked for a shell command should not be told about the
  harness's marker.
- Should the default be per-project rather than per-install? Recommend no: a project carries what a
  *thread* opens with, and a completion model is not a thread's. One default, one row, one key.
