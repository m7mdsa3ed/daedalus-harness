# Plan: a browser panel, and the harness's own browser MCP

Status: **partially shipped**: phases 0, 1 (with 1b) and 2, together. Phases 3 and 4 are not
built. Supersedes the removed CDP relay and `<webview>` Preview (`de49e8cd`, removed in
`032f5c36`). Server: `server/src/browsers.ts` (hosts, tabs, queue, screencast, viewers),
`browser-status.ts`, `browser-protocol.ts` (the wire contract, aliased into the client as
`@daedalus/browser-protocol`), `browser-mcp-tools.ts` (the tool catalogue), `browser-mcp.ts` (the
stdio child), `browser-agent.ts` (the tool handlers), `routes/browser.ts` (REST and `/bm`), the
`/browser` socket in `index.ts`, features `browserPanel`/`browserMcp`. Client:
`components/workspace/browser-panel.tsx`, `lib/workspace/browser-socket.ts`,
`lib/workspace/browser-input.ts`, `lib/tools/browser.ts`, `components/tool-views/browser.tsx`.
Tests: `server/test/browsers.test.ts` (`pnpm test:browsers`), `server/test/browser-mcp.test.ts`
(`pnpm test:browser-mcp`), `browser-input.check.mjs` and `lib/tools/browser.check.mjs`; the
real-Chrome cases ran, they did not skip. Docs: `docs/mcp-and-workflows.md` "Driving the browser"
(which replaced "Driving the preview"), `docs/client.md` "The Browser panel". Left open after
verification:

- the panel's touch input and the Pause agent badge were not exercised in a real browser (the
  verification was a no-UI smoke test against a real Chrome);
- `locateChrome()` stats the binary on every spawn that links `builtin:browser`
  (`sessions.ts`), uncached.

Deviations from the plan below:

- **Phases 1 and 2 shipped together**, not phase 1 first (open question 4).
- **The tool catalogue is its own module** (`browser-mcp-tools.ts`), read by both the stdio child
  and the `/bm` route, so the schema the model sees and the one the server validates cannot
  disagree. The handlers live in `browser-agent.ts`, not in `browser-mcp.ts`.
- **The token budget is asserted in characters** (the tool list under 8000 chars), not tokens.
- **`tabs.json` is the restore, unconditionally**: the spike showed Chrome's own session restore
  does nothing headless.
- **Dialogs are handled outside the queue's wait.** An action that opens `alert()` blocks in
  Chrome until answered, and the answer queued behind it froze the tab for good (found in
  review). `untilDialog` returns as soon as a dialog opens; it wraps `act`, `evaluate` and the
  panel's own input; the report uses the stored tab title instead of asking the frozen page; and
  `screenshot`/`wait_for` refuse while a dialog is open. Regression test in `browser-mcp.test.ts`.
- **A failed launch closes the Chrome it started**, through the same graceful-close-then-SIGKILL
  helper the normal close uses; before, an error after spawn left an untracked Chrome running.
- **A pending resize cannot be replaced by another viewer's input**, so two panels on one tab no
  longer drop a person's resize.
- **The soft keyboard is raised by a toolbar button**, not by the server reporting a focused
  editable element: a tap must not throw the keyboard over the page.
