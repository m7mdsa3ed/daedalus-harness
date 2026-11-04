# Project routing: a suggest-only chip on the New tab

_Status: proposal. Nothing here is built. It reuses the decision lane that persona classification already
runs on (`docs/plans/persona-decision.md`); read that first._

## Why

The New tab (`landing/landing-page.tsx`) opens on a *remembered* project, and the reader types into a
composer whose scope row says where the thread will run. With several projects, the likeliest mistake is
the quietest one: a message about the billing service is typed with the docs site selected, sent, and the
agent works in the wrong cwd. The reader sees it a few tool calls later.

The question is a closed-label classification: which of these projects does this message belong to, or
none. That is what the decision model answers (`decide.ts`, one `choice` question, a probability per
label, no generation).

## The rule that shapes everything

**A wrong persona costs a tone; a wrong project costs edits in the wrong repo.** Persona classification
may *apply* its pick because it is cheap to undo (an ordinary config notice). A project pick must not.
So this feature **only ever suggests**: it draws a chip, and the project changes only when the reader
presses it. There is no auto-apply switch in this plan (see Open questions).

## Where it runs

- **The New tab composer and the palette's ask row**, before the first message is sent. Never in an
  existing thread, never on a follow-up: a thread has a project already, and "this belongs elsewhere"
  is a different feature (an Aside or a new thread).
- **Asked on a pause, not on send.** The point is to catch the mistake *before* the send, so the call is
  made when typing stops (debounce ~700ms) and the text is worth asking about. A send never waits on it.
  This is the difference from persona classification, which runs inside `POST /api/sessions`.
- **One new route**, `POST /api/route/project` `{ text, currentProjectId }` -> `{ suggestion: {projectId,
  probability} | null, reason?: string }`. The browser never calls the decision gateway: the server owns
  the profile's key and `sideTarget("decision", {})` (`side-models.ts`).

## The call

A module beside `persona-classify.ts`, `server/src/project-route.ts`, deliberately the same shape.

```ts
{
  state: "<the message, capped at 2000 chars>",
  questions: {
    project: {
      type: "choice",
      instructions: "Which project does this message belong to? Pick none when it is general or none clearly fits.",
      criteria: { none: "General, or no project clearly fits", "<project id>": "<name> - <criteria text>" },
    },
  },
}
```

`none` is a label for the same reason persona has one: a `choice` answer sums to one, so with a single
candidate every message would score 1.0.

### Where the criteria text comes from

A project row is a name and a cwd, which is not enough for a model to choose on. In order of preference:

1. **`projects.description`** (already a column, free text, null on old rows). The reader's own words are
   the best label and cost nothing to keep.
2. **Derived, when the description is empty:** the folder's basename, the first ~300 chars of its
   `README.md` / `AGENT.md`, and its last three thread titles. Read at request time through the existing
   `fs` helpers; a cwd that cannot be read is a project described by its name alone.
3. **The name.** A project with nothing else still competes, and loses honestly.

