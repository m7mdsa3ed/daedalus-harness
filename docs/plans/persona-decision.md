# Persona classification on a decision model, not a chat model

_Status: shipped. `persona-classify.ts` runs on the decision lane (`personaLane()` -> `sideTarget("decision")`);
the text below is the reasoning for moving it off a chat model, which it used to use._

## Why

Today `POST /api/sessions` asks a **chat model** which persona should answer a new thread's first
message (`server/src/persona-classify.ts`, called from `routes/sessions.ts` in front of
`sessions.create`).

That is the wrong instrument for the question. It is a classification with a closed label set — one
persona out of the library, or none — and a chat model answers it by generating prose, which costs a
generation, answers in a shape we then have to parse (`parsePersonaAnswer` strips backticks and
quotes off the first line and hopes), and drifts: the same message can come back with a different
label depending on how the model felt. `persona-classify.ts` already carries the scar tissue — a
`maxOutputTokens` of 512 because 32 came back empty once a reasoning model spent its budget thinking,
and a `2_500ms` abort because the generation is the latency.

A **decision model** (`kind: "decision"`) answers exactly this: a state and a map of typed questions,
returned as typed values with probabilities. One call, no generation, a score per label, and the
confidence is the vendor's number rather than our confidence in our own regex.

The pieces are already in the tree:

- `ModelDef.kind` / `ModelDef.wire`, `MODEL_KINDS`, `MODEL_WIRES` (`server/src/db/schema.ts:46,98`).
- `server/src/side-models.ts` — the decision lane, its stored `(profile, model)` in `app_settings`,
  its resolution, and `sideTarget("decision", {})`.
- `GET/PUT/DELETE /api/decision` (`routes/side-models.ts`) and Settings › AI › Decisions
  (`client/src/components/settings/ai.tsx`) with the client's `useSideModel("decision")`.
- The System One contract, written down in `docs/plans/model-kinds.md` and measured against a real
  endpoint in `docs/plans/personality-and-intent.md`.

What is **not** in the tree, and is this plan's work: `server/src/decide.ts` and its caller.
`docs/plans/model-kinds.md`'s "Built (this slice)" section claims it shipped; it did not — the only
adapter in the tree is `server/src/fim.ts`, for the completion lane.

## The call

One module, `server/src/decide.ts`, and one normalized answer. Nothing outside it spells a vendor's
path or payload — the same bargain `AgentDef.quotaProbe` and `fim.ts` already make.

```ts
export interface DecisionQuestion {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: string[] | Record<string, string>;
}
export interface DecisionAnswer {
  type: "noul" | "choice" | "score";
  probability?: number;                 // noul
  choice?: Record<string, number>;      // choice, per label
  score?: number;                       // score
  confidence?: number;
}
```

`POST {origin}/v1/systemone` for `wire: "systemone"`, `POST {origin}/v1/decisions` for
`systemone-gateway`. The path comes off the **column**, never off the host: `personality-and-intent.md`
measured this install's gateway serving `/v1/systemone` and 404ing `/v1/decisions`, so a gateway in
the URL is not evidence about which wire it speaks.

The response carries the model that actually answered, and that is what the call reports. An alias
(`jev-latest`) resolving to a new version is then visible rather than silent.

### The question the persona picker asks

```ts
{
  model: "oc/jev-1.13-free",
  state: "<project name>\n\n<the first message>",
  questions: {
    persona: {
      type: "choice",
      instructions: "Which of these personas should answer this message? Answer null-equivalent (the lowest scorer) when none clearly fits.",
      criteria: { "<persona id>": "<persona name> — <its description>" },
    },
  },
}
```

**The label set is the user's own library**, which is why this is cheap: a persona row is already
`{ id, name, description }`, and `criteria` is `{ label: "what it means" }`. Adding a persona teaches
the classifier with no taxonomy to maintain here.

Per the contract, **question names never reach the model** — `persona` is ours, and the `instructions`
and `criteria` do the work.

### The threshold, and why it is a column

An answer is a distribution, so "highest score wins" is not a decision. Two numbers, both on the
settings row rather than in code:

- **`minProbability`** — the chosen label must clear it (default `0.5`). Below it, no pick.
- **`margin`** — it must also beat the runner-up by this much (default `0.15`). A bare `0.42` against
  `0.40` is the model saying it does not know, in the only way it can.

Both are one reading of an answer, so they live beside the lane's choice in `app_settings` rather
than as constants nobody can tune. A pick below either is **no pick**, which already has a defined
meaning here: the thread opens on the persona the draft held.

## Where it still runs

**Unchanged: inside `POST /api/sessions`, before `sessions.create`.** That is deliberate and worth
restating because `personality-and-intent.md` argues for the opposite (classify on the draft, while
typing, and draw a suggestion rather than apply it).

The create route is right for this lane for a reason that does not apply to that one: a persona is a
**spawn input**, and at this moment no row and no agent process exist, so the pick costs nothing to
apply. Moving it onto the draft would buy a suggestion chip and cost a second endpoint, a debounce,
a client cache and a "did they accept it" state — for a decision the model is better at than the chat
model was, behind a call that no longer generates anything.

What changes is only the instrument and the gate:

1. `decideGate` (the renamed `classifyGate`) resolves the **decision lane** through
   `sideTarget("decision", {})` instead of reading `helperModels` for a `small` role.
2. No decision model configured ⇒ **no call at all**. Not a fallback to the chat model — see below.
3. `worthClassifying` stays exactly as it is: `!` lines, `/` commands, mention-only messages and
   anything under 12 characters never reach the wire.

The hand-pick guard is unchanged too: the pick only ever moves a persona nobody chose, which is where
the draft still equals the project default.

### `helperModels` is not the fallback

The obvious soft landing — "if no decision model is set, use the Small helper model as before" — is
the thing to **not** build. It would keep a chat generation in the path for every install that has not
picked a decision model, which is every install on the day this ships, and it would leave two code
paths where one contract is supposed to be. The Small helper model has its own job and it is not this.

So: **no decision model, no classification.** The lane's Settings row already says which model answers
it and shows the fallback the server picked, so the state is legible.

## What lands in the thread

Unchanged, and this is the part that already works: a pick is reported as the row a hand pick writes.

```ts
session.bridge!.noteConfigChange("Persona", name(draftPersona), name(persona));
```

Called after `bridge.ready` and before the first message, so it lands in an idle thread and emits
immediately as `config_notice`; `configNoticeText` draws `Persona: None → Code reviewer`. The client
folds it into a `notice` item flagged `config`, which `showConfigNotices` can hide. A match, or no
answer, writes no row.

Two additions this plan makes to that report:

- **`origin` stays absent.** The person did not change it — they sent a message and the harness read
  it — so the row must not claim otherwise. It is already outside `noteConfigChange`'s
  person-gated path and that is correct.
- **The decision's own numbers ride the row's tooltip**, not the row. `p=0.87, runner-up 0.06` is what
  explains a wrong pick, and it is what the Settings test box should also show when somebody is
  tuning a criteria line.

## Robustness, which is the whole of the failure story

The rule `personality-and-intent.md` states for this lane holds verbatim: **a classifier that cannot
answer is a thread with no pick, never a blocked send and never an error in the composer.**

- A row that is not a `decision` model, has no `systemone` wire, or names an empty state is an
  `HttpError` 400/409 on the way in — `fim.ts`'s split, and `setSideDefault` already refuses it.
- A provider that refused, timed out, or answered garbage is **silent**: the thread opens on the
  draft's persona. Only an unexpected throw is logged.
- The timeout stays keystroke-adjacent. A decision model answers in one shot, so `2_500ms` may come
  down, but only after measuring (see "What I could not verify"): — a first send should not be slower than a page load for a chip.

### A bug this plan fixes on the way

`callable()` (`server/src/side-models.ts`) accepts only `wire === "systemone"`, but the profile editor
offers `systemone-gateway` for a decision model (`client/src/components/settings/profile-models.tsx:805`).
Pick that wire and the lane silently never offers the model — no error, no candidate, an empty Settings
row. The lane's rule becomes "a wire that can be called", which is what `LANES.decision` should say:

```ts
decision: { kind: "decision", wire: ["systemone", "systemone-gateway"], key: "decision", noun: "decision" }
```

## What must not change

- **The spawn path never reads `kind`.** A decision model is never offered for a thread;
  `chatModels()` filtering already enforces it.
- **Helper models and roles stay chat-only** (`docs/model-roles.md`). A classifier cannot drive a turn,
  and a decision model is not a helper.
- **A decision call is never journaled.** It is not a turn and produces no `session/update`; the only
  trace in the transcript is the `config_notice` row, which is the persona change itself.
- **No new table.** The lane's choice and the thresholds are two `app_settings` keys, and the
  persona library is already the label set. `db:push` has nothing to add here.

## First slice, in order

1. **`server/src/decide.ts`** — the two wires, the normalized answer, the refusals. Ready, not routed.
2. **`server/src/persona-classify.ts`** — `decideGate` (lane resolution), `personaQuestion` (state +
   `criteria` from the library), `pickFromAnswer` (threshold + margin). `parsePersonaAnswer` goes away
   with the chat path.
3. **`server/src/routes/sessions.ts`** — call the lane instead of the helper model; keep the notice
   exactly where it is.
4. **Thresholds** — their own `app_settings` key (`personaDecision`), drawn on Settings › AI ›
   Decisions next to the model picker.
5. **The `callable()` fix** so `systemone-gateway` is reachable.
6. **Docs and rules** — `docs/plans/model-kinds.md`'s "Built (this slice)" corrected to say `decide.ts`
   is this work, not shipped; `docs/mcp-and-workflows.md`/`CLAUDE.md`'s persona sentence updated from
   "small helper model" to "the decision lane".

## Tests

- **`server/test/persona-classify.test.ts`** (exists) — keeps the prefilter and the gate cases; gains
  "no decision model ⇒ no call", "below `minProbability` ⇒ no pick", "below `margin` ⇒ no pick",
  "unknown label ⇒ no pick".
- **`server/test/persona-decide.test.ts`** (new) — a real local HTTP server, `fim.test.ts`'s shape:
  asserts the path for each wire, the bearer, the body (`state` and `questions.persona.criteria`), the
  refusal of a chat model, and that the model named in the response is the one reported.

## What I could not verify

- **A live answer.** The gateway at `localhost:20128` is up (it answers `401` without a key), but a
  decision call needs a profile's key and I did not pull one out of the database to test with.
  `personality-and-intent.md` recorded that `oc/jev-1.13-free` answered `429 Free usage limit reached`
  on this install. That is the argument for the failure story above, and it also means **the first
  real run is a 429**: the silent path is not an edge case on the free tier, it is the usual case.
  The test in `persona-decide.test.ts` must therefore cover a 429 body as "no pick, no log".
- **Whether `choice` criteria keys reach the model.** The contract says question *names* never do; it
  says nothing about criteria *keys*. Persona ids are opaque slugs, so if keys are shown, `criteria`
  text still has to carry the meaning. Worth one real call before committing to ids as keys; if keys do
  show, the fallback is positional (`p1`, `p2`, …) mapped back in `decide.ts`.
- **Latency on the first send.** The 1.2s figure above is a guess from one-shot classification, not a
  measurement. If the lane is slower than that, the call times out into "no pick" on every send and the
  feature looks broken while the logs stay quiet. Measure it on the real gateway before the timeout is
  tightened from 2.5s.

## Open questions

- **Is `margin` worth having, or is a threshold enough?** I recommend both, because one is "is it
  sure" and the other is "is it sure *of this one*", and a two-way tie is the pick that is most
  expensive to get wrong.
- **Should the confidence appear on the transcript row at all?** Recommend no — it belongs in the
  tooltip and the test box. A reader who did not know a model was involved should not be handed a
  probability; the row stays the ordinary persona change.
- **Does a decision lane get its own `FEATURES` entry?** Recommend no. `personaClassify` already
  exists and the client draws nothing new; what changed is which model answers, which the Settings row
  already states.
