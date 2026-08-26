# Daedalus Harness

Generic ACP (Agent Client Protocol) harness. Three parts, one repo:

- `server/` — Node 22 + Hono + ws. Thin bridge: spawns ACP agent processes per thread
  (agent registry, `{apiKey}`/`{baseUrl}`/`{model}`/`{cwd}` placeholders filled from profile +
  project) and pipes raw NDJSON between agent stdio and the client WebSocket.
  Owns **profiles** (agent config: credentials/models, keys redacted from the API),
  **projects** (workspace: cwd + linked MCP/skill ids), the **library** of reusable MCP
  servers/skills, bearer-token auth, the frame journal (reconnect/replay), and FCM push.
  `data/` holds secrets — gitignored, never commit.
- **Storage is SQLite via Drizzle** (`server/src/db/`), not JSON files.
  `data/daedalus.db`, opened with better-sqlite3 — chosen over `node:sqlite`/libsql because
  it is what Drizzle's Node driver binds to *and* it is synchronous, and `getProfile`/
  `getAgent`/`listProjects` are called from sync paths (`spawnProc` builds a child's env from
  all three). Every query goes through the `db` exported by `db/index.ts`, so the driver is
  swappable in one file. Schema in `db/schema.ts`; migrations are generated
  (`pnpm db:generate`) into `server/drizzle/` — **committed, and applied at boot** by
  `migrate()` — never `drizzle-kit push`. A pre-SQLite install is imported once on first boot
  and its files kept as `*.json.imported` (`importLegacyJson`). Two things the JSON could not
  express: a project's MCP/skill links are **join tables with `ON DELETE CASCADE`**, so a
  dangling id cannot exist and nothing filters for one any more; and the **frame journal is a
  table** keyed `(session_id, seq)` rather than an unbounded in-memory array, so `cursor` is a
  monotonic seq, a replay is a range scan, and a long thread costs no RAM. `data/config.json`
  is the deliberate holdout — bootstrap (host/port/token/FCM path), hand-editable, and needed
  before any database exists.
- `client/` — Vite + React 19 + Tailwind v4 + shadcn (Base UI, NOT Radix: compose triggers
  with `render={...}`, not `asChild`; `SelectValue` needs explicit children for labels).
  The browser is the real ACP client via `@agentclientprotocol/sdk` over
  `experimental/ws-client`. State: one reducer in `src/lib/store.tsx`; side effects in
  `src/lib/actions.ts`; ACP connection per thread in `src/lib/acp.ts`. Color palettes live in
  `src/styles/themes.css` (one `[data-color-theme]` block per palette, light +
  dark), not in `index.css`; user-made palettes are that same token set written
  into a runtime `<style>` by `src/lib/custom-themes.ts` and edited in
  `components/theme-builder.tsx`. ⌘K opens `components/command-palette.tsx`.
  Reading a tool call — inferring its kind, target, language and diff out of
  ACP's opaque `rawInput`/`rawOutput` — is quarantined in `lib/tools.ts`; the
  transcript dispatches its per-kind layouts on ACP `kind`, never on a table of
  vendor tool names. `components/ui/diff-view.tsx` is a dependency-free line LCS.
  Device-local, per-session state lives in its own tiny stores — `lib/drafts.ts`
  (unsent prompts), `lib/pins.ts` (pinned threads), `lib/view-options.ts`
  (timestamps/tool grouping) — all pruned from `refreshSessions`. The shelf above
  the composer is `components/composer-strip.tsx`; app icons regenerate from
  `client/build/icon.svg` via `pnpm icons`.
  Theme/layout ported from
  `/var/www/mawared-off/social-live-agent/ai-agent-web` (glass surfaces, Inter, step-row
  transcript). Electron shell lives in `client/electron/` (frameless, vibrancy/acrylic).
- No build-time client config: server URL + token are entered at runtime (localStorage).

## Commands

- Agents are spawned by their **globally installed binary**, not through `npx`:
  `npm install -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp`.
  npx re-resolves the package on every spawn, and a thread spawns on create, on revive and
  on every profile/model change — measured here at ~3.2s per spawn versus ~0.4s for the
  binary. A missing binary fails with ENOENT, which surfaces in the thread; the
  self-installing form is `command: "npx"`, `args: ["-y", "<package>"]`. Defaults live in
  `DEFAULT_AGENTS` (`server/src/registry.ts`); each carries a `since` seed version and
  `seedAgents()` inserts only the ones this install has never been offered, so **an agent
  added in a later release reaches installs that already have rows** (the old seed-if-empty
  rule could not). It backfills fields a release *adds* (e.g. `spawnCategories`) onto older
  built-in rows but never touches name/command/args/env — those are the user's.
