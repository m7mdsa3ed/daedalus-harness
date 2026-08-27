# Daedalus Harness - Dockview IDE workspace

## Goal
Expand Dockview from a thread switcher into a project-scoped development workspace containing
threads, files, editors, diffs, terminals, source control, previews, diagnostics, and process
output. The server remains the authority for project files and processes; the client owns panel
composition and presentation.

## Decisions
- Dockview becomes a generic panel host. `chat` is one registered panel type, not a special-case
  workspace implementation.
- Workspace state is scoped by server and project. A terminal or file from one project must never
  appear under another project's layout or API authorization.
- Filesystem access, Git operations, PTYs, and preview proxying live on the server because the
  configured project `cwd` and agent processes live there.
- Web and Electron use the same server APIs. Electron-specific browser embedding is an optional
  capability layered on top, not a separate workspace implementation.
- "IDE" is a saved layout composed from panels, not its own panel type.
- Duplicate visual views must not create duplicate ACP connections. Workspace panels observe the
  existing thread store; only the chat panel owns the thread connection.

## Panel registry and identities
Replace the hardcoded `chat` component map in `client/src/components/session-dock.tsx` with a typed
panel registry. Initial panel types:

- `chat`
- `file-explorer`
- `editor`
- `diff`
- `terminal`
- `source-control`
- `preview`
- `browser`
- `problems`
- `output`

Use stable project-scoped ids so reopening a resource focuses the existing panel:

```text
thread:{sessionId}
explorer:{projectId}
editor:{projectId}:{relativePath}
diff:{projectId}:{relativePath}:{comparison}
terminal:{projectId}:{terminalId}
source-control:{projectId}
preview:{projectId}:{previewId}
browser:{browserId}
problems:{projectId}
output:{projectId}
```

Singleton panels: explorer, source control, problems, and output per project. Editors, diffs,
terminals, previews, browsers, and chats may have multiple instances where their resource identity
differs.

## Phase 1 - Workspace foundation

### Dockview lifecycle
- Introduce a typed panel descriptor and centralized helpers for open, focus, split, close, and
  restore.
- Add explicit commands for open right, open below, maximize/restore group, close group, stack all,
  reset layout, and reopen last closed panel.
- Keep drag-and-drop behavior, but expose the important layout actions through menus and the command
  palette.
- Define per-panel close rules. Dirty editors require confirmation; terminal close behavior depends
  on whether a live process remains.
- Render useful empty, loading, disconnected, missing-project, missing-file, and unsupported-panel
  states.

### Persistence
The current `daedalus.sessionDock.v1` key is global. Replace it with a versioned key containing the
active server and project identity. Migrate chat panels from the old layout when possible and drop
unknown or invalid panels without breaking the remaining layout.

Add layout presets:
- **Focus**: one maximized thread or editor.
- **Code**: explorer on the left, editor/thread center, terminal bottom.
- **Review**: thread and editor center, source control left, diff right.
- **Monitor**: multiple thread groups with output/problems below.

## Phase 2 - Secure workspace filesystem
The existing `/api/fs/list` endpoint is for unrestricted project-path autocomplete and should not
be reused as the workspace file API. Add project-scoped routes such as:

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
- Resolve every path relative to the project's configured `cwd`.
- Normalize traversal and verify canonical paths remain under the canonical project root.
- Define symlink behavior explicitly. A symlink resolving outside the root must not be readable or
  writable through workspace routes.
- Return relative paths to the client; do not make absolute server paths the client contract.
- Bound directory entry counts, file read sizes, write sizes, and response bodies.
- Detect binary and oversized files and return structured metadata instead of invalid text.
- Use atomic writes where practical and report stale-write conflicts using file version metadata.
- Ignore `.git`, `node_modules`, build output, and other configurable patterns by default while
  allowing users to reveal ignored content.
- Add a project watcher that emits create, change, rename, and delete events with batching and
  overflow recovery. Use one watcher per active project, not one watcher per editor.

## Phase 3 - File Explorer
Implement a project-scoped explorer with:
- Lazy directory expansion and refresh.
- File/folder creation, rename, and delete with confirmation.
- Hidden and ignored-file toggles.
- Search/filter and copy-relative-path actions.
- Reveal active editor and reveal files linked from agent tool calls.
- Context actions for open, open to side, compare, rename, delete, and open in terminal.
- File status decoration from source control and dirty-editor state.