- **`browser_activity` is said once per thread per server boot** (the route's own set), and the
  client opens the panel once per dock mount, so a panel the reader closed stays closed.
- **The library row is thread-scoped and absent without Chrome**: the spawn checks
  `locateChrome()` and leaves the server out, rather than advertising tools that cannot answer.

## Goal

A real browser inside the harness that a person uses on its own, in a dock panel, from the PWA
and the desktop app alike, and that an agent can drive through the harness's own MCP server
(`builtin:browser`). The browser exists first; the agent is one more client of it.

## Why not what was there, and why not chrome-devtools-mcp

- **The webview is not coming back.** Electron's `<webview>` plus a CDP relay was desktop-only,
  and `chrome-devtools-mcp` could not drive it reliably (CHANGELOG, `032f5c36`). A server-side
  Chrome is the one shape that works in the PWA, on a phone and in Electron identically.
- **Our own MCP, not `chrome-devtools-mcp`.** Measured on this machine (1.10.1): the full server
  is 30 tools, ~26k chars, **~6.6k tokens in every thread that links it**; `--slim` is 3 tools
  and too thin to click anything. It is also a second CDP client the harness cannot see or
  coordinate with the panel, it reports usage to Google by default, and it would need a CDP
  relay with a key in front of a debugging port. Ours goes through the server, which already
  holds the browser: one input path, one tab model, and the panel can show what the agent does.
- **What we give up**: performance traces with insights, Lighthouse, heap snapshots, CrUX. If
  they are ever wanted, `chrome-devtools-mcp` can be attached to the same browser later as an
  opt-in library row (phase 4), never as the default.

## Shape

```
Browser panel ──/browser socket──┐
  (canvas, address bar, tabs)    │   screencast frames ↓   input ↑
                                 ▼
                        server/src/browsers.ts ──puppeteer-core (pipe)──▶ Chrome, one per project
                                 ▲                                         profile: data/browsers/<projectId>
Agent ──browser-mcp (stdio)──/bm/<key>/<sessionId>/<tool>──┘
```

- **One Chrome per project**, launched lazily (first panel open or first tool call), headless,
  with a persistent profile, so logins survive a relaunch and every thread of the project
  shares them. A profile directory is single-instance in Chrome, which is what makes "per
  project" one process and not one per panel.
- **`--remote-debugging-pipe`, never a port** (puppeteer `pipe: true`). No TCP listener exists,
  so no other local process can attach. This is the security property the old relay lacked.
- **The server holds the only CDP connection.** The panel and the MCP are both clients of
  `browsers.ts`, so input from each is serialised per tab, and the panel can draw the agent's
  actions.

## Server

### `server/src/browsers.ts` (modelled on `terminals.ts`)

```ts
interface BrowserHost {
  projectId: string
  browser: puppeteer.Browser | null   // null while not launched
  tabs: Map<string, Tab>              // keyed by CDP targetId
  viewers: Set<WebSocket>
  lastActivity: number                // viewer frame ack, input, or tool call
}
interface Tab {
  id: string; page: puppeteer.Page
  openedBy: "user" | { sessionId: string }
  queue: Mutex                        // one input stream per tab
  snapshot: { generation: number; handles: Map<string, ElementHandle> } | null
  console: Ring<ConsoleEntry>; network: Ring<RequestEntry>
  dialog: { type: string; message: string } | null
}
```

- **Bounded like terminals**: `MAX_BROWSERS` server-wide (4), idle close after 15 min with no
  viewer and no tool call (the profile stays, so nothing is lost but the open tabs), a minute
  sweep, `killProjectBrowsers` on project delete, every browser closed on shutdown.
- **Tabs survive a relaunch**: the open URLs are written to `data/browsers/<projectId>/tabs.json`
  on change and reopened on launch (unless the spike shows Chrome's own session restore works
  headless). Runtime state, like a terminal's, so it is not a database table.
- **Chrome is measured, never assumed** (`browser-status.ts`, like `agent-status.ts`): puppeteer's
  `computeSystemExecutablePath` for stable Chrome, overridable by `DAEDALUS_CHROME`; the version
  comes from `browser.version()`, not a parsed `--version`. No Chrome means no panel kind and no
  tools advertised (a tool that cannot answer is not advertised).
- **New dependency**: `puppeteer-core` in `server/` only. It downloads nothing.

### Viewer transport: `/browser?projectId=&token=` (beside `/terminal` in `index.ts`)

Not on the thread socket, for the reason terminals are not: a frame stream is not a journal.

- **Frames**: one `Page.startScreencast` per *watched* tab (JPEG, quality ~70, capped at the
  largest viewer's size × DPR), fanned to every viewer of that tab, `screencastFrameAck` sent
  once per frame, the last frame cached so a new viewer draws at once. Binary WS messages:
  a small header (tab id, metadata: offsetTop, pageScaleFactor, deviceWidth/Height) + JPEG.
- **State, absolute** (JSON): tabs (id, url, title, favicon, loading), the front tab per viewer,
  a pending dialog, and `agent` activity `{sessionId, tabId, action, rect}` for the overlay.
- **Commands in**: `navigate {url|back|forward|reload|stop}`, `tab {new|close|select}`,
  `viewport {width, height, dpr}` (debounced), `mouse`, `wheel`, `key`, `text` (IME commit and
  paste), `dialog {accept, promptText}`. Coordinates arrive in CSS pixels; the client does the
  mapping from frame metadata.
- **Viewport follows the panel** that last had input. An agent's `viewport` call wins until a
  person resizes or clicks Reset; the panel letterboxes rather than fighting it.

### The MCP: `server/src/browser-mcp.ts` + `server/src/routes/browser.ts`

- A thin stdio child exactly like `harness-mcp.ts`: it registers the tools and POSTs each call
  to `BROWSER_URL` = `/bm/<key>/<sessionId>` (`engine.browserUrlFor`, beside `harnessUrlFor`,
  resolved with `resolveCaller`). The route maps the thread to its project's browser. The child
  holds no CDP state, so **a server restart costs nothing to reconnect**: the next call relaunches
  the browser and the uids are simply stale (the error says "snapshot again").
- **The agent's tab**: each thread has a selected tab. The default is the tab in front of a
  viewer in that thread's dock, else the last one this thread selected, else a new tab. `tabId`
  is accepted everywhere, so several threads can work in one browser without stealing focus.
- **Tools (flat schemas, no `oneOf`)**, target **< 2k tokens** for the set, asserted in a test:

| Tool | Does |
|---|---|
| `tabs` | `list` / `new {url}` / `select` / `close` |
| `navigate` | `url`, or `back`/`forward`/`reload`; waits for settle; returns url, title, status and a snapshot |
| `snapshot` | accessibility tree as text, one line per node with a uid: `[3_12] button "Save"` |
| `act` | `click`/`dblclick`/`hover`/`fill`/`type`/`press`/`select`/`scroll`/`drag`/`dialog` on a `uid`; waits for settle; returns a snapshot unless `snapshot:false` |
| `screenshot` | the tab, or one `uid`; JPEG, downscaled to ≤1280px wide, as MCP image content |
| `evaluate` | a function body run in the page; JSON result. Annotated destructive so runtimes ask |
| `wait_for` | `text` or `uid` visible, with a timeout |
| `logs` | `console` / `network` / `errors` since a cursor, or one request's detail |
| `viewport` | width, height, mobile, or `reset` |

- **Snapshots** come from puppeteer's `page.accessibility.snapshot({interestingOnly: true})`; each
  node's `elementHandle()` is kept under a uid that embeds the snapshot generation, so a stale uid
  fails loudly instead of clicking the wrong element.
- **Settle wait** (the reliability of `chrome-devtools-mcp`, reimplemented): after an action,
  wait for a navigation it started, then network quiet (no request in flight for 500 ms, cap 3 s)
  and a DOM-stable frame, bounded at 10 s, and say in the result if the cap was hit.
- **Input goes through the tab's queue** and through puppeteer's `ElementHandle.click()`, which
  dispatches real `Input.*` events. The click is therefore visible in the stream, and each action
  fans an `agent` activity frame to the viewers.
- **Thread-facing signal**: the first tool call of a thread fans a live-only, absolute
  `browser_activity {projectId, tabId}` event to that thread's peers (a new `protocol.ts` kind,
  like `background`; nothing journals it). The server does not interpret a `session/update` to
  produce it. It comes from the route, which is the harness's own code.

### Library row

- `BUILTIN_MCP.browser` (`builtin:browser`), added to the `builtin` enum in `db/schema.ts` and
  `McpServerInputSchema`, and to `THREAD_SCOPED_BUILTINS` (it needs a thread to name its project).
  `pnpm db:push`.
- **Delete `library.ts:76`**, the boot-time `DELETE ... WHERE id = 'builtin:browser'` left from the
  removal, or the row is dropped on every start.
- Resolved in `sessions.ts` beside `harnessServer` (`browserServer(session, runner)`).

## Client

- **Panel kind** `browser` in `lib/workspace/panels.ts`:
  `{ kind: "browser"; projectId: string; viewId: string; tabId?: string }`, with an id, parse and
  restore case, a `PANEL_ICONS` entry (`GlobeIcon`), and a `PANEL_SPECS` entry so it is in every
  "open a panel" menu, ⌘K and the New tab page. `browser` added to `ThreadPanelKind` so a thread
  dock opens one (`open("browser", true)`).
- **`components/workspace/browser-panel.tsx`**: tab strip, back/forward/reload, address bar
  (typing a non-URL goes to the configured search, otherwise `https://` is assumed), a loading bar,
  the canvas, a dialog sheet, and the agent overlay (a ring on the action's rect plus a "<agent> is
  driving" badge). The badge has **Pause agent**, which is the existing `bridge.pause()` where
  `canPause`, and nothing drawn where not.
- **`lib/workspace/browser-socket.ts`**: the socket, one per panel. JPEG blob →
  `createImageBitmap` → canvas, dropping a frame if the last is still decoding.
- **`lib/workspace/browser-input.ts`**: pure mapping from canvas pointer to CSS pixels using the
  frame metadata, and DOM key events to CDP `key` (key, code, modifiers, text). `.check.mjs` beside
  it, like `tool-batches`.
- **Keyboard ownership**: while the canvas is focused, every key goes to the page except the
  harness's own chorded shortcuts (`lib/keybindings.ts`). IME and paste go through a hidden
  textarea as `text`.
- **Touch** (phase 1b): tap = click, one-finger drag = wheel, long press = right click; the
  on-screen keyboard opens when the server reports a focused editable element.
- **Auto-open**: on `browser_activity` the thread dock opens its browser panel once per thread
  (reuse), on the tab the agent is on. A View option can turn it off (device-local).
- **Tool views**: the readers in `lib/tools/` learn the browser server's leaf names (allowed:
  web views match the leaf name); `snapshot` folds to its first lines, `screenshot` draws the
  image it already carries, `act`/`navigate` draw as one line: verb, element, resulting URL.
- Gated on `useFeature("browserPanel")` and `useFeature("browserMcp")`.

## Phases

0. **Spike (gate, ~1 day)**: puppeteer-core with pipe against Chrome 151 headless, screencast into a
   canvas page, input round trip, AX snapshot → `elementHandle` → click, settle wait. Measure frame
   latency, fps while scrolling, and RSS per browser and per tab. Check headless session restore.
   **Stop and rethink** if the feel is not acceptable for everyday browsing.
1. **Browser panel, no agent**: `browsers.ts`, `browser-status.ts`, `/browser` socket, routes
   (`GET/POST/DELETE /api/projects/:id/browser/tabs`), the panel, feature `browserPanel`.
   1b: touch and the mobile keyboard.
2. **The MCP**: `browser-mcp.ts`, `/bm` route, library row, `browser_activity`, overlay and pause,
   tool views, feature `browserMcp`.
3. **Polish**: file chooser (`Page.setInterceptFileChooserDialog` → upload into the profile dir →
   `setFileInputFiles`), downloads into the project, "Open in browser panel" on transcript links,
   the project's dev URL as the new-tab page (`projects.preview_url` is still declared), the real
   DevTools frontend in a panel (`inspector.html` over a keyed relay).
4. **Optional**: `chrome-devtools-mcp` as an opt-in row attached to the same browser, for traces
   and Lighthouse.

Every phase: tests, docs (`docs/client.md`, rewrite "Driving the preview" in
`docs/mcp-and-workflows.md` and its `CLAUDE.md` rule), and a CHANGELOG line.

## Tests

- `server/test/browsers.test.ts` (`pnpm test:browsers`): cap and LRU eviction, idle sweep on a fake
  clock, project delete kills, tabs.json round trip; real-Chrome cases skip when none is installed.
- `server/test/browser-mcp.test.ts` (`pnpm test:browser-mcp`): tool list under the token budget; on a
  `data:` page, snapshot → `act click` → DOM changed; stale uid refused; settle wait returns after a
  navigation; wrong `/bm` key is a 404.
- `client/src/lib/workspace/browser-input.check.mjs`: coordinate and key mapping.

## Risks

- **A streamed browser feels like a stream.** Fine for apps, docs and forms; video and fast
  scrolling will be rough. The spike decides whether that is good enough.
- **The browser browses from the server's network.** On a remote server, `localhost` is the
  server's, which is ideal for a dev server running there and wrong for anything on the laptop.
  This adds no new reach: the same bearer token already opens a terminal on that machine. No
  extra URL blocking in v1; it is documented beside the terminal note.
- **Agents see the person's tabs** in a shared project browser. Acceptable while someone is
  watching; an isolated per-thread profile is a later toggle.
- **Memory**: roughly 200-400 MB per browser. Mitigated by lazy launch, the idle close and the cap.
- **Two writers on one tab** (a person typing while the agent acts) are serialised by the tab
  queue. They are not prevented; Pause agent is the control for that.

## Open questions (resolved)

1. **Scope: per project.** One Chrome and one profile per project, shared logins, like terminals.
2. **Children: yes.** A subagent or workflow step gets `builtin:browser` on its parent's project
   browser with its own selected tab. Unlike `agents`/`harness` it is a capability, not
   delegation (`sessions.ts`, where the spawn resolves `browserServer`).
3. **Project delete deletes the profile**, logins included
   (`killProjectBrowsers(id, { deleteProfile: true })` in `routes/workspace.ts`).
4. **Phases 1 and 2 shipped together.**
