# Daedalus Harness — Dockview IDE workspace

## Goal
Grow Dockview from a thread switcher into a development workspace: threads plus files, editors,
diffs, terminals, source control, previews, diagnostics and process output. The server stays the
authority for project files and processes — the configured `cwd` and every agent process live
there, not in the browser. The client owns panel composition and presentation, and nothing more.

## Where this starts from
`client/src/components/session-dock.tsx` is ~300 lines and already holds most of the foundation,
which the phases below extend rather than invent:

- `DockviewReact` with a **one-entry component map** (`chat`), `defaultTabComponent={SessionTab}`,
  `disableFloatingGroups`, and `defaultRenderer="always"` — every opened transcript stays mounted,
  which is why thread keys are gated on `currentThreadId(location)` (see `lib/shortcuts.ts`).
- `useSessionDock()` exposes `openChat`, `onReady`, `pruneMissingSessions` and an `apiRef`, wired in
  `app-shell.tsx`. Route → panel and panel → route already round-trip: `onDidActivePanelChange`
  calls `navigateTo(threadPath(id), { replace: true })`, and the route effect calls `openChat`.
- Panel ids are already `thread:{sessionId}`, so reopening a thread focuses the existing panel —
  **that id is what enforces "one ACP connection per thread"**, not a separate guard.
- `lib/session-tabs.ts` is a one-shot flag (`markNewTab`/`consumeNewTab`) that tells `openChat`
  whether to replace the current tab or add one beside it.
- Layout persists to the **global** key `daedalus.sessionDock.v1`, debounced 300 ms, restored in
  `onReady` with a bare `try/catch`.
- Tab chrome hides itself when there is exactly one group and one panel; `SessionTab` carries a
  context menu (close / close others / close to the right / copy link).
- `Cmd/Ctrl+1..9` is bound **inside `session-dock.tsx` on `window`**, not through
  `hooks/use-hotkey.ts`, though `SHORTCUTS` does list it.

## Decisions
- **Dockview becomes a generic panel host.** `chat` is one registered panel type, not the special
  case the component map makes it today.
- **The layout is per server; panels are per project.** This is the correction the first draft of
  this plan got wrong: the dock is *already* cross-project — the sidebar groups threads by project
  and any mix of them can be open at once, and there is no "active project" anywhere in the client.
  A project-scoped layout key would have to close threads on a project switch that never happens.
  So: one saved layout per connected server, each non-chat panel carries its own `projectId`, and
  the **workspace context** — what "new terminal" or "toggle explorer" acts on — is derived from the
  active chat panel's project. A layout may legitimately hold two projects' explorers side by side.
- **Project scoping is an authorization rule, not a layout rule.** A path, PTY or Git call is
  authorized against the `projectId` in the request, resolved server-side against that project's
  `cwd`. Cross-project leakage is a server bug, and the client cannot cause one.
- Web and Electron use the same server APIs. Electron-specific browser embedding is an optional
  capability layered on top, never a second workspace implementation.
- "IDE" is a saved layout composed from panels, not its own panel type.
- **Duplicate views must not mean duplicate ACP connections.** Only the chat panel owns a thread
  connection; every other panel observes the existing store.
- **Anything the server persists goes in SQLite via Drizzle** (`server/src/db/`) — saved previews,
  detached terminals, workspace preferences. `data/config.json` stays the bootstrap-only holdout.
  Schema change means `pnpm db:generate` and a committed migration; never `drizzle-kit push`.

## Panel registry and identities
Replace the hardcoded `chat` map with a typed panel registry. The first draft of this plan listed
ten panel types, several of which were the same surface twice. **A panel type is an interaction
surface, not a data source** — merge when the chrome and the gestures are identical and only the
content differs; keep separate when the user does a different kind of thing. That leaves seven:

