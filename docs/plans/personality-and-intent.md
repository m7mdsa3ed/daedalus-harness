# Personality and prompt intent

_Status: nothing built. Two slices, in order — **1** gives personas their own module again, **2**
fills it from a classified prompt. Slice 2 is useless without 1: there is nothing today for a
classifier to pick from, and nothing it could pick that would change an answer._

## The two facts this design is built on

**A linked slash command never reaches the model.** Commands materialise into the project's cwd
and are advertised to the *client* as `available_commands_update`; the body is pasted in only
when somebody types `/name`, in `expandCommand` (`agent/src/turn.ts:82`). Linking `/debugger` to
a draft changes what the reader can type, not what the model reads. So "classify the prompt and
load the commands" — the original ask — buys a menu entry.

**The one lever that changes an answer is spawn instruction text**, folded in by
`withInstructionTrailers` (`server/src/personas.ts:409`) through the doors `AgentDef.personaVia`
already implements. That is where the persona, the rules, the task brief, the drawn-UI lane and
the suggestion blocks compose — one text, every runtime, no per-runtime code.

Which is why this plan restores personas rather than inventing an intent-to-instructions map. A
classified prompt should pick a **behaviour**, and a behaviour has somewhere to live.

## What was true, and what reverses

`legacy-prompts.ts` folded personas into `commands` at boot ("reusable text is a library slash
command"). The consequence was never revisitable: a command is **linked per thread and typed by
hand**, and its body arrives as the message. So a behaviour mode became something you have to
remember to type, once per thread, forever.

The evidence is still on this install. The nine `builtin:*` rows in the legacy `personas` table
migrated into nine identically-named commands, and their bodies are behaviour, not tasks:

| persona | description | kind |
|---|---|---|
| `think-more` | Deliberate. Explore the problem before touching anything. | always applies |
| `think-less` | Act immediately. No deliberation, no preamble. | always applies |
| `teach` | Explain as you go: the reasoning, the tradeoffs, the why. | always applies |
| `general-chat` | Talk it through. Read anything, change nothing unless asked. | always applies |
| `lazy` | Do exactly what was asked and stop. Ask before widening scope. | always applies |
| `review` | Read-only critique. Find the problems, cite them, propose nothing. | task masquerading |
| `quick-fix` | The smallest correct change. No refactors, no drive-by cleanups. | task masquerading |
| `plan-first` | Write the plan, wait for approval, then build it. | task masquerading |
| `app-builder` | Build the app in the preview: complete features, checked, committed. | task masquerading |

That is the boundary the split has to draw, and it is the whole design question. **Six are
behaviour and belong to a persona; three are a job and stay a command.** But the boundary is not
ours to draw for every row: `review` as a standing "this thread is a review" is exactly what
makes review threads good, and it is also a perfectly good one-shot `/review`. So the rule is
mechanical, not editorial:

- **An existing command is never converted.** Linking is durable and the user chose it; a
  migration that moved one would silently change every thread carrying it.
- **A persona is created from a row only when somebody asks.** The nine are seeded as personas
  (nothing links a persona, so this costs nothing), and `quick-fix`, `plan-first`, `review` and
  `app-builder` keep working as commands for anyone who wants the one-shot. A persona and a
  command sharing a name is not a collision — they are different nouns.

## Slice 1 — the personality module

### `personalities`, a row

```ts
export const personalities = pgTable("personalities", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),                       // "Think more"
  description: text("description").notNull().default(""),  // one line, drawn on the chip
  content: text("content").notNull(),                 // the behaviour, in markdown
  builtin: boolean("builtin").notNull().default(false),
  seededVersion: integer("seeded_version").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
```

No `thinking`/`effort`. The legacy persona carried them and nothing consumes them: there is no
thinking-budget key in any spawn template, and effort is already the **project's**
(`projects.default_effort`) — a persona that moved a thread's effort would be a second owner of
the same fact, which is the arrangement `docs/model-roles.md` spends a section avoiding. The
migration reads `prompt` and the rest is dropped, said out loud in `CHANGELOG.md`.

**`personas` and `saved_prompts` stay declared** after the copy. `db:push` is plain
`drizzle-kit push` and drops a table it does not know about; those rows are the only copy of the
nine seeded behaviour texts. They are retired when a release drops them on purpose.

### `sessions.personality_id`, and one on the project

`personality_id text` on `sessions` (null = none), and `default_personality_id` on `projects`
beside `default_model`/`default_effort`. One picker, two homes, exactly the shape effort already
has: **a draft opens with the project's, a picker on a started thread stages it for the next
spawn** — a persona is spawn text, so it costs a respawn, and nothing about it is live.

### The composition, in `server/src/personality.ts`

`personas.ts` is already a misnomer carrying three unrelated things. Split it:

- **`personality.ts`** — the CRUD, the seed, and `resolvePersonality`: personality **then** rules,
  as one base block. Personality first because identity is the outermost layer; rules are the
  layer above them and already say so.
- **`instructions.ts`** — `ThreadBehaviour`, `withInstructionTrailers`, the suggestion registry,
  `UI_GROUP_IDS`, `taskInstructions`, `writePersonaPrompt`. None of this is a persona; it is what
  a thread is told beyond its persona, and its name should stop lying.
- **`personas.ts`** — deleted. Nine call sites (`sessions.ts`, `projects.ts`, `acp-bridge.ts`,
  `registry.ts`, `backup.ts`, `routes/sessions.ts`, three tests) move their imports and nothing
  else. `PersonaSpawn` becomes `Instructions`; `personaVia`, `personaPrompt`/`personaFile` and
  `DAEDALUS_AGENT_*` keys **keep their names**, because a runtime's config template is the user's
  and a seed is not allowed to rewrite one.

### The surface

- **A chip on the scope row** (`DraftScopeRow`, beside the project), drawn with the entity-icon
  rule — a persona is a face like a project or an agent. Empty reads nothing at all; a set one
  reads its name.
- **`Settings › Personalities`** — a `Group`/`Row` list with one editor, in `primitives.tsx`'s
  shape. Built-ins are editable (they are text, and the user's copy wins) and restorable.
- **`withInstructionTrailers`' order stays as it is**: personality+rules, then drawn UI, then the
  suggestion blocks, suggestions last so the client's fence is still the end of the text.

### What this deliberately does not do

- **Not a second `rules`.** Rules stay project-scoped and additive; a personality is one choice
  per thread and subtractive of nothing. If a personality and a rule disagree, the text is in the
  order above and the model sees both — the same as two rules disagreeing today.
- **No picker on the new-tab console's full box** until a project names a default, or the front
  door grows a control for a thing that is usually inherited.
- **No transcript row.** A spawn-time setting said at spawn time is noise on the first turn; the
  config-notice door (`noteConfigChange`) already covers the started-thread case, and a persona
  change is exactly one of those.

## Slice 2 — the classifier fills it

The lane's **storage already exists**: `side-models.ts` has `LANES.decision`,
`GET/PUT/DELETE /api/decision`, and the Settings row that picks one. What does not exist is
anything that calls a decision model — no `decide.ts`, no run door, no consumer.
(`docs/plans/model-kinds.md`'s "Built (this slice)" claims `decide.ts`, `decisions.ts`,
`routes/decisions.ts` and `test:decisions` shipped; none are in the tree. Correct that section to
the columns and the editor, which is what the prose above it already says.)

### The adapter, first

`server/src/decide.ts`, one normalized answer, System One only outside this file:

```
POST {origin}/v1/systemone          # baseUrl .../v1 -> .../v1/systemone
{ "model": "oc/jev-1.13-free", "state": "<the prompt>",
  "questions": { "personality": { "type": "choice", "instructions": "...",
                                  "criteria": { "<id>": "<name + description>" } } } }
```

Measured on this install: `http://localhost:20128/v1/systemone` accepts `oc/jev-1.13-free`, and
`/v1/decisions` 404s — the path is the `wire` column, never a guess from the host. **Today that
model answers `429 Free usage limit reached`**, which is the argument for the next paragraph.

**A classifier that cannot answer is a thread with no personality**, never a blocked send and
never an error in the composer. Every refusal is `HttpError` 400/409 in `fim.ts`'s split — not a
decision model, no `systemone` wire, empty state — and every runtime failure is swallowed by the
caller.

**Bug to fix in this step:** `callable()` (`server/src/side-models.ts:59`) accepts only
`wire: "systemone"`, but the profile editor offers `systemone-gateway` for decision models too
(`profile-models.tsx:802`). Pick it and the lane silently never offers that model.

### The label set is the library

This is why the design is cheap. `criteria` is `{ label: "what it means" }`, and a personality row
*is* that shape — so **the vocabulary is the user's own rows**, adding a personality teaches the
classifier, and no taxonomy is invented here. `k` results above a threshold; an answer naming an
unknown id is dropped, never guessed.

### Where it runs

**On the draft, while the message is being typed** — the shape `fim-completion.ts` already has
for the completion lane: ask after a pause, ~700 ms, minimum length, cached by
`sha1(text + candidate ids)` in the client query cache.

Not inside `POST /api/sessions`. The first message rides the create and the route spawns before it
prompts, so classification there sits in front of a process spawn on the critical path — and its
pick would need a respawn to take effect, since `personality_id` is spawn input. That is a bad
trade for a chip.

**A suggested personality is drawn, not applied.** It arrives on the draft's chip as a guess
(muted, one click to accept, one to dismiss), and Send uses it only once accepted. Silently
switching how a thread behaves, on a model's reading of a sentence the user is still writing, is
the one thing here that would be hard to notice and hard to undo — and this repo's own rule for a
pick is that it is drawn before it lands (`ThreadState.pendingConfig` exists for exactly that
reason).

Guards: an install-wide opt-out in `app_settings` beside the lane's own row; never guess over a
person's pick (project default included); a null result is a draft with no chip.

### The door

`POST /api/intent` — `{ text }` in, `{ personality: { id, p } | null, model }` out. It resolves
the lane through `sideTarget("decision", {})`, so which model answers is never a name in the
client. It writes no row: a decision call is never journaled, and a verdict worth keeping would be
its own table.

## Order of work

1. **`personalities` table + `sessions.personality_id` + `projects.default_personality_id`**
   (`schema.ts`, `pnpm db:push`), the CRUD and seed in `personality.ts`, the boot migration that
   copies the nine legacy rows **without touching any command**, `personas`/`saved_prompts` left
   declared. `pnpm test:personality` — the migration is idempotent, a command is never converted,
   a renamed seed row is not overwritten.
2. **The module split** (`personality.ts` / `instructions.ts`, `personas.ts` deleted), nine import
   moves, no behaviour change. This is the step that must be provably mechanical: the spawn text
   for a thread with no personality must be byte-identical before and after.
3. **The chip + the draft plumbing** (`thread-defaults`, `configureDraft`, the create body,
   `resolveSpawn`), and `Settings › Personalities`.
4. **`decide.ts` + the `callable()` wire fix**, with `pnpm test:decide` against a local server:
   path, bearer, body, the gateway variant, the three refusals.
5. **`POST /api/intent`**, then the chip's guess on the draft, behind the opt-out.
6. **Only if 5 earns it:** a name on the thread (`sessions.intent`, a column) for a later feature
   to read — not a row in the transcript.

Steps 1–3 are useful with no classifier at all: they are the module the user asked for, and a chip
that switches how a thread works. Steps 4–5 are the classifier, and they degrade to nothing when
the model is down, which on this install it currently is.

## Open questions

- **Is `review`/`plan-first` a personality or a task?** The plan seeds them as personalities and
  leaves the commands alone, so both work. If that reads as duplicated text in the library, the
  fix is a command that *references* a personality (`content: "{{personality:review}}"`) rather
  than two copies — a bigger change, and not one to make before somebody has used both.
- **Should a personality be able to name an effort** the way the legacy rows did? Recommended no,
  for the project-owns-effort reason above; it is a one-column change later if it is wanted.
- **Does the guess re-run when the reader edits into a different intent?** Recommended: re-rank
  the chip, but never replace a guess the reader already accepted.
- **What does the classifier see of the thread?** The draft text only, for v1. A resumed thread's
  last turn is a candidate later, but it makes the call's cost vary with the transcript.
