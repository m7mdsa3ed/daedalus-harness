# Model roles

_A thread may name several helper models, each tagged with a free-form role from a global vocabulary; a subagent is spawned on a role rather than on a hardcoded "small" model. The **vocabulary** (`model_roles`) is global and edited in Settings › Model roles; the **assignment** (role → model) belongs to the thread — picked when it starts and editable on a started thread. This replaces the profile-scoped `ModelDef.roles`, the per-model Roles field on the profile editor, and the vestigial `profiles.small_model` row. The sections below are the contract; the code change is later steps._

## The vocabulary — `model_roles`

Free-form, user-defined, **ordered rows**, the shape `rules` already takes (`server/src/db/schema.ts`). Global (no `projectId`), one list per server, edited in Settings.

```ts
export const modelRoles = pgTable("model_roles", {
  id: text("id").primaryKey(),          // stable; what assignments reference
  label: text("label").notNull(),       // display, e.g. "Small", "Advisor"
  description: text("description").notNull().default(""),  // one line for the agent
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
```

`label` is what a person reads, `id` is what assignments point at, so a rename does not strand every tag; both travel on the wire. No foreign key runs from an assignment to a row (an assignment is JSON on the thread), so a deleted role leaves a dangling tag a reader ignores. A fresh install ships seven roles — `small`, `fast`, `reasoning`, `advisor`, `explore`, `code`, `long-context` (`DEFAULT_MODEL_ROLES` / `seedDefaultModelRoles` in `model-roles.ts`, seeded only when the table is empty).

## Assignment — `sessions.helper_models`

The role → model map is a **column on the thread**, declared beside `config_choices` in `server/src/db/schema.ts`:

```ts
helperModels: jsonb("helper_models")
  .$type<{ role: string; model: string }[]>()
  .notNull()
  .default([]),
```

`role` is a `model_roles.id`; `model` is a profile model id, or `""` for the session model (the fallback below). **One entry per role**; the column's own order is the assignment — `profile.models[]` order is never consulted. The client field is `SessionMeta.helperModels` and the item is `{ role: string; model: string }` (`client/src/lib/settings.ts`).

**Chosen on the draft menu** (`DraftConfigPopover`, `client/src/components/draft-config.tsx`): one row per `model_roles` entry, each a model picker over the Model row's own choices — the profile's `models[]`, or the agent's advertised list on a profile that has none — plus "Session model" (`""`). **Edited on a started thread** by the same row in `SessionConfigPopover` (`client/src/components/session-config.tsx`), written through the thread config route like any other pick. `HelperModelHint` and the per-model Roles field on the profile editor are removed.

### How a draft's picks reach the created session

The same plumbing `configChoices` uses, function for function:

- `newDraftThread` (`client/src/lib/actions/draft.ts`) seeds `SessionMeta.helperModels` from the project's `defaults.helperModels`; `emptyDefaults()` and `ProjectDefaults` gain the field (`client/src/lib/thread-defaults.ts`).
- A pick goes through `configureDraft` → **`publish`** (**`saveProjectDefaults`**), onto the project's `ProjectDefaults.helperModels`, written only for the project the draft was **already** on — the same rescope exclusion `configChoices` carries. A picker that writes one row merges from the draft row like `publishConfigOption`, never from a cache.
- The `configure-draft` reducer (`client/src/lib/store/reducer.ts`) clears `helperModels` on an agent/profile rescope, beside `configChoices`/`modeId`; `draft-sessions.ts` `parseRow` round-trips it, validated like `configChoices`.
- On send, `createSession` (`client/src/lib/actions/core.ts`) puts `helperModels: meta.helperModels ?? []` in the POST body beside `configChoices`; the `POST /api/sessions` handler (`server/src/routes/sessions.ts`) destructures it and passes it to `sessions.create`; `create` (`server/src/sessions.ts`) forwards it into `blankSession`, which writes it on the row — a **spawn input like `model`/`effort`, not a post-handshake replay**. `rowValues` persists it and `rowToSession` reads it, defaulting `[]`.

## The wire — `DAEDALUS_AGENT_MODEL_ROLES`

`resolveSpawn` (`server/src/registry.ts`) resolves **the thread's** map into one JSON array, shipped at spawn:

```json
[
  { "id": "small",  "label": "Small",  "description": "Cheap side-jobs", "model": "claude-haiku-4[1m]" },
  { "id": "advisor","label": "Advisor","description": "Second opinion",  "model": "claude-opus-5" }
]
```

One entry per `helper_models` row, in its order; `id` is the row's `role`, `label`/`description` come from the vocabulary (`modelRoleDefs`, `id` as the label fallback for a deleted role), and `model` is resolved through `agentModelId(agent, profile, model)` so the catalog's `[1m]` suffix is already in the string. **A helper whose `model` is empty or names nothing in the profile's catalog resolves to the session model** (`resolveSpawn`'s `resolvedModel`) — spawning on an unassigned role inherits the session model, the current behaviour made explicit. **A profile with no `models[]` (the virtual Default) passes the id through as written** (`helperModelId`): the picker offered the agent's own model list there — the Model row's choices — so the id is the agent's, not a catalog's. **A thread with no helpers** resolves `""` and the key prunes away. `agent/src/env.ts` parses it (malformed → `[]`, the balance `windows()` strikes) into `modelRoles: { id; label; description; model }[]`.

`resolveSpawn` is synchronous (it is also called by `checkInstalled` and the probes), so the caller reads the vocabulary and the thread's map and passes both in — as it already passes `listModelRoles()` from `resolveAgentSpawn` (`server/src/acp-bridge.ts`).

## Selection — the `task` tool