| Type | Absorbs | Modes / params |
| --- | --- | --- |
| `chat` | — | `sessionId` |
| `explorer` | — | `projectId` |
| `editor` | `diff`, image/Markdown/JSON preview, binary and large-file fallbacks | `mode: "text" \| "diff" \| "preview" \| "unsupported"` |
| `terminal` | — | `projectId`, `terminalId` |
| `source-control` | — | `projectId` |
| `web` | `preview`, `browser` | `trust: "project" \| "external"` |
| `output` | `problems` | source filter; records carry an optional location |

Why each merge:

- **`diff` and the previews fold into `editor`.** A diff is a way of looking at a file, not another
  kind of thing to look at — same Monaco package, same file identity, same dirty/save/conflict
  rules, and "compare with…" should be a view toggle you can flip back out of, not a second tab you
  have to close. Image, Markdown, JSON, binary and too-large are the same argument: they are what
  the editor does when the bytes are not editable text, and each still needs the editor's
  open-as-text and reveal-in-explorer actions. One panel means those states cannot drift apart.
- **`preview` and `browser` fold into `web`.** Identical chrome — URL bar, back, forward, reload,
  open externally, viewport presets — differing only in trust. Merging is what makes the security
  model *safer*, not looser: a project preview whose page navigates to a third-party origin has to
  become external-trust anyway, and with two panel types that transition has nowhere to go. One
  type, one hardened surface, `trust` as a param the panel cannot raise on its own. External trust
  carries no `projectId` and never sees a Daedalus token, preload bridge or cookie.
- **`problems` folds into `output`.** Both are bounded, searchable, source-labelled append-only
  streams; a problem is just an output record that parsed into `{relativePath, line, column,
  severity}`. Problems is therefore a *filter* — "records with a location" — not a second panel with
  its own buffer, its own cap and its own clear button. It also means a compiler's raw output and
  its diagnostics can never disagree, because they are one buffer read two ways.

Why `source-control` does **not** fold into `explorer`, even though both list project files: a tree
is navigation — hierarchy, lazy expansion, open — and source control is a working set with staging,
discard and a commit box. Different gestures on a different unit of work. What people mean by
wanting them together is *stacking*, and Dockview already gives that for free: a group is a tab
strip, so the IDE layout puts explorer and source control in the same left group. Merging panels to
achieve stacking would be solving a layout problem in the component tree.

Ids stay stable so reopening a resource focuses rather than duplicates:

```text
thread:{sessionId}
explorer:{projectId}
editor:{projectId}:{relativePath}
editor:{projectId}:{relativePath}:{comparison}
terminal:{projectId}:{terminalId}
source-control:{projectId}
web:{projectId}:{previewId}
web:external:{browserId}
output:{projectId}
```

The two `editor` ids are one panel type with two identities on purpose: a file and a comparison of
that file are separately openable and separately closeable, while `mode` still lets a single panel
toggle between them. Singletons per project: explorer, source control, output. Multiple instances
where the resource identity differs: editors, terminals, web panels, chats.

Panel `params` are persisted verbatim by `api.toJSON()`, so they are a **schema**: only ids and
plain data, never live objects, and every field must survive a reload and a server restart. `trust`
is part of that schema, so a restored layout must re-derive it rather than trust the stored value.

## Phase 1 — Workspace foundation

### Dockview lifecycle
- Typed panel descriptors, plus centralized helpers for open, focus, split, close and restore.
  `openChat` becomes `openPanel(descriptor, { newTab })` with the current replace-or-add behavior
  preserved for chat.
- Explicit commands: open right, open below, maximize/restore group, close group, stack all, reset
  layout, reopen last closed panel. Keep drag-and-drop; expose the same actions through the tab menu
  and `components/command-palette.tsx` so they are discoverable without a mouse gesture.
- Per-panel close rules. A dirty editor confirms via `components/confirm-dialog.tsx`; a terminal's
  close behavior depends on whether a live process remains (see Phase 5).