- Server: `cd server && pnpm dev` (prints token), `pnpm test` (pipe self-check, fake agent).
- Schema change: edit `server/src/db/schema.ts`, run `pnpm db:generate`, commit the SQL in
  `server/drizzle/`. `pnpm db:studio` browses the database.
- Client: `cd client && pnpm dev` / `pnpm build` / `pnpm electron:dev` / `pnpm electron:dist:win`.
- Typecheck: `pnpm exec tsc -b` (client), `pnpm exec tsc --noEmit` (server).
- `tsconfig` uses `erasableSyntaxOnly` — no TS constructor parameter properties.
- eslint currently crashes at startup (typescript-eslint vs typescript 7 — pre-existing).

## Conventions

- Protocol truth lives at the endpoints. The server reads ACP only as far as multiplexing
  demands: it sniffs `session/new` / `session/prompt` / `session/request_permission` for
  metadata, and arbitrates JSON-RPC ids so several clients can share one agent process —
  client request ids are rewritten to session-unique ones and responses routed back to the
  peer that asked; agent->client requests fan out to every peer and the first answer wins.
  Peers stay in sync through the `_daedalus/*` bridge notifications (`turn_ended`,
  `peer_prompt`, `request_answered`). It still never interprets `session/update` payloads.
- ACP schema is the source for modes/config options/usage — render generically, don't
  hardcode per-agent knowledge in the client.
- **The profile decides who owns the model.** A profile that lists `models[]` has
  *overridden* the agent: those ids reach it only through `{model}`/`{effort}`/
  `{contextWindow}` in the env template (`server/src/registry.ts`), so picking one respawns
  (`actions.changeSpawnConfig`). A profile that lists none defers to the agent, whose
  `category: "model"` / `"thought_level"` selectors apply through
  `session/set_config_option` — one call, safe mid-turn, no restart. The override is scoped
  to exactly those two settings: **every other agent option passes through untouched and
  stays live** in either case. This exists because an agent pointed at a gateway advertises
  its own catalog, which the endpoint does not serve — codex derives its effort list from
  the *current model's* metadata, so an unknown gateway model id yields no effort selector
  at all. `lib/session-options.ts` does the sorting from the ACP `category` field; unknown
  and missing categories fall through to "Agent options" rather than being dropped, and an
  agent advertising no model selector gets no Model row — the client never invents one.
  **A profile changes the model and the effort, and nothing else.** It is credentials and a
  catalog, not a way of working, so a respawn must not reset how the agent was configured:
  `respawnThread` captures the permission mode and every non-model/effort option before it
  closes the old process and `restoreSettings` puts them back once `session/load` has
  answered, skipping whatever the new session already agrees with. Both menus read Profile →
  Model → Effort, with mode and the rest under "Agent options", because the profile decides
  what the two lists below it can contain. Profile changes always confirm (new credentials,
  new endpoint, new catalog; the model does not carry over). After a live change `PATCH /api/sessions/:id` keeps `session.model`/
  `effort` in step so reviving a retired thread rebuilds the right env.
- **Every agent gets a virtual "Default" profile**, listed first. `defaultProfileFor`
  synthesizes `default:<agentId>` — no credentials and, deliberately, no `models`, which is
  what hands model and effort back to the agent per the rule above. It is offered for every
  agent, not just unconfigured ones: "run this agent as it ships" is a real choice next to
  "run it on my gateway", and without it the only way back would be deleting the profile.
  Never written to `data/`, cannot be edited or deleted. `profiles.ts` is the single source:
  the same function feeds `GET /api/profiles` and `getProfile` at spawn.
- **A draft cannot ask a process that does not exist**, so `lib/agent-options.ts` (a
  reactive device-local store, same shape as `pins.ts`) holds each profile's option set from
  two sources: whatever a live session last advertised, and — when nothing is known yet — a
  one-shot `POST /api/profiles/:id/options`. A profile that has no set of its own borrows a
  sibling profile's of the same agent (Default first) for display — the profile only
  overrides model/effort, everything else is the agent's — while its own probe still runs
  and replaces the borrowed set. The probe spawns the agent, runs the handshake as far as
  `session/new`, and kills it (`server/src/probe.ts`). The answer is cached **in the
  database**, keyed `profileId:agentId:cwd` (cwd is in the key because it changes the answer),
  with an in-flight map so two tabs asking at once spawn one agent, not two — so it is one
  spawn ever, not one per page-load, and `?refresh=1` is the escape hatch for an upgraded
  binary or a changed gateway catalog. Picks are held on the draft and replayed with `session/set_config_option` right
  after `session/new` (`createSession`).
  **Which options exist can depend on which model is selected** — opencode reveals `effort`
  only for its reasoning models, in the `set_config_option` *response*, with no
  `config_option_update` notification. So the probe does not just snapshot the current set:
  while it has the process up it walks the model list (capped at `MAX_MODEL_SWEEP`, and it
  logs when it truncates), recording what each model advertises, and the menu reads the
  entry for the model actually chosen. One spawn, the whole map. Still best-effort — a
  different cwd or an upgraded agent invalidates it — and the real set replaces it as soon
  as a session answers.
