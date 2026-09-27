# Daedalus Harness — Unified multi-server view (threads and projects merged across servers)

## Context

The client already stores **several servers** — `daedalus.servers` in localStorage,
`{ servers: ServerSettings[], activeId }` (`client/src/lib/settings.ts:9-24`) — but only
ever *connects* one. `loadSettings()` (`settings.ts:76-79`) answers "the connection every
request in the app uses", the whole store holds that one server's rows, and switching is a
hard reload (`settings/general.tsx`: "threads, the ACP sockets and the whole store belong
to one server, so the cheapest correct swap is to re-boot the app"). The one true
multi-server surface today is push: registrations outlive the tab, so a device can hold
live FCM rows on N servers while the UI shows one.

The user runs more than one harness server and wants threads and projects **merged**.
The chosen model (offered against on-demand copy and continuous sync, and picked
explicitly) is the **unified view**: the client connects to *all* stored servers at once,
the sidebar / palette / search show every server's threads and projects together, and each
thread lives and continues on its **home** server. Nothing is copied, nothing syncs, and —
the load-bearing fact — **no server-side change is needed at all**: `api(settings, path)`
and `wsUrl(settings, …)` already take the connection explicitly (`settings.ts:157,211`),
and every `ThreadSocket` already captures one `ServerSettings` at construction
(`lib/thread-socket.ts:174-178`). The single-server binding is entirely client state plus
a dozen modules that resolve "the server" ambiently through `loadSettings()` at call time.

Two client-side facts drive the whole design:

**The store and the pruning are single-server in ways that destroy data if naively fed
two servers.** `refreshSessions` (`lib/actions.ts:722-753`) prunes drafts, pins and the
module-level thread runtime (sockets, journal cursors, backoff state) against **one**
server's session list — with server B's threads in the store, a routine refresh against A
closes B's live sockets and deletes B's pins. The `sessions` reducer replaces wholesale
(`lib/store.tsx:952-961`, drafts excepted), and `pruneAgentOptions` does the same to the
device-local option cache. Multi-server is therefore a *store and actions* refactor first,
and a UI feature second.

**Which ids can collide is knowable, and narrow.** Sessions, projects, user-made profiles
and every library row are UUIDv4 — globally unique across installs, so all bare-id keying
stays exactly as it is: the `/t/<id>` route, `liveThreads`, `journalCursors`, drafts, pins,
`ui.collapsedProjects`. What *does* collide is every deterministic id, which exists once
**per server**: agent ids (`claude-code`, `codex`, `opencode`), virtual profiles
(`default:<agentId>` — and note a thread on a Default profile carries exactly that string
as its `profileId`, so this is not just a picker problem), builtin MCP rows
(`builtin:web-search|knowledge|workflow`), builtin personas (`builtin:*`). The rule that
falls out: **lookups by session/project id stay unscoped; any catalog lookup on behalf of
a specific thread (its profile, agent, persona, library) must be scoped to that thread's
server.**

## Decisions

1. **Tag, don't namespace.** Every store row gains an optional `serverId?: string`,
   stamped by the actions layer at fetch time (server responses never carry it — it is
   client-only, like `SessionMeta.draft`). No id rewriting anywhere: rewriting
   `default:claude-code` per server would mean un-rewriting at every API boundary, which
   is the bug factory the stamp avoids.
2. **The store merges per server.** Every slice-replacing action carries a `serverId` and
   replaces only that server's rows, preserving other servers' rows and local drafts.
3. **`useActions()` keeps its external API** and becomes multi-server inside: bootstrap
   boots every server, refreshes loop, and every per-thread method resolves the thread's
   home server from its row. No component learns a new calling convention.
4. **Two small helper modules, split by React.** `lib/server-map.ts` is a module-level
   registry (sessionId→serverId, projectId→serverId → `ServerSettings`) for the ambient
   non-React modules; `lib/server-scope.ts` is the component-side filter kit
   (`rowServerId` / `onServer` / `findOn` / `useServerScoped`). With one server stored,
   every filter is identity — the single-server experience is unchanged.
5. **Pruning waits for the full picture.** Drafts/pins/agent-options are pruned only
   against the **union** of all servers' reported ids, and only once **every** stored
   server has reported successfully this page-load. An offline server parks pruning —
   hygiene can wait; a flaky server must not unpin a healthy server's threads. The
   *thread-runtime* sweep (sockets/cursors/backoff) is different: it runs on every
   refresh, scoped to keys **owned by the refreshing server** (via server-map), which is
   what fixes the cross-server socket-closing bug without waiting for anyone.
6. **"Active" survives as "primary".** Settings pages, library management, boards/tasks,
   the import dialogs, backup and the connect screen stay bound to the active server —
   they are management surfaces *of one server*, and their `useSettingsPage()` contract
   already says so. It is also the fallback when starting a thread with no project
   context. Switching primary stays a reload (cheap, correct, and now rare — you no
   longer switch to *see* another server).
7. **Boot must not be hostage to the slowest server.** The active server's bootstrap
   gates the `loaded` flag exactly as today; every other server boots concurrently via
   `Promise.allSettled`, failures land as an `offline` status in the store (badged in the
   UI), and the visibility/online listeners retry never-booted servers later.
8. **Push registers everywhere.** Every stored server now has attached peers sometimes
   and none other times, so every one of them needs the device's token. `push.ts` is
   already internally multi-server-safe (named Firebase app per project, `push.token:<serverId>`
   cache, shared-token guard in teardown) — only the call sites change.

## The work

### 1. `client/src/lib/settings.ts` — types and primitives (additive)

- `serverId?: string` on `SessionMeta`, `Project`, `Profile`, `AgentDef`,
  `McpServerDef` (in the `& { id: string }` intersection), `SkillDef`, `CommandDef`,
  `Persona`, `ScheduledMessage`, each with the same one-line comment: client-only,
  stamped by actions at fetch, never sent by a server.
- `serverById(id): ServerSettings | null`, `activeServerId(): string | null`.
- `subscribeServers(listener): () => void` — `write()` notifies after
  `localStorage.setItem`; a module-level `storage` event listener on the
  `daedalus.servers` key covers other tabs (the pins.ts pattern). Every mutator already
  funnels through `write()`, so no per-function edits.

### 2. `client/src/lib/server-map.ts` — new, no React (imports only `./settings`)

```ts
recordSessions(serverId, ids)      // replace that server's session entries
recordProjects(serverId, ids)
recordSession(sessionId, serverId) // drafts / single upserts
forgetServer(serverId)
sessionServerIdOf(id): string | undefined
projectServerIdOf(id): string | undefined
serverForSession(id): ServerSettings | null   // joined with loadServers(); falls back to ACTIVE
serverForProject(id): ServerSettings | null
sessionServerEntries(): IterableIterator<[string, string]>  // for ownership sweeps
```

Fed by actions on every sessions/projects dispatch; read by the ambient modules (§8) and
by the runtime sweep (§5).

### 3. `client/src/lib/server-scope.ts` — new, component-side

```ts
rowServerId(row)            // row.serverId ?? loadSettings()?.id
onServer(rows, serverId)    // filter; identity when serverId is undefined
findOn(rows, serverId, id)  // scoped lookup, for the deterministic ids
useServerScoped(serverId)   // memoized {profiles, agents, personas, mcpServers, skills, commands}
```

### 4. `client/src/lib/store.tsx` — per-server slices

- `State.servers: ServerInfo[]` where
  `ServerInfo = { id, name, url, status: "loading" | "online" | "offline" }` — the token
  deliberately absent (state is inspectable; credentials stay in localStorage).
- Slice actions gain a required `serverId`: `bootstrap`, `sessions`, `scheduled`,
  `profiles`, `agents`, `projects`, `mcp-servers`, `skills`, `commands`, `personas`.
  No component dispatches these directly (verified) — the change is contained to
  store.tsx + actions.ts.
- New actions: `servers` (seed/reconcile the list, preserving known statuses by id),
  `server-status`, `forget-server` (drop the info row and filter `row.serverId === id`
  out of every slice; `threads` entries are left — an open route keeps rendering, and
  actions close the sockets).
- One merge helper, used by every slice case:

  ```ts
  /* Replace one server's rows, keep everyone else's; segments ordered by
     State.servers (active first), original order within (sort is stable). */
  mergeServerRows(state, prev, serverId, next, { dedupeById })
  ```

  `dedupeById: true` for `sessions` / `projects` / `scheduled` (UUID rows — makes the
  same-backend-stored-twice misconfiguration converge instead of double-listing);
  **no dedupe** for catalogs, where `default:claude-code`, `claude-code` and `builtin:*`
  legitimately exist once per server and each copy must stay pickable.
- `sessions` keeps the existing draft rule, per server: keep drafts the incoming report
  doesn't name, keep other servers' rows; a draft whose id **any** server now reports has
  just been created there and the server's row wins (`store.tsx:952-961` semantics,
  widened).