- Every panel renders its own empty, loading, disconnected, missing-project, missing-file and
  unsupported-panel states. Failures that belong to a *thread* still go in the thread
  (`actions.recordError`); failures that belong to a *panel* render in the panel; only transient
  action failures become toasts, through `reportError(err, context)` — never `String(err)`.
- `pruneMissingSessions` generalizes to a prune over all panel types: drop a panel whose project or
  session no longer exists, and drop unknown component names, **without discarding the rest of the
  layout**. Today's bare `catch {}` around `fromJSON` throws away the whole layout on one bad panel.

### Persistence
`daedalus.sessionDock.v1` is global; replace it with `daedalus.dock.v2:{serverId}` (`serverId` from
`lib/settings.ts`, which already keys multiple connections). Migrate v1 chat panels into the active
server's v2 layout once, then leave the old key alone. Unknown or invalid panels are pruned
individually.

Layout presets collapse the same way the panels did. Four presets were three descriptions of one
arrangement with a different tab focused, so there are two:

- **IDE** — explorer and source control stacked in a left group, threads and editors center,
  terminal and output stacked below. Review and monitoring are this layout with a different tab
  active, which is a click, not a preset.
- **Focus** — one maximized panel, everything else stacked behind it.

## Phase 2 — Secure workspace filesystem
`GET /api/fs/list` (`server/src/index.ts`) is unrestricted project-path autocomplete for the project
form. It is **not** the workspace file API and must not be reused as one. Add project-scoped routes
in a new module (not inline in `index.ts`):

```text
GET    /api/projects/:projectId/tree?path=
GET    /api/projects/:projectId/file?path=
PUT    /api/projects/:projectId/file?path=
POST   /api/projects/:projectId/files
PATCH  /api/projects/:projectId/files
DELETE /api/projects/:projectId/files
GET    /api/projects/:projectId/file-stat?path=
```

