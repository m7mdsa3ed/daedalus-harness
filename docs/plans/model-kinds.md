# Model kinds: decision (System One) and completion (FIM)

_Status: the `kind`/`wire` columns and the editor that saves them ship; every lane that calls such a
model is unbuilt and removed (see "What ships now")._

## Context

The profile catalogue (`profiles.models[]`, `ModelDef` in `server/src/db/schema.ts:41`) assumes
every model is a chat model. That assumption is spread thin but it is everywhere: the agent loop
speaks OpenAI-compatible chat completions only, `probe.ts` asks a runtime what option set a model
reveals, `models-dev.ts` enriches entries with reasoning efforts and modalities, and the composer's
picker offers whatever the profile lists.

Two families now arrive that are not chat models:

- **System One / decision models** — Jev (TypeSafe, hosted), Kev (Apache-2.0, Qwen3.5 LoRA at
  0.8B/4B/9B/27B, self-hosted), Laya (ModernBERT, needs fine-tuning), SemIf (reads logits off a
  frozen Qwen3.5-4B), NanoJev (Qwen3-0.6B plus decision heads), Microsoft-Decision-1 (Foundry /
  OpenRouter). They take a **state** and a map of **typed questions**, and return typed values with
  probabilities. They generate no text.
- **Fill-in-the-middle models** — Codestral, DeepSeek, and anything OpenAI-compatible. They take a
  **prompt** and a **suffix** and return the text between them.

A third kind (embeddings) is deliberately out of scope: `knowledge-db.ts` is substring search by
choice, and nothing consumes a vector today.

## The two standards

### Decision models: the System One contract

Jev's own contract, and the one Kev serves unchanged, so the official SDK works by swapping the
base URL:

```
POST {baseUrl}/v1/systemone
Authorization: Bearer <key>
{
  "model": "jev-1.13.0" | "jev-latest" | "kev-latest",
  "state": "<text>" | { ...json... } | ["<text>", ...],
  "questions": {
    "is_urgent":  { "type": "noul",   "instructions": "Does this convey urgency?" },
    "department": { "type": "choice", "instructions": "Which team?",
                    "criteria": { "billing": "Charges and refunds", "technical": "Product errors" } },
    "frustration":{ "type": "score",  "instructions": "How frustrated?",
                    "criteria": ["Calm", "Frustrated", "Very angry"] }
  }
}
```

Response, one block per named question, plus the model that answered and token usage:

```
{ "is_urgent":  { "type": "noul",   "noul": 0.999 },
  "department": { "type": "choice", "choice": { "billing": 0.81, "technical": 0.19 }, "confidence": 0.81 },
  "frustration":{ "type": "score",  "score": 1.42, "confidence": 0.77 },
  "model": "jev-1.13.0", "usage": { "input_tokens": 214, "output_tokens": 12 } }
```

Facts that constrain the design:

- **Question names never reach the model.** The names are ours; `instructions` and `criteria` do the
  work, so a question set is a real artifact worth versioning, not a prompt fragment.
- **Every question runs against one state in parallel.** Adding questions costs tokens, not latency.
- **Aliases move.** `jev-latest` resolves to `jev-1.13.0` today; a production definition pins the
  exact version, and the response's `model` is recorded so a shift is visible.
- **`kev-latest` requires a base URL** and is never sent to the hosted endpoint; Kev binds
  `127.0.0.1` by default, takes `KEV_API_KEY` to require auth, and `--host 0.0.0.0` to accept other
  machines. It answers `x-typesafe-request-id` on every response.
- Gateways front it on `/v1/decisions` (Portkey, LiteLLM) — a different path for the same body. The
  path is therefore part of the wire, not a constant.
- **But not every gateway does.** The 9router install here serves `oc/jev-1.13-free` on
  `/v1/systemone` and 404s `/v1/decisions` (checked with a real `noul` body: 200 and
  `{"answers":{"is_shell":{"noul":0.81}}}`), so that row is `wire: "systemone"` — a gateway in the
  URL does not decide which of the two wires it speaks. The answer names the model `jev-1.13-free`,
  the `oc/` prefix stripped, which is exactly why a run reports what actually answered.

### Completion models: `prompt` + `suffix`

The OpenAI legacy completions shape, which everyone who does FIM follows:

```
POST {baseUrl}/completions        # DeepSeek: baseUrl must end in /beta
{ "model": "...", "prompt": "<prefix>", "suffix": "<what follows the gap>",
  "max_tokens": 128, "stop": ["\n\n"], "temperature": 0.2 }
```

Response is `choices[0].text`. Mistral's Codestral uses `/v1/fim/completions` with the same body;
some gateways accept a chat request with `prefix`/`suffix` in `extra_body`, and DeepSeek has a chat
prefix mode — neither is the standard, so neither is the default wire.

## Design