- `configure-draft`'s `next` Pick gains `serverId`; a changed `serverId` also clears
  `configChoices` — the same rescope rule a changed agent/profile already has
  (`store.tsx:999-1001`), for the same reason.

### 5. `client/src/lib/actions.ts` — the rework

**Module-level bookkeeping** beside `journalCursors` (`actions.ts:93`):
`sessionReports: Map<serverId, Set<sessionId>>` and
`profileReports: Map<serverId, Set<profileId>>` (last successful report per server — the
prune gate's evidence), `bootedServers: Set<serverId>`.

**Resolution helpers** inside `useActions`, beside `requireLive` (`actions.ts:127`):
`allServers()` (stored list, active first — the closure's `settings` *is* the active
one), `serverOf(row)` = `serverById(row.serverId) ?? settings`,
`requireServer(sessionId)` = `serverForSession(id) ?? settings`,
`profileOf(meta)` = `findOn(stateRef.current.profiles, meta.serverId, meta.profileId)`.

**Stamp-and-record dispatchers** — the single place rows get tagged, server-map gets fed
and `sessionReports` gets recorded (`dispatchSessions(server, rows, emit = dispatch)`,
`dispatchProjects`, plain stampers for the rest). Stamping is unconditional, so rows in
the store always carry `serverId`.

**Boot** (`bootstrap`, today `actions.ts:841-869`): `bootServer(server)` runs today's
nine parallel fetches against one server, stamps, dispatches one
`{type: "bootstrap", serverId}`, marks it online/booted, then `maybePrune*()`.
`bootstrap()` dispatches the `servers` seed (all `"loading"`), launches every boot,
`await`s only the active server's (its failure rethrows into `Connected`'s existing
catch → toast → `loaded` anyway), and lets `Promise.allSettled` carry the rest into the
store as they land.