Interaction rules:
- Single click selects; Enter or double click opens.
- Open reuses an existing editor for the same project/path.
- Open to side creates or targets an adjacent group.
- External file changes update the tree without collapsing unrelated branches.

## Phase 4 - Editor and file preview
Use Monaco for text editing unless bundle and runtime profiling demonstrates an unacceptable cost.
Load it lazily so chat-only users do not pay for the editor bundle.

MVP editor behavior:
- Syntax highlighting and language detection.
- Editable and read-only modes.
- Find/replace, go to line, selection, word wrap, and standard editor shortcuts.
- Dirty indicator, save, save all, and close protection.
- File version tracking and an external-change conflict flow: compare, overwrite, or reload.
- Restore unsaved buffers locally after renderer reload, keyed by server/project/path and base file
  version.
- Large-file and binary fallback panels rather than attempting to mount Monaco.

Add specialized previews for images, Markdown, JSON, and other safe formats after the text editor is
stable. Preview panels should still expose open-as-text and reveal-in-explorer actions.

Reuse or extend `client/src/components/ui/diff-view.tsx` for small agent diffs. Use Monaco's diff
editor for full-file and Git comparisons if it provides better navigation and large-diff behavior.

## Phase 5 - Terminal
Use `xterm.js` in the client and `node-pty` on the server.

Server responsibilities:
- Create PTYs with the project `cwd` and an explicit shell configuration.
- Authenticate the terminal WebSocket using the existing server connection credentials.
- Authorize every terminal against its project and owning client.
- Propagate resize, input, output, exit code, and process status.
- Limit concurrent terminals, output buffering, reconnect windows, and idle lifetime.
- Clean up on explicit kill, project deletion, server shutdown, and expired detached sessions.
- Never construct terminal or Git commands by interpolating untrusted input into a shell string.

Client responsibilities:
- Multiple named terminal panels.
- Resize propagation through Dockview layout changes.
- Clear, restart, kill, copy, paste, and open-new-terminal actions.
- Connected, reconnecting, exited, and failed states.
- A clear indication that the terminal runs on the remote Daedalus server, not necessarily on the
  user's browser machine.

Closing a panel and terminating a process are separate operations. Closing may detach during a
bounded reconnect window; killing must be explicit.

## Phase 6 - Source control and diffs
Implement Git through structured server endpoints using native Git argument arrays and the project
`cwd`.

MVP source-control capabilities:
- Repository detection and current branch.
- Staged, modified, deleted, renamed, conflicted, ignored, and untracked files.
- Open working-tree and staged diffs.
- Stage, unstage, stage all, and unstage all.
- Discard with confirmation and precise recovery messaging.
- Commit with validation and surfaced stdout/stderr.
- Branch list, checkout, and create branch.
- Manual refresh plus invalidation from project file-watch events.

Every Git operation needs a timeout, output ceiling, cancellation behavior, and structured error
response. Non-Git projects render an initialization/unsupported state rather than a generic error.

Diff panels can be opened from source control, explorer, editor conflict handling, agent tool-call
edits, and transcript file links. Selecting a diff file should support opening the working file and
revealing the originating transcript step when known.

## Phase 7 - Preview and browser

### Project preview
Build preview first. It targets project development servers and includes:
- URL input, back, forward, reload, and open externally.
- Loading, TLS, connection, and mixed-content error states.
- Desktop/tablet/mobile viewport presets using stable dimensions.
- A project list of detected or manually saved preview URLs.
- Optional output linkage to the terminal or task that owns the development server.

The web build may use a sandboxed iframe when framing and origin rules permit it. Cross-origin pages
that refuse framing should produce a direct, useful fallback rather than a blank panel. A server
preview proxy is a separate feature and must not become an unrestricted authenticated proxy.

### General browser
Treat general browsing as a later, separately permissioned panel. It must not share Daedalus tokens,
preload APIs, or privileged cookies with loaded pages.

For Electron, evaluate a hardened native web-content surface with:
- Context isolation and no Node integration.
- No Daedalus preload bridge.
- Strict navigation and popup policy.
- Explicit permission, download, certificate, and external-protocol handling.
- Separate session/storage partition where appropriate.

The existing Electron shell intentionally opens external links in the system browser. Preserve that
default until the browser panel's security model is complete.

## Phase 8 - Problems and Output
Create project-scoped panels for structured diagnostics and process output.

Problem records use a normalized shape:

```text
projectId, relativePath, line, column, severity, message, source
```

Clicking a problem opens the file at the referenced location. Inputs may later include compiler,
lint, test, terminal, preview-console, and agent outputs.

