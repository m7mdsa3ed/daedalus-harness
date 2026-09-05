# Daedalus Harness

Generic ACP (Agent Client Protocol) harness. Four parts, one repo.

This file is the **rules only**, kept short because it is read on every turn. The mechanism
and the reasoning — the failure each rule was written for — live in `docs/`, linked per
section. **Read the linked file before changing the behaviour a rule describes**; every one
of them cost a bug. `CLAUDE.md` is a symlink to this file.

## The four parts → `docs/architecture.md`

- **`server/` is the ACP client** (Node 22 + Hono + ws): one agent process per thread, one
  `AcpBridge` (`src/acp-bridge.ts`) per process, derived state to the browser over a
  WebSocket (`src/protocol.ts`). It owns profiles (provider config + the MCP/skill/command
  links its threads get), projects (a cwd and a name — nothing linked), the library, personas,
  bearer auth, the event log and FCM push. `data/` holds secrets — gitignored, never commit.
- **Storage is SQLite via Drizzle** (`server/src/db/`), better-sqlite3, synchronous because
  spawn paths are. Every query goes through the `db` exported by `db/index.ts`. Links are join
  tables with `ON DELETE CASCADE`, so a dangling id cannot exist and nothing filters for one.
  `data/config.json` is the deliberate holdout: bootstrap only, needed before any database.
- **`client/`** — Vite + React 19 + Tailwind v4 + shadcn on **Base UI, NOT Radix**: compose
  triggers with `render={...}` not `asChild`; `SelectValue` needs explicit children. **The
  browser does not speak ACP** — `src/lib/thread-socket.ts` is a plain WebSocket and
  `@agentclientprotocol/sdk` is a devDependency, imported type-only.
- **`agent/` is the harness's own ACP runtime** (id `daedalus`): a loop on the Vercel AI SDK,
  OpenAI-compatible chat completions only, configured entirely through `DAEDALUS_AGENT_*` env
  from the profile (the literal `"null"` means unset). It reads the repo's
  `AGENT.md`/`AGENTS.md`/`CLAUDE.md` on **every turn**. Its own guide is `agent/docs/`.
- **No build-time client config**: server URL and token are entered at runtime.

## Commands

- Server `cd server && pnpm dev` (prints token) / `pnpm test`. Client `cd client && pnpm dev`
  / `build` / `electron:dev` / `electron:dist:win`. Agent `cd agent && pnpm test`.
- Typecheck `pnpm exec tsc -b` (client), `pnpm exec tsc --noEmit` (server).
- `tsconfig` uses `erasableSyntaxOnly` — no TS constructor parameter properties.
- eslint crashes at startup (typescript-eslint vs typescript 7 — pre-existing).
- **Schema change: edit `server/src/db/schema.ts`, run `pnpm db:push`.** No migration files
  exist. **A table push does not know about is a table push drops** — anything the server
  reads must be declared there. The FTS5 index is the one exception.
- **Agents spawn by their globally installed binary, never `npx`** (~0.4s vs ~3.2s, and a
  thread spawns on create, revive and every profile/model change). codex-acp **≥ 1.7.0**.
  Seeding backfills new fields but **never** replaces name/command/args/env — those are the
  user's.
- **Whether an agent is installed is measured, never assumed** (`server/src/agent-status.ts`),
  and versions come from the ACP `initialize` answer, never a parsed `--version`.
- **Deployed built, not with tsx**: `pnpm pm2:start` builds, pushes the schema and starts on
  port **4001** from `DAEDALUS_PORT` (env wins over `data/config.json` for `host`/`port` and
  only those). One instance, fork mode.
- **The PWA needs https, so dev has `pnpm dev:tunnel`.** It does not start the server, and
  while it runs both ports are public behind only the bearer token.

## Protocol and transport → `docs/protocol.md`

- **The server is the ACP client; the browser is a subscriber.** Nothing but the bridge may
  attach a `data` listener to the child's stdout. Commands get exactly one `reply`; events fan
  out minus the peer that caused them. **The server never interprets a `session/update`.**
- **Four kinds are journaled and replayed** — `update`, `session_config`, `turn_started`,
  `turn_ended`; the rest are live-only. **A permission or elicitation is never journaled** —
  it lives in `bridge.pending` while the agent blocks. First answer wins.