**Refresh loops**: `forEachServer(job)` — allSettled over `allServers()`, per-server
online/offline status dispatch, rethrow only the active server's failure (callers today
expect a throwable). `refreshSessions` / `refreshCatalog` / `refreshScheduled` /
`refreshProjects` / `refreshMcpServers` / `refreshSkills` / `refreshCommands` /
`refreshPersonas` become loops. Mutation tails that know the home server
(`createSession`, `deleteThread`, `changeThreadConfig`, `setConfigOption`,
`connectThread`'s respawn) call `refreshSessionsFor(server)` directly — one request, not N.

**Sweeps and pruning** (replaces `actions.ts:722-753`'s global sweep):

```ts
// inside refreshSessionsFor — every refresh, scoped by OWNERSHIP:
for (key of runtime keys)                        // liveThreads, journalCursors, backoff…
  if (sessionServerIdOf(key) === server.id && !reported.has(key)) dropThreadRuntime(key)

// gated — only when EVERY stored server has reported this page-load:
maybePruneDeviceStores()   // pruneDrafts/prunePins against the union + current drafts
maybePruneAgentOptions()   // pruneAgentOptions against per-server profile scopes
```

**Per-thread methods** — who talks to which server:

| Method | Change |
|---|---|
| `startThread` (`:663`) | gains a `server: ServerSettings` param; `new ThreadSocket(id, server, …)`; every caller passes the resolved home server |
| `reconnectThread` (`:165`) | fetch `?deleted=1` from `requireServer(sessionId)`, dispatch via `dispatchSessions` — the meta re-fetch was the captured active server |
| `connectThread` (`:767`) | resolve `serverOf(meta)` once; respawn POST and both `startThread` calls use it |
| `createSession` (`:618`) | POST to `serverOf(meta)` (drafts are stamped, §5 drafts); profile guard via `profileOf` (virtual-profile collision) |
| `changeThreadConfig` (`:571`) | config POST + refresh tail + fallback `startThread` on `serverOf(meta)` |
| `deleteThread` / `restoreThread` / `purgeThread` (`:1401-1428`) | `requireServer(sessionId)`; draft branches unchanged |
| `createSchedule` / `updateSchedule` / `cancelSchedule` | resolve the scheduled row's server via `serverOf(row)`; fallback active when unknown |
| `loadQuota` (`:888`) | `fetchQuota(serverOf(meta), …)`; profile via `profileOf` |
| `learnAgentOptions` (`:1049`) | signature unchanged; internally `serverForProject(projectId) ?? settings`, scoped `optionKey`, probe POST to that server |
| `makeCallbacks.onSessionConfig` (`:427`) | `saveAgentOptions` under the scoped key |
| `send`, `stop`, queue ops, `setMode`, `loadEarlier`, `reviveThread` | **no change** — they act through `liveThreads` / `createSession` / `reconnectThread`, which are now server-aware |

**Drafts**: `newDraftThread` stamps `serverId: opts.project.serverId ?? settings.id` and
calls `recordSession(id, serverId)` so `requireServer` works before creation.
`configureDraft` with a changed `projectId` resolves the new project's server and includes
`serverId` in `next`.

**`syncServers()`** — bound like `retryWaitingThreads` (`actions.ts:57-60`), wired via
`subscribeServers`: a removed server's runtime is dropped (server-map ownership walk),
`forgetServer(id)`, report maps cleared, `forget-server` dispatched; an added server gets
`bootServer`. Another tab changing `activeId` is deliberately inert (active only gates
settings surfaces; this tab keeps its `Connected` until its own reload). The
visibility/online listeners additionally retry servers not in `bootedServers`, throttled
by the existing `CATALOG_REFRESH_MIN_MS`.

### 6. `client/src/lib/agent-options.ts` — server-scoped keys

The device cache is keyed `<profileId>:<agentId>`, which collides across servers exactly
for virtual profiles (`default:claude-code` on A and B would share one probe answer, and
the second server would never be asked). `optionKey(serverId, profileId, agentId)` —
serverId **first and required**, so `tsc` flags every stale call site (actions.ts ×2,
`draft-config.tsx:234-238`, `session-config.tsx:74-77`). `dropAgentOptions(serverId, profileId)`
(`settings/profiles.tsx:177` passes `profile.serverId`); `pruneAgentOptions` takes
`${serverId}:${profileId}` scopes. Legacy un-scoped keys match no scope and drain the
first time the gate opens — it is a cache; losing it costs one probe.

### 7. Push, notifications, App

- `push.ts`: add `setupPushAll()` = loop `loadServers()`; internals untouched.
- Call sites → `setupPushAll()`: `App.tsx` boot chain (`.then(() => setupPushAll())`),
  the Enable action in `notifications.ts:147-150`, `settings/notifications.tsx` enable;
  the disable path loops `teardownPush` over all servers.
- `App.tsx` otherwise unchanged: store above `Connected`, `key={settings.id}` stays,
  the boot effect awaits `actions.bootstrap()` (active-gated) exactly as today.

### 8. Ambient modules — per-entity resolution

| File | Change |
|---|---|
| `lib/workspace/fs-api.ts`, `git-api.ts`, `terminals.ts`, `knowledge-api.ts`, `previews.ts`, `project-stats.ts` | the private `server()` helper becomes `server(projectId)` → `serverForProject(projectId)` (same `ApiError({status: 0})` on null). Every exported fn already takes `projectId` first — no public signatures move. `knowledge-api.listAllKnowledge` stays `loadSettings()` (Settings › Knowledge is an active-server page; say so in a comment) |
| `lib/workspace/watch.ts:56` | `loadSettings()` → `serverForProject(projectId)` inside the retry loop (re-resolving per retry is already the shape, so a forgotten server ends the stream) |
| `components/workspace/terminal-panel.tsx:104,220` | both → `serverForProject(projectId)`; line 220 is the "running on …" label, which must name the project's server |
| `components/tool-views.tsx:319` (`TaskProgress`) | resolve via `useThreadLinks()?.projectId` → `serverForProject(…) ?? loadSettings()`; effect deps gain `projectId`. `lib/task-events.ts` unchanged (explicit settings; keyed by transcript dir) |
| `lib/search.ts` | **fan out**: `SearchResult` gains `serverId`/`serverName`; allSettled over `loadServers()`, merge ordered by `at` (FTS rank is not comparable across servers), cap 30; all-failed rethrows the first reason (the search page keeps its error note), partial failure returns what answered; one abort signal covers all |
| `lib/import-sessions.ts` | stays active-server — coherent only with the import-threads.tsx filter in §9 |

### 9. Draft / new-thread flow — a draft is born on one server

- `lib/thread-defaults.ts`: `resolveThreadStart(defaults, profiles)` keeps its signature;
  the documented rule becomes "callers pass a profile list already scoped to the target
  project's server" — its degradation then lands right (a remembered server-A profile
  UUID misses the scoped list; the remembered *agent id*, deterministic on purpose, finds
  that server's profile; else the first profile). `ThreadDefaults` gains `serverId?`;
  `defaultsForProfile` takes `Pick<Profile, "id" | "serverId">` and answers `{}` on a
  server mismatch — a remembered model for A's `default:claude-code` must not cross onto
  B's identically-named virtual profile with a different catalog.
- `components/app-shell.tsx`: `startThread` (≈`:223`) and the route-adoption effect
  (≈`:160-184`) scope profiles with `onServer(state.profiles, rowServerId(project))`.
  **Adoption guard**: also require `state.servers.every(s => s.status !== "loading")`
  before adopting an unknown `/t/<id>` as a draft — a push deep-link for server B's
  thread must not become an empty draft while B is still bootstrapping; if B ends
  offline, adoption proceeds (the same answer a purged thread gets today). Header profile
  lookup (≈`:537`) via `findOn`.
- `components/thread-sidebar.tsx` `useStartThreadIn` (≈`:228-247`): scope profiles to the
  folder's project server.
- `components/draft-config.tsx`: catalogs via `useServerScoped(rowServerId(meta))`. The
  project picker keeps **all** projects — starting on another server is the feature —
  with `· <server>` in the hint when several are connected; picking a project on another
  server rebuilds the draft in **one** `configure`: re-resolve
  `resolveThreadStart({agentId: meta.agentId}, onServer(profiles, newServerId))` and send
  `{projectId, profileId, agentId, model: "", effort: "", personaId: "",
  mcpServerIds: [], skillIds: [], commandIds: []}` (the reducer re-stamps `serverId` and
  clears `configChoices`, §4).
- `components/session-config.tsx`: scope profile (virtual collision), agent (`liveConfig`
  gates the restart warnings and may differ per server version), `agentProfiles`,
  personas.
- `components/thread-tools.tsx`: profile via `findOn`; the three `section(…)` reads via
  `useServerScoped` — which also stops a draft linking a *foreign* server's library UUIDs
  into `POST /api/sessions`.
- `components/composer-status.tsx:92`: profile via `findOn` (drives `profileHasUsage`).
- `components/import-threads.tsx`: filter profiles/agents/projects/`projectByCwd` to the
  active server — what makes `import-sessions.ts` staying active-server coherent.

### 10. Unified surfaces

- `components/thread-sidebar.tsx`: `multi = state.servers.length > 1`; pass
  `ProjectFolder` an optional `server={{ name, offline }}` resolved from `state.servers`
  by `rowServerId(project)`. No structural change — ROW/MENU/GROUP/TIER and the period
  grouping stay put.
- `components/sidebar/groups.tsx` (`ProjectFolder`): a tiny muted chip (`text-[10px]`,
  truncated, `title` = full name) between name and count, sharing the count's
  `group-hover/menu-item:opacity-0` gutter; offline = dimmed + small muted dot,
  `title="Server offline"`. Quiet on purpose: a server that never bootstrapped has no
  rows to mark, and its state lives on Settings › General.
- `components/sidebar/thread-row.tsx` (`ThreadInfoCard`): scope the agent + profile
  lookups; when multi, add a "Server" row after "Project" (name, `· offline` when so).
- `components/command-palette/`: `rows.tsx` `Meta` gains optional `server` (rendered
  `· {server}`); `root-page.tsx` recents pass it when multi, `startTarget`/`agentName`
  read scoped profiles, "Switch to <name>" → "**Make <name> primary**" (behavior
  unchanged: `setActiveServer` + reload), "Disconnect from this server" names the active
  server; `search-page.tsx` passes the fan-out's `serverName` through; `choice-pages.tsx`
  `ProjectsPage`/`StartPage` annotate project rows, `PersonaPage` scopes personas.
- `components/project-page.tsx`: header shows `· <server>` when multi; `RuntimesCard`
  agent/profile lookups scoped to `rowServerId(project)`; the Import button gated to
  active-server projects ("Importing runs on the primary server").
- `components/settings/general.tsx` (`ServersGroup`): "Connected" badge → "**Primary**";
  "Switch" → "Make primary" (still reloads); a per-row status dot from `state.servers`
  (online / offline / loading — the failure-display home); one sentence of copy: all
  listed servers are connected, the primary hosts settings, the library, imports and
  backups. **Behavioral fix**: `forget()` on a *non-active* server must now also
  `teardownPush(server)` (same timeout race) — under the unified view every stored server
  got a push registration, and the old "a stored-but-inactive server was never
  registered" comment stops being true.
- **Settings list pages filter to the active server** — the store now holds every
  server's catalogs and these pages edit the active one, so without the filter they show
  duplicates and rows their mutations cannot reach. One `onServer(rows, loadSettings()?.id)`
  each in `settings/profiles.tsx`, `agents.tsx`, `mcp.tsx`, `skills.tsx`, `commands.tsx`,
  `personas.tsx`, `projects.tsx`, `quota.tsx`.

### 11. Verified no-change list

`sw.ts` (deep links are `/t/<uuid>`; the race is guarded at the adoption site),
`thread-view.tsx` and the composer stack (speak only through `actions`),
`lib/quota.ts` / `lib/task-events.ts` / `lib/thread-socket.ts` (explicit settings),
`workspace/dock.tsx` + `buffers.ts` + `layout.ts` (keyed by active server; panels inside
reference UUIDs, so non-primary panels work in the primary's layout),
`lib/drafts.ts` / `lib/pins.ts` (UUID-keyed; only what actions pass changes),
`connect-screen.tsx`, `settings/backup.tsx`, `settings/library.tsx`,
`settings/knowledge.tsx`, `tasks-board/*` (active-server homes by contract),
scheduled-message UI (joins by session UUID; mutations resolve per row in actions).

## Edge cases

- **Active server offline at boot**: `boots[0]` rejects → existing toast, `loaded`
  anyway, other servers fill the store, active badge reads offline;
  visibility/online listeners retry never-booted servers.
- **Server removed while its threads are open**: `syncServers` closes its sockets by
  ownership, filters its rows; the open route keeps rendering its ThreadState; a
  reconnect fails with the ordinary transcript error.
- **Same backend stored twice**: `saveSettings` already dedupes by URL (`settings.ts:84`);
  hand-edited storage converges via `dedupeById` on sessions/projects/scheduled, one
  socket per session id; catalogs may list twice (cosmetic, accepted).
- **Draft on server B + reload**: adoption rebuilds from remembered defaults (project →
  B; the remembered agent id resolves against B's scoped profiles); the
  `defaults.serverId` guard keeps A's remembered model from crossing to B.
- **Pins/drafts of an offline server**: the prune gate parks until every server reports.

## Build order (each step keeps `pnpm exec tsc -b` green)

1. `settings.ts` — additive fields + `serverById`/`activeServerId`/`subscribeServers`.
2. `lib/server-map.ts`, `lib/server-scope.ts` — new leaf modules.
3. `agent-options.ts` + every `optionKey`/`dropAgentOptions` call site, one step.
4. `store.tsx` + `actions.ts` + `App.tsx` — one atomic step (the Action union and the
   `useActions` rework are one coupled unit; no green intermediate worth the churn).
5. `push.ts` (`setupPushAll`) + `notifications.ts` + `settings/notifications.tsx`.
6. Ambient modules (§8).
7. Draft flow (§9): thread-defaults → app-shell → sidebar hook → draft-config →
   session-config → thread-tools → composer-status → import-threads.
8. Settings pages' active filters + `general.tsx`.
9. Unified surfaces (§10).

## Verification

- `cd client && pnpm exec tsc -b` after steps 4, 6 and 9, and at the end.
- Audit: `grep -rn "loadSettings()" client/src` — every remaining hit must be on the
  allowed list (settings pages, import-sessions, buffers/dock keys, server-scope
  fallback, App.tsx/connect screen).
- No server-side changes; server tests untouched. No browser automation (per CLAUDE.md)
  — the user checks the UI. Suggested manual pass: run two dev servers (second one on
  another `DAEDALUS_PORT` with its own `data/`), add both in the client, then confirm:
  both servers' projects and threads listed, chips only when both are connected; open and
  continue a thread on the non-primary server; a new thread started inside a non-primary
  project runs on that server; palette search answers from both; killing one server marks
  it offline without disturbing the other's threads; pins and drafts survive while a
  server is down and prune only once both are back.