The Output panel can initially consume the existing background-task events from
`server/src/tasks.ts`, agent stderr, and explicitly registered terminal/task streams. Keep output
bounded, searchable, source-labelled, and clearable.

## Phase 9 - Thread and agent integration
- Open file and reveal file actions from transcript tool calls.
- Open agent edit results in a diff panel.
- Show source-control decorations after agent writes.
- Route background task progress to Output while retaining its transcript representation.
- Focus a waiting thread for permissions or elicitation without replacing the active workspace
  layout.
- Use the active thread's project as the default workspace context, while allowing several projects
  to retain independent saved layouts.
- Add tab status for running, waiting, complete, failed, dirty, and externally changed states.

## Commands and shortcuts
Add command-palette actions for quick open, toggle explorer, toggle terminal, new terminal, source
control, preview, problems, output, save, save all, split right/down, maximize/restore, reset layout,
and reopen closed panel.

Candidate shortcuts, subject to conflict review:

```text
Cmd/Ctrl+P         Quick open file
Cmd/Ctrl+Shift+P   Command palette
Cmd/Ctrl+`         Toggle terminal
Cmd/Ctrl+B         Toggle explorer
Cmd/Ctrl+S         Save file
Cmd/Ctrl+W         Close active panel
Cmd/Ctrl+\         Split editor
```

Existing `Cmd/Ctrl+1..9` thread switching needs a defined rule once non-chat panels exist: either
keep it thread-only and document that in accessible shortcut labels, or change it to group-local
panel switching.

## Verification

### Automated
- Project-root traversal and symlink escape tests.
- Cross-project and cross-server isolation tests.
- Bounded file read/write and directory listing tests.
- Atomic-save and stale-write conflict tests.
- File watcher batching, rename, overflow, and recovery tests.
- Git status parsing, timeout, failure, and destructive-operation tests.
- PTY creation, resize, detach, reconnect, exit, and cleanup tests.
- Dockview layout migration, invalid-panel pruning, and reset tests.
- Dirty editor close and renderer-reload recovery tests.
- Preview URL validation and browser navigation policy tests.

### Manual
- Web and Electron builds.
- Light/dark themes and Electron vibrancy/acrylic.
- Keyboard-only and screen-reader navigation.
- Narrow and wide Dockview layouts.
- Large repositories, files, diffs, and output streams.
- Server reconnect/restart with editors and terminals open.
- Project rename, cwd change, deletion, and unavailable server states.
- Multiple active threads editing the same project.

## Delivery milestones

### Milestone 1 - Useful workspace
- Panel registry and project-scoped layout persistence.
- Layout commands and Code preset.
- Secure file tree/read APIs.
- File Explorer.
- Read-only editor and basic file previews.

### Milestone 2 - Editing workflow
- File writes and conflict detection.
- Monaco editor, dirty buffers, save/save all, and restore.
- File watcher synchronization.
- Full diff panel.

### Milestone 3 - Developer tools
- PTY service and terminal panel.
- Git status, source-control panel, staging, and commits.
- Problems and Output panels.

### Milestone 4 - Runtime preview
- Project preview panel and viewport controls.
- Preview/terminal linkage.
- Hardened Electron browser panel only if the preview use case does not cover the product need.

### Milestone 5 - Agent integration and hardening
- Transcript-to-file/diff navigation.
- Agent edit and task synchronization.
- Panel status indicators and workspace commands.
- Security, accessibility, performance, reconnect, and migration verification.

## Build order
Implement sequentially: workspace foundation -> filesystem -> explorer -> editor -> terminal ->
source control/diff -> preview -> problems/output -> agent integration. Keep client and server type
checks green at every phase, and do not begin the general browser panel until its Electron/web
isolation model is explicitly reviewed.

## Critical files
- Refactor: `client/src/components/session-dock.tsx`, `client/src/components/app-shell.tsx`,
  `client/src/components/command-palette.tsx`.
- Add client workspace modules under `client/src/components/workspace/` and
  `client/src/lib/workspace/`.
- Extend: `client/src/lib/settings.ts`, `server/src/fs.ts`, `server/src/index.ts`.
- Add server modules for project workspace access, Git, PTYs, and preview discovery instead of
  growing `server/src/index.ts` with implementation details.
- Reuse: `client/src/components/ui/diff-view.tsx`, `server/src/tasks.ts`, project records from
  `server/src/projects.ts`, and existing API error handling patterns.