- **The client mints session ids and threads start as drafts.** "New thread" is a route
  change, not a round trip: `actions.newDraftThread` mints a UUID, puts a `draft: true`
  `SessionMeta` in the store and navigates. `POST /api/sessions` (which accepts that id,
  rejecting non-UUIDs and collisions) is not called — and no agent process is spawned —
  until the first message, in `actions.send`. Everything that treats the server's list as
  the authority has to let drafts through: the `sessions` reducer **merges** instead of
  replacing, `refreshSessions` prunes against server ids **plus** draft ids, and
  `connectThread` returns early for a draft since there is nothing to connect to. A route
  for a thread the server has never heard of is adopted as a fresh draft rather than 404ing.
  An empty thread centres its composer over an animated wash (`styles/thread-hero.css`) and
  docks it on the first message — both driven by one `data-empty` flag on a grid whose
  spacer row animates `1fr` → `0fr`.
- **A capability we don't advertise is a feature the agent turns off.** The `initialize`
  handshake in `lib/acp.ts` is not a formality: claude-agent-acp puts `AskUserQuestion` on
  the session's `disallowedTools` unless the client claims `elicitation.form`, so without it
  the model cannot ask a question at all — not badly, at all. Same bargain buys codex's
  boolean config options (`session.configOptions.boolean`) and codex's plans (`plan`).
  Questions arrive as `elicitation/create`, NOT as a permission request: a form-mode request
  whose `requestedSchema` is a JSON Schema of primitive properties. Reading that schema —
  titled `oneOf` enums, `items.anyOf` multi-selects, and the two `_meta` conventions the
  AskUserQuestion bridges ride (`_askUserQuestionCustomAnswer`, which pairs a free-text
  "Other" field to a select field, and `_claude/askUserQuestionOption`, which carries an
  option's preview) — is quarantined in `lib/elicitation.ts`, the way `lib/tools.ts`
  quarantines tool-call shapes. `components/elicitation-form.tsx` renders it as a
  `ui/questionnaire` stepper, one field per step. Narrow the request with the SDK's
  `CreateElicitationRequest.isForm`/`isUrl` guards, never `mode === "form"`: the union's
  custom variant carries the same tag and the guards validate the payload too. Answers are
  `accept` with content keyed by field; **`decline` is a real answer** (the bridges read it
  as "the user skipped" and the turn continues) where `cancel` aborts the tool call. The
  lifecycle mirrors `permission` exactly — one pending slot on `ThreadState`, cleared by
  `resolve`, settled as `cancel` when `_daedalus/request_answered` says another device
  answered first, and pushed by the server (`onElicitationRequest`) when no peer is attached.
- **Errors are never `String(err)`.** `client/src/lib/errors.ts` normalizes everything
  thrown (ACP `RequestError`, `ApiError` from `lib/settings`, network failures, aborts)
  into `{ title, detail }`: `describeError` for the values, `reportError(err, context)`
  for the toast, where `context` names the action ("Couldn't save the profile") and the
  normalized title/detail go underneath. Failures that belong to a thread go IN that
  thread instead — `actions.recordError` appends an `error` ThreadItem (title / reason /
  folded detail / `retryText` for a Retry button), which survives longer than a toast and
  is rebuilt from the journal on reload. `installGlobalErrorReporting()` in `main.tsx` is
  the floor under both.
- The server splices the agent's stderr into JSON-RPC errors on the way out
  (`SessionManager.enrichError`, `data.stderr`) — "Internal error" is a code, not an
  explanation, and the explanation was only ever on stderr. It also answers in-flight
  requests when the agent dies (`failPendingRequests`) rather than letting them hang, and
  `GET /api/sessions/:id/stderr` exposes the tail. `app.onError` turns every route throw
  into the `{ error }` shape the client already parses.
- Test agent: `server/test/fake-agent.mjs` (registered as `fake-echo`), drives the UI without
  credentials.
- No visual testing: don't drive the UI with Playwright/browser automation or take screenshots
  to check work. Verify with `tsc -b` and reasoning about the code; the user checks the UI.