- **A thread is opened over HTTP, and a socket is opened by an outgoing message and by
  nothing else.** Replay and the socket are one code path through the same `handle` switch —
  one parser, one set of callbacks. `ready()` is the one door to a live socket. **A dropped
  socket reattaches on its own, and never respawns**: a close that says nothing about the
  thread (no code, 1006, the client's own watchdog) books the ladder, which asks for the
  thread *as it is* — a live process gets its socket, a retired one is read from its
  journal. Only a send or the button puts a process back. The four codes that mean the
  thread is gone or taken over (4000/4001/4002/4004) are still said once, with a button.
- **The ACP SDK is named in one file per half** — `server/src/acp.ts`, `agent/src/acp.ts`,
  the client's `@daedalus/acp`. Import `acp` from there, never from the package. The version
  is pinned exactly in all three manifests.
- **`session_config` is absolute — never make it a delta.** Replay start is *stated* on
  `attached`, never inferred. **Windows and `load_earlier` pages are counted in steps
  (turns), never events.** Thread-scoped callbacks go through `send`, never `dispatch`.
- **ACP schema is the source for modes, config options and usage** — render generically,
  never hardcode per-agent knowledge in the client.
- **The client mints session ids and threads start as drafts**: no row and no agent until the
  first message, so anything treating the server's list as authoritative must let drafts
  through.
- **An agent's session id is earned, not announced** (`acp_session_provisional`): only a
  *proven* id may replace a proven one. **The journal is a cache for reading, never a source
  for resuming** — a revive is always `session/load`.
- **Importing a thread writes a pointer, never a transcript.** Listing is ACP's
  `session/list`, never a runtime's files.
- **A capability we don't advertise is a feature the agent turns off.** Questions arrive as
  `elicitation/create`, not permission requests; narrow with
  `isFormElicitation`/`isUrlElicitation`, never `mode === "form"`.
- **ACP has no pause, so pause is the harness's own pair** (`_daedalus/session/pause`), taken
  only by our runtime, which holds at its next model step with nothing lost. A cancel clears
  the pause on both ends.
- **A failed turn is held at that same boundary, not ended** — the second reason the loop
  waits, and the same wait. **Any** failure holds, not a chosen list: an error part, a thrown
  call, and the finish reasons that mean the step did not do what was asked (`error`,
  `content-filter`, `length` — the first of which used to be reported as a clean `end_turn`).
  **A failed tool call is not one of them**: it goes back to the model, which is what it is
  for. It keeps every settled step, tells the harness why
  (`_daedalus/session/paused`, the pair's one agent→client direction), and waits for a model
  change and a resume. **A held turn is still `turnActive`**: no `turn_ended`, no error row,
  and `reason: "error"` on the absolute `paused` event is a state to draw, never a failure to
  record. **A thread with nobody in front of it never holds** (`DAEDALUS_AGENT_HOLD_ON_ERROR`,
  off for a workflow step or a scheduled run), because `whenTurnSettled` would wait forever.
  Subagents never hold: theirs would re-run every tool it already ran.
- **A failed attempt persists nothing it did not finish.** The JSONL is append-only, so the
  write is what is delayed — down to the last step whose tool calls all came back. An
  assistant message carrying a call with no result is what the next `session/load` hands back
  to a provider that rejects it.
- **Subagents: the store is flat, the transcript is a tree.** Ownership is resolved in one
  place and lands as `parentId`; consumers reading `thread.items` must ignore `parentId`
  items where the thread's own are meant. OpenCode's children are read off the side of the
  process, server-side — nothing downstream learns a fourth shape.
- Agent stderr is spliced into errors on the way out; every route throw becomes the
  `{ error }` shape the client parses.
- **Test agent** `server/test/fake-agent.mjs` (`fake-echo`) drives the UI without credentials
  (`pnpm fake:agent` writes its row). Samples are scenes; the default turn stays small,
  because a turn is what the replay window is measured in.

## Profiles, models, config, personas → `docs/profiles-and-config.md`

- **A profile is a provider, not an agent; a thread is a (profile, agent) pair.** The agent is
  chosen at draft time, lives on `sessions.agent_id`, and survives a respawn.
- **The profile decides who owns the model — and only the model and the effort.** Every other
  agent option passes through untouched and stays live.
- **Being env at spawn does not mean being env forever.** `POST /api/sessions/:id/config` is
  the one door; it answers `{live}` and falls through to respawn when it cannot. **Respawn is
  atomic and server-side**, never driven from the browser.
- **A message typed into a running turn is queued, not steered — and the queue is the
  server's.** Steering is explicit (`prompt {steer:true}`, ⌘⇧Enter). The `queue` event is
  absolute and reaches every peer including the origin.
- **Claude Code reaches a profile's gateway through the harness's own shim**
  (`server/src/gateway-shim.ts`), which forwards byte for byte and makes exactly one repair.
  **The key in the path is the credential** — minted per boot, never stored.
- **A persona goes in through each runtime's own door** (`AgentDef.personaVia`); **nothing is
  pasted in front of the user's message**. Changing it always costs a respawn.
- **Every agent gets a virtual "Default" profile** (`default:<agentId>`) with no credentials
  and deliberately no models. Never written to `data/`, uneditable.
- **A draft cannot ask a process that does not exist**: option sets come from a live session
  or a cached one-shot probe, coalesced so two tabs cost one spawn.

## MCP, skills, commands, workflows → `docs/mcp-and-workflows.md`

- **MCP servers, skills and commands have two owners and the agent gets the union** (profile
  links, thread picks). All link tables go through the one helper `server/src/db/links.ts`.
- **Skills and commands are materialised into the project's cwd**, which every thread of the
  project shares — pass the union across every live thread in that cwd, never one thread's.
- **The harness's own MCP servers are library rows, not profile toggles** (`BUILTIN_MCP`); a
  tool that cannot answer is not advertised at all. **Disallowing a runtime's built-in
  equivalent must travel with an allow rule for the MCP namespace**, or Claude Code's
  auto-mode classifier reads the MCP call as circumvention and blocks it.
- **An HTTP MCP server that demands OAuth is fronted by a second shim, and the child never
  holds the token.** `mcp_servers.auth` is a **stored** answer, never a typed one; the
  callback route is unauthenticated by necessity, so **the `state` is the credential**.
- **Workflows are the harness's, not an agent's**, and a definition is **declarative JSON**,
  never a script. **Every step is a real thread** on the parent's own profile, agent, model,
  effort, persona and links. One level, never a tree. Nothing survives a restart.
- **A run pauses as a state, never as a cancel-and-restart**, and its clocks stand still. A
  restart ends a paused run as it ends a running one.

## Client and UI → `docs/client.md`

- **State has two owners, split by what moves it**: the reducer in `src/lib/store.tsx` holds
  what the *socket* writes; everything a *route* answers is TanStack Query
  (`src/lib/queries/`). One owner per slice, nothing mirrored; writes **invalidate** rather
  than re-read by hand. Thread-lifecycle side effects stay in `src/lib/actions.ts`.
- **Built-in themes are generated** — `pnpm themes` writes both the CSS and
  `src/lib/builtin-themes.ts`, and that table is the only place a built-in exists. Three
  gates run first (WCAG AA, no duplicate design signature, every preset value and font used).
  Radius steps are **multiples** of `--radius`, never offsets.
- **Reading a tool call is `lib/tools.ts`; drawing one is `components/tool-views.tsx`.** **No
  component matches on a vendor tool name** — a new runtime's tool is one file's edit. ACP
  `kind` decides the layout family only; web views match the tool's **leaf** name.
- **⌘K's root page never asks the server**; searching is a destination owning its own query,
  debounce and abort. Rows are data, not JSX, and cmdk's own filter is off.
- Device-local state lives in tiny stores (`lib/drafts.ts`, `lib/pins.ts`,
  `lib/view-options.ts`, `lib/keybindings.ts`) — how a transcript is drawn is the reader's
  property, not the conversation's.
- **Sidebar order and the period a row is filed under are `activityAt` — the last turn, never
  `createdAt`. Reading is not activity.** Pinned and Recents are shortcuts, not places.
- **Everything with a face is drawn by `components/entity-icon.tsx`.** No component draws a
  folder for a project.
- **The composer is `components/composer.tsx`: one card, two rows** — what *adds to* the
  message behind "+", what governs *how it sends* behind the chevron beside Send. Touch
  targets follow `useCoarsePointer` (the device); what Enter means follows `useIsMobile`
  (the width).
- **A slash command is either the agent's or the harness's and the composer draws one list**;
  the agent's shadows the harness's, and a draft is offered no harness commands. An `@`
  mention is text *and* a `resource_link`, added server-side only when it resolves inside cwd.
- **Every surface a caret can land in clears the soft keyboard.** The page does not resize
  when one opens (`overlays-content`), so a fixed surface at the bottom is a surface
  *behind* the keys. Ride it with a named recipe from `lib/keyboard-inset.ts` —
  `KEYBOARD_LIFT`, `KEYBOARD_CENTER`, `KEYBOARD_RISE`, `cn`'d last — never a fresh calc. A
  Base UI positioner is **padded, not moved** (`useKeyboardCollisionPadding`), and only
  where the visual viewport did not already shrink, or a flyout rises by two keyboards. A
  field on an ordinary form is `lib/keyboard-caret.ts`'s, because the browser's own
  scroll-into-view is the thing `overlays-content` turned off.
- **"Mobile" is two questions: width is the panel's, the pointer is the device's.** Layout
  uses the `@panel-*` container queries; touch targets and centred surfaces stay on media
  queries.
- **A key that is bound is a key that is listed and a key that can be moved.** Nothing reads
  `KEYS` to bind — use `useShortcut(id, handler)`; chords print through
  `components/shortcut.tsx` and nowhere else.
- **Errors are never `String(err)`** — normalize through `lib/errors.ts`. A failure belonging
  to a thread goes IN that thread; a surface with the user's attention holds its own; toasts
  are for failures with no surface to go back to. **An error a surface could render as
  emptiness must be rendered as an error.** Toasts only through `lib/toast.ts`.
- **The dock holds five panel kinds: chat, ide, terminal, web, tasks**, and **Monaco is the
  text surface and the diff and nothing else** — the official `monaco-editor`, so there is no
  workbench and no "initialize once per page" rule.
- **Source control starts from `GET …/git/repos`, never from "the project's git"**: a section
  per repository, and every read and write names its `repo`. **Status paths are
  repository-relative** — `projectPath(repo, path)` is the one join back to the file routes.
- **Monaco's workers are wired by `?worker` import, never by path**, and
  `MonacoEnvironment.getWorker` answers for **every** label while `getWorkerUrl` is never
  defined — a `?worker` import makes a stale path a build error instead of a blank editor.
- **A panel kind is a surface, and a surface that reads the URL cannot be one** — the board
  panel keeps "which board, which task" in its descriptor (`lib/tasks-location.ts`), never in
  the route. **What a panel is doing is data the panel publishes and the tab draws**
  (`lib/workspace/panel-status.ts`), never a glyph in its title. **A pinned tab is one every
  bulk close steps over** — its own Close still names it. **A preset rearranges what is open;
  a saved layout carries its contents**, which is why it is asked for by name. **A float is
  restored whole or not at all and a popout is never reopened**: its panels come home to the
  grid before the layout is counted.
- **The terminal panel's chrome is the product**: scrollback search, copy/paste, clear, type
  size and the key row. **Ctrl+C copies with a selection, interrupts without one**; **clear is
  the view, never the server's scrollback**; **an exited shell gets a new one, never a
  reconnect**. The bell and the shell's OSC title are how a terminal nobody is watching
  speaks — status and tab title.
- **Every colour handed to xterm is a hex, and its background is opaque**: the palettes are
  `oklch` (which xterm's parser drops) and `transparent` without `allowTransparency` is black
  — the two halves of "the terminal has no light mode". Re-read on the mode *and* the colour
  theme. **A keycap's label is its content, and an icon-only control carries a `title`.**
- **The helper key row follows the soft keyboard** (`--keyboard-inset`; the page does not
  resize, so a row at the bottom is a row *behind* the keyboard). It **wraps and stops at two
  rows** rather than scrolling sideways, with compact 28px caps — under the app's 44px touch
  target on purpose, because a keyboard of 44px keys covers the terminal it drives. **How a
  terminal is drawn is the device's** (`lib/workspace/terminal-prefs.ts`), and `keyRow: "auto"`
  asks the pointer, never the width.
- **How much of a panel the app header covers is measured, never assumed.** The dock sets
  `--dock-header-overlap` on each group for its tab strip; **a panel measures its own**
  `--dock-content-overlap` (`lib/workspace/panel-overlap.ts`), because `defaultRenderer="always"`
  renders panel content outside the group element, where nothing the dock sets can reach it.
  The old constant reserved the header's height in every group, including the ones nowhere near
  it — twice, in the strip's margin and the panel's own padding.
- **What is open inside the IDE is the IDE's state, never the dock's** (`lib/ide/editors.ts`,
  a module store). **`open.ts` and `editors.ts` name nothing from Monaco**, because every
  reader loads the transcript that imports them; Monaco is a dynamic import, excluded by
  chunk name from the service worker's precache.
- **A turn's changes are measured by git, never read off the transcript** — tree snapshots at
  `turn_started`/`turn_ended` through a scratch index; **the real index is never touched**.
  Staging, discarding and committing belong to the source-control view, because they act on
  the worktree as it is now and not on a scope.
- A project's own page reads its settled half from one `/stats` call, on mount and by Refresh
  and **never on a timer**. **Turns, not events**, are counted; a tile skeletons rather than
  zeroes. **Header carries a "Run" dropdown** for the project's custom helper commands
  (`project_helpers`). **A helper runs in a terminal panel, never in a dialog** — a saved
  shell line asks things, and only a PTY can be answered — so it has no timeout, its stored
  `cwd`/`env` are read server-side and never sent up, and `confirm` asks before the terminal
  exists.

## Tasks → `docs/tasks.md`

- **A board is a project of work, not a kanban**: it owns its key, columns, sprints, saved
  views and custom fields. **A column's `category` is what the harness knows** — everything
  counting "done" reads `completed_at`, never the column name. `wip_limit` is advisory.
- **The tree is `parent_id`**, same board only, never a descendant; deleting a parent
  *detaches*. Every change is written to `task_activity` — **history is recorded, not
  diffed**. **No foreign keys**; every cascade is by hand.
- `lib/tasks-view.ts` is the pure half; how a board is *read* is device-local, a *saved* view
  is the server's. Every view takes the one `ViewProps` contract and never touches the cache.

## PWA and notifications → `docs/pwa-and-notifications.md`

- **One service worker (`client/src/sw.ts`), and no Firebase inside it** — the browser
  restarts the worker per event, so only top-level code is guaranteed to have run. **The push
  payload is a contract: data-only**, carrying `title`/`body`/`sessionId`.
- Updates are `registerType: "prompt"`: the new worker only `skipWaiting()`s on the user's
  Reload.
- **Registering for push is reversible and the reverse must reach the server.**
- `new Notification()` is not available everywhere and push does not cover the gap; both paths
  build their options in `lib/notification-shape.ts`. In Electron the OS layer is Electron's
  own `Notification`, preferred with **no permission check**.
- **A backgrounded page is not a detached one, and only the page can say which it is**: only
  the turn-end push gate reads `watchers(session)` — fan-out, idle sweep and peer counts still
  count sockets. It is `freeze`/`resume`, not `visibilitychange`.

## Ops: git, backup, quota → `docs/ops.md`

- **A project is a directory, and a directory is not one git repository.** `server/src/git.ts`
  addresses a `RepoContext`, never "the project's git".
- **Backup is one JSON document and import is one transaction.** Never exported: the server
  token/host/port, the probe cache, `history_*` rows.
- **Subscription quota is read by asking the runtime's own CLI, out of band**, naming the
  plain CLI and never the ACP binary. **"No quota" is an answer, not a failure** — never a
  zeroed bar.
- **The provider's plan is read from the profile, which outranks the agent's probe.** The
  adapter owns the endpoint; an unknown `kind` throws rather than falling through. Settings ›
  Usage is the only surface that lists plans.
- **A profile preset is a starting point, never a stored kind**: nothing about it is saved on
  the profile.

## Testing

- **No visual testing**: don't drive the UI with Playwright/browser automation or take
  screenshots to check work. Verify with `tsc -b` and reasoning about the code; the user
  checks the UI.

## Where the detail lives

| File | Covers |
| --- | --- |
| `docs/architecture.md` | server, storage, the `agent/` runtime, agent registry/seeding, deploy, schema push, dev tunnel |
| `docs/protocol.md` | ACP bridge, thread open, replay/windowing, session ids, import, capabilities, subagents |
| `docs/profiles-and-config.md` | profiles, models, live reconfiguration, queue, gateway shim, personas, option probe |
| `docs/mcp-and-workflows.md` | built-in MCP rows, the MCP OAuth shim, workflows, link ownership |
| `docs/client.md` | state ownership, theming, palette, sidebar, tool views, shortcuts, errors, toasts, dock, project page |
| `docs/pwa-and-notifications.md` | service worker, FCM, notification shape, backgrounded pages |
| `docs/tasks.md` | boards, keys, columns and categories, the parent tree, activity, sprints, links, custom fields, views |
| `docs/ops.md` | git, backup/import, agent quota, provider plan usage |
| `agent/docs/` | the Daedalus Agent runtime: prompting, managing it from the harness, standalone use |