Derived text is cached per project for the process (keyed on the README's mtime) so the route does not
touch the disk on every pause. Nothing derived is stored: it would go stale, and the description column
is the one durable place a person can correct it.

### Reading the answer

Reuse `judgeChoice` rather than copy it: generalise its `personas: PersonaChoice[]` parameter to a
labelled list (`{id, name}`) and its reason strings to take a noun ("persona" / "project"). Same
`minProbability` and `margin`, **but its own thresholds key** (`projectDecision`, read as defensively as
`readPersonaDecision`), because the persona numbers are tuned for a cheap mistake. Defaults here are
stricter: `minProbability: 0.65`, `margin: 0.25`.

Two extra conditions that persona does not have:

- **The top label must differ from the current project.** Agreeing with the reader is not a suggestion.
- **The current project's own score is not a veto,** but a close second (inside the margin) is "no pick":
  the reader chose it, and a near tie is not evidence they were wrong.

## The chip

Drawn in the composer's scope row, beside the project picker, only while a suggestion stands:

> Looks like **billing-api** - Switch

- **One action, no dialog.** Pressing it re-points the draft; the chip clears. Dismissing (x) is
  remembered for that draft, so typing more does not re-raise it.
- **No percentage on the face.** The probability goes in the tooltip, same call as persona's open
  question: a reader who did not know a model was involved should not be handed a number.
- **It never takes focus or moves the caret,** and it appears without shifting the composer
  (`--harness-composer-width` rule: the composer does not move).
- **Gone when the reader moves the project by hand,** or when the text no longer supports it (a later
  answer of `null` clears it).

### Switching must keep the words

`landing-page.tsx` re-mints the draft whenever `projectId` changes (a new session id, an empty composer,
by design: "arriving from another project's + is a deliberate re-aim"). Pressing the chip is not a
re-aim, so the switch must carry the composer text and attachments to the new draft. This is the one
real client change, and the place to be careful:

- Add a `moveDraft(sessionId, projectId)` to `actions` that re-points the **existing** draft row
  (`newDraftThread` already takes a `project`; this reuses its start-defaults resolution via
  `resolveThreadStart`) instead of going through the landing page's `projectId` memo.
- The remembered-project default is **not** written by a suggestion pick (`saveThreadDefaults`): a
  one-off routing is not a statement about where the next thread starts. A manual pick still writes it.

If `moveDraft` proves hard to make atomic, the fallback is to read `drafts.ts` for the old id and write
it under the new one in the same tick as the re-mint. Either way, test that text typed before the press
is in the composer after it.

## Gates (a `GateSkip` per case, as persona has)

Silent skips, because they are the reader's own doing:

- The reader picked a project by hand on this draft.
- The feature is off (`config.routeProject === false`, or the reader's own switch).
- Fewer than two projects exist.

Skips that are said (a tooltip on the empty chip slot, never a toast):

- No decision model is chosen ("no decision model - Settings > AI").
- The text is unworthy (`unworthyReason`: shell line, slash command, only mentions, too short).
- The model failed, timed out or was refused. The free tier answers 429 as the usual case
  (`persona-decision.md`), so this path is the normal one on such an install and must be quiet in logs.

Never a fallback to a chat model, for the same reason as persona.

## Agent routing is a different, later question

Routing to a raw (profile, agent) pair is not part of this plan. A pair can have broken credentials or an
agent that is not installed (`agent-status.ts` measures that, and the decision model cannot see it).
If it is added, it routes to a **persona or model role** (`small`, `reasoning`), which the harness already
resolves per spawn, or to pairs the reader marked routable *and* that measure as runnable. Out of scope
here so the chip stays one decision.

## Failure story

Every path answers `suggestion: null` with a reason and costs nothing: timeout (2.5s, same as persona),
429, garbage, unknown label, `none`, below threshold, too close, same as current. The composer behaves
exactly as it does today. The route never throws a 5xx for a model fault.

## What to build, in order

1. Generalise `judgeChoice` to labelled lists; keep `persona-classify.test` green.
2. `project-route.ts`: criteria builder (description, derived text, cache), `routeProject()`, thresholds
   key and `setProjectDecision`.
3. `POST /api/route/project` and a `FEATURES` entry (`projectRouting`) so an older server draws no chip.
4. `actions.moveDraft`, then the chip in the scope row, debounce, dismissal and clearing.
5. Settings: a switch under AI > Decisions, and a project description field that says what it is for.
6. Tests: `judgeChoice` for projects (none, unknown, below threshold, tie, same-as-current); criteria
   builder with an empty description; the route on a 429 body (no pick, no log); client test that text
   survives the switch.

## What this plan cannot verify

- **Whether a decision model separates projects on a name and a README.** Persona descriptions are
  written to be distinguishing; project text often is not. Measure on a real install with 5+ projects
  before tuning the 0.65 / 0.25 defaults.
- **Latency of a debounced call.** Persona's 2.5s figure is unmeasured as well. Because this call is off
  the send path, a slow answer costs a late chip, not a late send, but a chip arriving after the reader
  has already sent is useless: drop an answer whose text no longer matches the composer.
- **Whether criteria *keys* reach the model** (open in `persona-decision.md`). Project ids are opaque, so
  the same positional fallback applies if they do.

## Open questions

- **Should an opt-in auto-apply exist?** Recommend no for now. If it does, make it a per-reader
  switch with a much higher threshold, and say the move in the thread like a persona change.
- **Should a derived description be offered back to the reader to save?** Recommend yes, later: a "Use
  as description" action on the project page turns the derived text into the durable column.
- **Does the chip also appear in the palette's ask row?** Recommend yes, same route, since it mints a
  draft the same way.