### 1. Kind and wire are columns, and the wire is an adapter

`ModelDef` gains two optional fields, both absent meaning today's behaviour:

```ts
kind?: "chat" | "decision" | "completion";   // absent = "chat"
wire?: "systemone" | "openai-completions" | "chat-json";
```

`kind` decides what the model *is* (and therefore where it may be offered); `wire` decides how it
is called. Two separate fields because the same kind has more than one door: Kev speaks `systemone`,
a Foundry-hosted classifier answers on chat and has to be parsed, and FIM is `openai-completions`
whether it is Mistral or DeepSeek.

This is the same bargain `AgentDef.quotaProbe.kind` already makes (`schema.ts:82`): the protocol is
code, selected by a column, and everything a user can repoint is data. Nothing outside
`decide.ts` spells a vendor's path or payload.

### 2. Decision models live on profile rows; only question sets need a table

A decision model is a provider, a credential, a base URL and a model id — which is exactly a
profile. So there is **no second provider CRUD**: a decision provider is a profile whose
`models[]` holds entries with `kind: "decision"` and no chat models. The composer's picker filters
`kind === "chat"`, so such a profile can never be picked for a thread, and a profile with no chat
models simply cannot start one (a config error the draft's picker already prevents).

What *is* new is the unit above the model: a **question set**. That is a row:

```ts
export const decisions = pgTable("decisions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),              // "tool-call risk", "ticket triage"
  description: text("description").notNull().default(""),
  projectId: text("project_id"),             // null = global, the shape `rules` takes
  profileId: text("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  model: text("model").notNull(),            // pinned: "jev-1.13.0", never an alias in production
  questions: jsonb("questions").$type<Record<string, DecisionQuestion>>().notNull(),
  /** Per-question thresholds: auto, park, or just a badge. */
  thresholds: jsonb("thresholds").$type<Record<string, number>>().notNull().default({}),
  version: integer("version").notNull().default(1),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
```

Routes: `GET/POST /api/decisions`, `PUT/DELETE /api/decisions/:id`, and
`POST /api/decisions/:id/test` — a sample state in, the normalized answer out. The test door is
what makes the CRUD worth having before anything consumes it: you can read a probability and tune
the criteria in the same screen.

A definition is global unless it names a project, because a per-project one is the exception (a
board's own labels), and the global list is what the permission gate and the inbox read.

### 3. One adapter module, one normalized answer

`server/src/decide.ts` holds the question types, the answer types and one function per wire:

```ts
export interface DecisionQuestion {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: string[] | Record<string, string>;
}
export interface DecisionAnswer {
  type: "noul" | "choice" | "score";
  probability?: number;                     // noul
  choice?: Record<string, number>;          // choice, per-label
  score?: number;                           // score, continuous
  confidence?: number;
}
export type Decide = (req: {
  profile: Profile; model: string; state: unknown;
  questions: Record<string, DecisionQuestion>;
}) => Promise<{
  answers: Record<string, DecisionAnswer>;
  model: string; usage?: { input?: number; output?: number }; requestId?: string;
}>;
```

Nothing downstream learns a vendor. `chat-json` is the escape hatch for a classifier behind a chat
door: it sends the questions as a schema-constrained prompt and coerces the reply, and it is the
one wire allowed to be approximate — the response shape says so, since `confidence` is absent when
the vendor did not give one.

### 4. Two doors, and only one of them is a model call in a turn

- **Builtin MCP `decide`** (`BUILTIN_MCP` in `library.ts:25`, plus the `builtin` enum in
  `schema.ts:569`): tools `list_decisions` and `decide({ decision, state })`, spawned as a stdio
  subprocess with the DB like `knowledge-mcp.ts` and carrying no harness singletons. Every runtime
  gets it, the same way every runtime gets `knowledge`.
- **In-process `classify()`** for the harness's own questions — a permission risk verdict, the
  inbox order. These must never spawn a process per permission, and they are not turns.
- `POST /api/decisions/:id/run` for the client (the settings test box, a badge on a permission row).

**A decision call is never journaled.** It is not a turn, not a `session/update`, and the server
still never interprets one. A verdict worth keeping is a row of its own, the way `mcp_catalog` is.

### 5. What must not change

- The spawn path never reads `kind`. `AgentDef`, `materialize.ts` and `probe.ts` stay chat-only, and
  the model picker filters by kind *before* it asks anything.
- `models-dev.ts` enrichment is chat-shaped, so a `decision` or `completion` model is never
  enriched; `reasoningEfforts` stays `[]`.
- Helper models and roles stay chat-only (`docs/model-roles.md`) — a classifier cannot drive a turn.
- A definition with no thresholds is a reading, not a gate. Nothing auto-answers a permission until
  it names a threshold, and an auto-answer without an allow rule is out of scope: the gate may
  badge, and may park earlier, never allow more.

### 6. FIM is a separate lane, and it has its own plan

The ACP loop has no place for a FIM call: it is a keystroke-scale request with no turn, no
transcript, no permission. So the first slice adds the `kind`/`wire` columns (they are additive and
model-free) but not the lane.

The lane is three pieces, none of which ships yet — its own plan is `docs/plans/fim-composer.md`:
`POST /api/fim` (resolved by `server/src/fim.ts`), **one install-wide default** — a profile and a
`kind: "completion"` model, chosen in Settings › AI and stored in `app_settings`, not a device-local
pick, because the model is a row inside a profile and two devices should not disagree about which
one finishes a command — and the client surface: ghost text at the caret in the composer, accepted
with Tab. A `!` command line is where it starts, since a command is prefix-only, which is the shape a
FIM model is for; `GET /api/projects/:id/scripts` already supplies the candidates a user would be
aiming at. The Composer row's own test button speaks this wire, so a Codestral/DeepSeek row can be proved
before it is chosen as the default.

## First slice, in order

1. `ModelDef.kind` / `ModelDef.wire` — additive jsonb, no data migration, absent = chat.
2. `decisions` table + Zod + routes + `decide.ts` with the two System One wires
   (`systemone`, `systemone-gateway`) and the FIM adapter — ready, not routed.
3. Settings › Models › profile: a "Decision models" section (id, label, kind, wire, by hand — no
   models.dev lookup), and Settings › Decisions: the question-set editor with the test box.
4. Builtin MCP `decide`.
5. The permission gate as the first in-process consumer, behind a config flag off by default.
6. `completion` kind + `/api/fim` when there is a surface to draw it in.

`db:push` drops a table it does not know about, so step 2 declares `decisions` before any code
reads it, and the table is never created by a route.

## Open questions

- Global question sets or project-scoped? The shape above allows both; the default is global.
- Is a definition allowed to change model without bumping `version`? Recommend no: a changed model
  invalidates the thresholds silently, and `version` is cheap.
- Does a verdict belong on the transcript at all (a badge on the permission row, a line in the
  inbox) or only in a table? The transcript is the guidance; the inbox is the answer.

## What ships now: the columns and the editor, not the lanes

The catalogue can hold a non-chat model and keep its `kind`/`wire` across a save; nothing calls one.

- `MODEL_KINDS` / `MODEL_WIRES` and `ModelDef.kind` / `ModelDef.wire` (`server/src/db/schema.ts`),
  declared in `profiles.ts`'s model Zod so a save keeps them — a column Zod does not know is
  stripped, and a decision model that came back as a chat model is one the picker offers for a
  thread.
- `kind`/`wire` on the profile editor's model row (`client/src/components/settings/profile-models.tsx`),
  absent on a chat model so an entry saved today is byte-identical to one saved before kinds.
- `modelsOfKind` / `chatModels` / `servesChat` (`client/src/lib/settings.ts`), so every thread-facing
  picker — the draft's, a started thread's, an ask-agent's — offers only chat models and a
  decision-only provider is never a thread's profile.
- Two seeded presets models.dev cannot describe (`profile-presets.ts`, `seedModels`): TypeSafe/Jev
  and DeepSeek FIM. They exist to *add* those rows, not to run them.

Deliberately **not** shipped, and removed from this slice after it was built: the `decisions` table
and its CRUD, `decide.ts`'s System One adapters, `fim.ts` and `/api/fim`, the Settings › Decisions
editor, the builtin `decide` MCP tools, and the composer's Tab completion. The design below stands
as the argument for them; nothing above reaches the wire, so no table exists to keep in step with
`db:push` and no route answers an empty one.

Still open, in the order the doc above argues for: the adapters (`decide.ts`, `fim.ts`) with their
routes, the `decisions` table and editor, the permission gate as the first in-process consumer, the
builtin `decide` MCP server, and one surface that draws a completion.
## Built

Corrected: an earlier version of this section claimed `decisions.ts`, `routes/decisions.ts`, the
`decisions` table and `test:decisions` shipped. They did not, and the "What ships now" section above
is the truth about them. What exists for the decision lane is:

- `server/src/decide.ts` — the System One call (`systemone` at `/v1/systemone`, `systemone-gateway`
  at `/v1/decisions`, a versioned-root URL rule), both response envelopes, the refusals.
- `server/src/side-models.ts` — the lane's install-wide (profile, model), and the persona question's
  thresholds (`personaDecision`).
- Its first consumer, `server/src/persona-classify.ts` (`docs/plans/persona-decision.md`).
- `pnpm test:decide` — a real local HTTP server asserting the path, the bearer, the body, both
  envelopes and the refusals.

Still open: the permission gate, the builtin `decide` MCP server, the `decisions` table and editor,
and `/api/fim` beyond the composer.