Requirements:
- Resolve every path against the project's configured `cwd`; normalize traversal and verify the
  **canonical** result is still under the **canonical** root (resolve the root once per request —
  the project's `cwd` can itself be a symlink).
- Define symlink behavior explicitly: a link resolving outside the root is neither readable nor
  writable through these routes.
- Return relative paths. An absolute server path is never part of the client contract.
- Bound directory entry counts, read sizes, write sizes and response bodies. Detect binary and
  oversized files and return structured metadata instead of invalid text.
- Atomic writes where practical; report stale writes against file version metadata (mtime+size, or
  a hash where correctness matters more than cost).
- Ignore `.git`, `node_modules` and build output by default, with a reveal-ignored toggle.
- One watcher per active project — never one per editor — emitting create/change/rename/delete with
  batching and an overflow-resync path.
- Every route throw becomes the `{ error }` shape via the existing `app.onError`.

## Phase 3 — File Explorer
- Lazy directory expansion and refresh; hidden/ignored toggles; filter and copy-relative-path.
- Create, rename and delete with confirmation.
- Reveal the active editor, and reveal files linked from agent tool calls (Phase 9).
- Context actions: open, open to side, compare, rename, delete, open in terminal.
- Decorations from source control and dirty-editor state.

Interaction: single click selects, Enter or double click opens; open reuses the existing editor for
the same project+path; open-to-side targets or creates an adjacent group; an external change updates
the tree without collapsing unrelated branches.

## Phase 4 — Editor (text, diff, preview, fallback)
One panel type, four modes.

**CodeMirror, not Monaco — the escape hatch above, taken, with the numbers.** Two things decided
it. Monaco does not support mobile browsers (upstream's own position, not a gap someone is
closing) and this client is a PWA people install on a phone. And "load it lazily" does not help
here: the service worker precaches `**/*.js`, so a lazy chunk is still downloaded and cached on
install by every user, including the ones who only ever read a transcript. Measured on this
build: precache went 2.64 MB → 3.06 MB with CodeMirror's core and merge view, while its ~117
syntax grammars (1.4 MB) are emitted under `assets/lang/` and **excluded** from the precache via
`globIgnores`, so they are fetched the first time you open a file of that language and degrade to
plain text offline. Monaco could not have made that trade at any size.

`mode: "text"` MVP:
- Syntax highlighting and language detection; editable and read-only modes.
- Find/replace, go to line, word wrap and the standard editor keys.
- Dirty indicator, save, save all, close protection.
- File version tracking with an external-change flow: compare, overwrite or reload.
- Unsaved buffers restored after a renderer reload, keyed by server+project+path and base version.
  (The PWA can reload a tab for a worker update, so this is not a rare path.)
- `mode: "unsupported"` for binary and too-large files — decided from `file-stat` **before**
  mounting Monaco at all, and still offering open-as-text and reveal-in-explorer.

`mode: "diff"` is the same panel with a `comparison` param (working tree vs staged, vs HEAD, vs an
agent's pre-edit content). Opening a comparison from an already-open file may either toggle that
panel's mode or open the `:{comparison}` id beside it — the command decides, the panel does not.
Save, dirty state and the conflict flow stay the editor's, so an editable diff cannot invent a
second set of rules. `components/ui/diff-view.tsx` (dependency-free line LCS) stays the renderer for
small agent diffs inline in the transcript; the editor panel uses Monaco's diff editor if it
navigates large diffs better.

`mode: "preview"` (image, Markdown, JSON) comes after text is stable, and is a renderer swap inside
the same panel — same title, same tab, same reveal and open-as-text actions.

## Phase 5 — Terminal
`xterm.js` in the client, `node-pty` on the server.

Server:
- Create PTYs with the project `cwd` and an explicit shell configuration.
- **A separate WebSocket endpoint, not the thread socket.** `server/src/protocol.ts` is a
  command/event protocol with a journal and replay semantics; terminal traffic is a raw byte stream
  that must never enter `session_events`. Authenticate it with the same bearer token, and authorize
  every frame against the terminal's project and owning connection.
- Propagate resize, input, output, exit code and process status.
- Bound concurrent terminals, output buffering, the reconnect window and idle lifetime — the
  `STDERR_TAIL_LINES` precedent in `sessions.ts` is the shape to follow, and a cap that truncates
  says so in the log.
- Clean up on explicit kill, project deletion, server shutdown and expired detached sessions.
- Never build a terminal or Git command by interpolating input into a shell string; argument arrays
  only.

Client:
- Multiple named terminals; resize propagated from Dockview layout changes.
- Clear, restart, kill, copy, paste, new terminal.
- Connected, reconnecting, exited and failed states.
- Say plainly that the shell runs on the Daedalus server, which may not be this machine.

Closing a panel and killing a process are separate: closing may detach for a bounded reconnect
window; killing is explicit.

## Phase 6 — Source control
Its own panel, but not its own diff viewer: every comparison it opens is an `editor` in `diff` mode
(Phase 4). Git through structured server endpoints, native argument arrays, the project `cwd`.

- Repository detection and current branch.
- Staged, modified, deleted, renamed, conflicted, ignored and untracked files.
- Working-tree and staged diffs.
- Stage, unstage, stage all, unstage all.
- Discard with confirmation and precise recovery messaging.
- Commit with validation, surfacing stdout/stderr.
- Branch list, checkout, create.
- Manual refresh plus invalidation from the Phase 2 watcher.

Every Git call gets a timeout, an output ceiling, cancellation behavior and a structured error. A
non-Git project renders an initialize/unsupported state, not a generic failure.

Comparisons open from source control, the explorer, editor conflict handling, agent tool-call edits
and transcript links — five callers, one panel type, so "open the working file" and "reveal the
originating transcript step" are implemented once rather than per entry point.

Stacked with the explorer in the IDE preset's left group, per the registry note: the sidebar people
picture is a Dockview group, not a merged component.

## Phase 7 — Web panel (project preview, then external)
One panel, two trust levels. Build `trust: "project"` first; it is the one people actually want, and
it is the one that can ship without the isolation review below.

### Project trust
- URL bar, back, forward, reload, open externally.
- Loading, TLS, connection and mixed-content error states — the last matters here, because the PWA
  is served over https (`pnpm dev:tunnel`) and an `http://localhost:5173` dev server framed inside
  it is blocked as mixed content. Say so in the panel rather than showing a blank frame.
- Desktop/tablet/mobile viewport presets at fixed dimensions.
- Per-project list of detected or saved preview URLs (SQLite).
- Optional linkage to the terminal or task running the dev server.

The web build uses a sandboxed iframe where framing and origin rules allow. A page that refuses
framing gets a direct, useful fallback. A server-side preview proxy is a separate feature and must
not become an unrestricted authenticated proxy.

### External trust
Later, separately permissioned, not on the critical path. Same component, same chrome; what changes
is that it carries no `projectId` and gets no Daedalus token, preload bridge or cookie. **A panel
can drop to external trust but never raise itself back** — navigating a project preview off its
origin demotes it, and the tab says so. That transition is the whole reason these are one type; two
types would have had to close one panel and open another mid-navigation, which is exactly when a
mistake would be invisible.

For Electron, evaluate a hardened surface: context isolation, no Node integration, no Daedalus
preload bridge, strict navigation and popup policy, explicit permission/download/certificate/
external-protocol handling, its own session partition. The shell's current behavior — external
links open in the system browser — stays the default until that model is reviewed. Do not enable
external trust before then; project trust is unaffected by the wait.

## Phase 8 — Output (with problems as a filter)
One project-scoped panel over one buffer of records:

```text
projectId, source, message, at, location?: { relativePath, line, column, severity }
```

Everything with a `location` is a problem; the panel's Problems view is that filter, and clicking a
record opens the file there via the editor panel. Raw output and diagnostics therefore cannot
disagree, and there is one cap, one search box and one clear button instead of two of each.

Sources can start with the background-task events already in `server/src/tasks.ts`, agent stderr
(`GET /api/sessions/:id/stderr`), and registered terminal streams; compilers, linters, tests and
preview consoles are later parsers that add a `location` to records they recognize. Keep the buffer
bounded and log when it truncates.

## Phase 9 — Thread and agent integration
- Open-file and reveal-file actions from transcript tool calls. The decoding stays in
  `lib/tools.ts`, which already quarantines every guess made about ACP's opaque
  `rawInput`/`rawOutput` — the workspace reads its normalized output and adds no vendor knowledge.
- Open agent edit results as an `editor` in `diff` mode; show source-control decorations after
  agent writes.
- Route background task progress to Output while keeping its transcript representation.
- Focus a waiting thread for a permission or elicitation **without** rearranging the layout.
- Tab status for running, waiting, complete, failed, dirty and externally changed.

## Commands and shortcuts
Palette actions: quick open, toggle explorer, toggle terminal, new terminal, source control,
web preview, output (and its problems filter), save, save all, split right/down, maximize/restore,
reset layout, reopen closed panel. Seven panel types keep this list short enough to stay readable —
that is part of what the merges buy.

**Every binding goes in `SHORTCUTS` in `client/src/lib/shortcuts.ts` and is bound through
`hooks/use-hotkey.ts`** — a key that is bound but not listed is a key nobody can discover. That
rules out most of the VS Code muscle memory, because the chords are taken:

| Chord | Today | Verdict |
| --- | --- | --- |
| `mod+k` | Command palette | Keep. There is no `mod+shift+p`. |
| `mod+b` | Toggle the sidebar | Keep. The explorer needs a different key. |
| `mod+n` | New thread | Keep. |
| `mod+1..9` | Jump to an open thread | Listed in `SHORTCUTS`, but bound inline in `session-dock.tsx`. Move it onto `use-hotkey` in Phase 1, and decide then whether it stays chat-only (and says so in its label) or becomes group-local panel switching. |
| `mod+w` | — | Do not take it. Electron gives it to close-window. |
| `esc` | Skip / reject / stop turn, in that order | Owned by `ThreadView.useThreadKeys`. A panel wanting Escape joins that chain; it does not bind its own. |

Left to allocate: toggle terminal, toggle explorer, quick open, save. Pick them against the table
above, not against VS Code, and add each row to `SHORTCUTS` in the same commit that binds it.

## Verification
`pnpm exec tsc -b` (client) and `pnpm exec tsc --noEmit && pnpm test` (server) green at the end of
every phase. **No browser automation or screenshots** — project convention; the user checks the UI.

Automated:
- Project-root traversal and symlink-escape tests; cross-project and cross-server isolation.
- Bounded reads, writes and listings; atomic save and stale-write conflicts.
- Watcher batching, rename, overflow and recovery.
- Git status parsing, timeouts, failures and destructive operations.
- PTY create, resize, detach, reconnect, exit and cleanup.
- Layout migration (v1 → v2), invalid-panel pruning, reset, and `trust` re-derivation on restore.
- Dirty-editor close and renderer-reload recovery.
- Preview URL validation and browser navigation policy.

Manual checklist:
- Web and Electron; light/dark and vibrancy/acrylic; narrow and wide layouts.
- Keyboard-only and screen-reader navigation.
- Large repositories, files, diffs and output streams.
- Server reconnect/restart with editors and terminals open.
- Project rename, `cwd` change, deletion; unavailable server.
- Threads from two projects open at once, each with its own explorer.

## Status
Milestones 1–5 are implemented. What landed differently from the plan above, and why, is
recorded inline in the phase it belongs to — the editor is CodeMirror rather than Monaco
(Phase 4), and external web trust is built but gated behind a flag pending its isolation
review (Phase 7). Remaining from Milestone 5's hardening list: the accessibility and
performance passes, and the large-repository/reconnect manual checks.

## Build order and milestones
Sequential; each milestone is shippable on its own.

1. **Useful workspace** — panel registry, per-server layout persistence and migration, layout
   commands and the IDE preset, secure tree/read APIs, explorer, read-only `editor` with its
   unsupported-mode fallback.
2. **Editing** — writes and conflict detection, Monaco, dirty buffers, save/save all, buffer
   restore, watcher sync, then `diff` and `preview` modes on the same panel.
3. **Developer tools** — PTY service and terminal panel, Git status/staging/commit, the output
   panel and its problems filter.
4. **Runtime preview** — `web` at project trust, viewport controls, terminal linkage. External
   trust only after its isolation review, and only if project trust does not cover the need.
5. **Agent integration and hardening** — transcript→file/diff navigation, agent edit and task sync,
   panel status, then the security/accessibility/performance/reconnect/migration passes.

## Critical files
- Refactor: `client/src/components/session-dock.tsx`, `client/src/components/app-shell.tsx`,
  `client/src/components/command-palette.tsx`, `client/src/lib/shortcuts.ts`,
  `client/src/lib/session-tabs.ts`.
- Add: `client/src/components/workspace/`, `client/src/lib/workspace/`; server modules for workspace
  filesystem, Git, PTYs and preview discovery — **new files, not more of `server/src/index.ts`**.
- Extend: `client/src/lib/settings.ts`, `server/src/db/schema.ts` (+ generated migration).
- Reuse: `client/src/components/ui/diff-view.tsx`, `client/src/lib/errors.ts`,
  `client/src/lib/tools.ts`, `client/src/hooks/use-hotkey.ts`, `server/src/tasks.ts`,
  `server/src/projects.ts`, `server/src/fs.ts`, and `app.onError`.