`agent/src/tools/task.ts` gains two optional params (`role` and `model`) and a **dynamic** description built from the env's roles:

```ts
role:  z.string().optional().describe("Role to run the subagent on (see the roles listed in this tool's description)."),
model: z.string().optional().describe("Exact model id to run the subagent on; overrides role."),
```

In order: (1) `model`, an exact id, wins over everything — the **escape hatch**, passed to `makeModel` as written; (2) else `role`, matched against a role `id` then case-insensitively against a `label`, whose env `model` is used — a role naming nothing in the env is a tool error listing the known ids, an answer and not a crash; (3) else neither, the **session model**. `runSubagent` (`agent/src/turn.ts`) replaces the hardcoded `session.modelId` at `:1087` with the resolved id; the child otherwise keeps the parent's cwd, permission memory and `gate`.

**The child keeps its model.** The resolved id and the role are saved on the subagent entry (`SubagentEntry.model`/`role`), so a `send_message` follow-up runs where the child was spawned, not on the session model; a record from before either existed follows the session model. Both ride the spawn as `_meta.daedalus.{model,role}` on `subagent_spawned` (ACP's names neither), which the client reads into `SubagentItem.model`/`role` and draws on the row's caption (`subagentModelOf`, `thread-items/rows.tsx`).

The base description is unchanged; only when the env has roles, one clause is appended, **generated from the table**: "Run it on a named role instead of the session model: `small` (Small — Cheap side-jobs), `advisor` (Advisor — Second opinion). Pass an exact `model` to override the role; with neither it runs on the session model." A role with no `description` prints its label alone; with no roles the clause is absent.

## `subagentModelsVia` — cross-runtime dispatch

A declarative column on the agent row (`AgentDef`, `registry.ts`, beside `subagentFeed`/`rewindVia`/`pauseVia`), **never a comparison against an id**. It says how a runtime's *own* subagents take a role's model:

- **`"acp-env"`** (daedalus): roles ride `DAEDALUS_AGENT_MODEL_ROLES` at spawn and its in-process `task` tool reads them directly — nothing per-call reaches the child, because a subagent is the same process. A role's model is fixed for the process, so an assignment change costs a respawn like any spawn-time fact.
- **null / absent** (claude-code, codex, opencode, anything added): no helper models — the draft and session menus do not offer the submenu (they read this column, `client/src/lib/settings.ts`), subagents inherit the session model, and the runtime's own `Task`/`Agent` tools are untouched.

**Helper models are our runtime's alone.** Claude Code had a `"claude-agents-dir"` door — one marker-guarded `<cwd>/.claude/agents/<role>.md` per helper plus a `CLAUDE_CODE_SUBAGENT_MODEL` env key — and it was removed: seed 27 sets its column back to null and drops the key while it still holds the seeded `{subagentModel}` (`withoutSubagentModelKey`), and every spawn of a runtime with a workspace layout sweeps the files it wrote (`sweepSubagentRoles`, `materialize.ts`), never one without the marker.

Seeding sets daedalus and leaves the rest null; the harness's own `builtin:agents` is separate — it names a profile and agent, not a role.

## Retired

`ModelDef.roles` (the profile's `models[].roles` array) is **retired**: `assignedRoleIds` goes, nothing reads `profile.models[].roles`, and it must be dropped from `ProfileInputSchema` (`server/src/profiles.ts`) or Zod keeps stripping it. The column stays declared — a table push does not know about is a table push drops. `profiles.small_model` and its boot backfill (`modelRolesMigrated`) are dead for the same reason — the backfill wrote `models[].roles` — but their columns stay declared, and new saves write `smallModel: ""`.

## Files each step owns

- **Schema:** `server/src/db/schema.ts` (`sessions.helperModels` near `configChoices`; retire-note on `ModelDef.roles` and `profiles.small_model`) and `server/src/db/index.ts` (re-export); `pnpm db:push`.
- **Assignment + spawn:** `server/src/registry.ts` (`modelRoleDefs`/`modelRoleMap`/`subagentDefaultModel` read the thread's `helperModels`; `resolveSpawn` takes it as a param and builds the `modelRoles` var from it; delete `assignedRoleIds`; `subagentModelsVia` doc); `server/src/acp-bridge.ts` (`resolveAgentSpawn` reads the thread's map and passes it); `server/src/sessions.ts` (`create`/`blankSession`/`rowValues`/`rowToSession` carry `helperModels`; the `materializeSubagentRoles` call site at `:1947` passes `session.helperModels`); `server/src/routes/sessions.ts` (destructure `helperModels`); `server/src/materialize.ts` (sweep on an empty map).
- **Zod / profiles:** `server/src/profiles.ts` (drop `models[].roles`).
- **Runtime:** `agent/src/env.ts` (parse the env), `agent/src/tools/task.ts` (params, dynamic description), `agent/src/tools/context.ts` (`runSubagent` signature), `agent/src/turn.ts` (resolve the child's model at `:1087`).
- **Client:** `client/src/lib/settings.ts` (`SessionMeta.helperModels`, `ProjectDefaults.helperModels`), `client/src/lib/thread-defaults.ts` (`emptyDefaults`), `client/src/lib/actions/draft.ts` (`newDraftThread`, `publish`), `client/src/lib/store/reducer.ts` (rescope), `client/src/lib/draft-sessions.ts` (`parseRow`), `client/src/lib/actions/core.ts` (`createSession` body), `client/src/components/draft-config.tsx` and `session-config.tsx` (the role → model picker), `client/src/components/config-menu.tsx` (`HelperModelHint` retires), `client/src/components/settings/profile-models.tsx` (drop the Roles field).
