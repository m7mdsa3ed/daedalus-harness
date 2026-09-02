# Build mode — templates, the managed dev server, the preview proxy

Build mode is the harness's Lovable / Bolt-style front door: pick a starter,
describe the app, and the agent builds it in a real directory on this host while
the running app is shown live beside the chat. Nothing here is a second runtime.
It is composed of things the harness already had — a project, a thread, a
persona, a pty terminal, a reverse proxy, the dock's web panel — plus three new
pieces: **templates**, a **dev-server manager**, and a **preview proxy** with an
injected **bridge script**. This file is the reasoning behind the rules in
`CLAUDE.md` › "Build mode".

## What the market does, and which half this is

Bolt.diy, Lovable, v0 and Replit Agent all share one loop: a system prompt that
says "build the whole thing, don't re-run the dev server", a preview iframe, and
a channel that hands runtime/build errors back to the model as a prompt ("Fix
this preview error"). They differ in *where the app runs* — WebContainers,
Vercel Sandbox, a Replit VM. Here the app runs as an ordinary process in an
ordinary directory, because that is what every other thread in the harness
works on: the agent's tools, git, the editor panel and the terminal panel all
already address a project cwd. What had to be built is only the part between
the process and the browser.

## Templates are a directory, not a table

`templates/<id>/` is checked into the repo; `template.json` is the manifest and
the one file that is not copied. Everything else is the starter, verbatim,
lockfile included (so the first install is a pnpm-store hit, seconds not
minutes). The manifest is small on purpose — `install`, `dev`, `check`, and
the card text — because the contract that matters is not in the manifest, it is
what every template must honour at runtime:

- The dev command reads `PORT` (listen on `127.0.0.1`, `strictPort`) and
  `BASE_PATH` (a prefix with leading and trailing slash). Every asset URL, API
  route and router basename lives under `BASE_PATH`; with it unset the app
  works at `/`.
- It ships `AGENTS.md` (and a `CLAUDE.md` that is `@AGENTS.md`) saying the
  harness owns the dev server: never start, stop or reconfigure it, never touch
  the port or base, use `import.meta.env.BASE_URL`, run `check` before
  finishing, commit after each completed change.

`plans/project-studio.md` designed templates as *git repos cloned by the agent*
in its first turn. That was rejected for Build mode for the reason a first turn
is expensive: a clone plus an install is a minute of the user watching a
terminal before anything is on screen. Copying a local directory and installing
from a committed lockfile is under ten seconds, and the harness — not the agent
— does it, so the agent's first turn is spent on the app.

**Scaffolding is the one write outside a project root**, and it follows the
rules the plan wrote for exactly this: the parent must be absolute and exist
(default `config.appsDir`, `~/daedalus-apps`), the target must not exist or
must be empty, symlinks are resolved and re-checked, failures are
`WorkspaceError`, and a directory the server created is removed if the project
row fails. Then `git init` and one commit ("Scaffold from …") so the agent's
first change is a diff, not a dump — best effort, a missing git is not fatal.

The starters are `react-hono` (Vite 8, React 19, Tailwind v4, a Hono API in
the same process through `@hono/vite-dev-server`, `hc<AppType>` for typed
calls, and the same `src/server.ts` serving `dist/` in production) and `react`
(the same without the server). Both were verified against the prefix contract
and the HMR upgrade before being committed. Note that `@hono/vite-dev-server`
tests `exclude` against the *raw* request URL, prefix included, and never falls
through to Vite once Hono has answered — which is why the template hands Hono
only `<BASE_PATH>api…` through a negative lookahead and lets Vite own the HTML,
the SPA fallback and the refresh preamble.

## The dev server is a terminal the harness owns

`server/src/dev-server.ts` does not spawn processes. It asks `terminals.ts`
for a terminal with `role: "dev"` (or `"install"`) and `pinned: true`, which
is why `terminals.ts` grew `role`, `pinned`, `tapTerminal` and `onTerminalExit`
in the first place: a dev server is the one terminal that must survive nobody
looking at it, and its output is something a module reads, not only a panel.
Being a terminal buys three things for free — the terminal panel can attach to
it ("Logs" is just `openPanel({ kind: "terminal", terminalId })`), a login
shell puts `pnpm` on PATH, and killing the pty ends the whole tree (the pty
delivers `SIGHUP` to the foreground process group; `pnpm dev` → `sh` → `node`
all go). **Never kill a dev server by command pattern** — this host runs many
Vite servers under pm2, and a `pkill -f vite` takes every one of them down.

One manager per project. `start` picks a free loopback port, runs the install
command first if `node_modules` is missing (state `installing`), then the dev
command with `PORT`, `HOST=127.0.0.1`, `BASE_PATH=/preview/<key>/<projectId>/`,
`BROWSER=none`; it is `starting` until `GET <BASE_PATH>` answers any status
(250ms poll, 90s timeout → `failed`), then `ready`. An exit is `exited` with
the code in `message`, or `failed` if it happened before ready. The status is
absolute (`DevStatus` in `protocol.ts`), pushed as NDJSON over
`/api/projects/:id/dev/events` the way the file watcher is, and the client
writes each line into one TanStack query that is deliberately **not persisted**
(`meta.persist: false`) — a dev server's state does not survive a reload of the
harness, so a cached "ready" would be a lie.

**Errors are read off the output.** A line matching the error pattern opens a
group; the lines that follow it in the same burst join it — Vite prints the
file, the code frame and the stack flush-left with single blank lines between
sections, so "indented means continuation" kept only the headline, and "a blank
line ends it" kept the headline and nothing else. A group ends on **two**
consecutive blank lines (the screen-clear before the next message) or a 400ms
quiet gap, capped at 40 lines, consecutive duplicates dropped, 20 kept per run,
all cleared on every (re)start so last run's failure never sits under this
run's preview.

Project delete calls `forgetDevServer` *before* `killProjectTerminals`, so the
exit is not reported as a crash; shutdown calls `stopAllDevServers()` for the
same reason. Nothing survives a restart — the port and the key are both gone.

## The preview proxy keeps the prefix

`/preview/<key>/<projectId>/…` is served outside `/api/*`, so it carries no
bearer auth: an iframe cannot send a header, so **the key in the path is the
credential**, minted per boot like `/gw/<key>/`, compared with `safeKeyEqual`,
never stored. It is what `DevStatus.url` carries, and the client resolves it
against the server origin at render time and never writes it into panel params
— a persisted layout must not hold a key that the next boot will reject.

Unlike `/ide/<key>/`, **the prefix is forwarded unchanged**. Vite cannot serve
relative asset paths: `/@vite/client` and `/src/main.tsx` are absolute under
`base`, so the app is told its `base` *is* the prefix and the proxy passes the
path through. That is also what makes HMR work with no network configuration in
the template: Vite's client derives protocol, host and port from the page URL
and uses `base` as the socket path, and its server accepts an upgrade only when
`pathname === base` (an upgrade to any other path is left hanging, never
answered). Behind the https tunnel the browser opens
`wss://<tunnel>/preview/<key>/<id>/?token=…` and the harness pipes it through.
Two headers matter: `Host` is rewritten to `127.0.0.1:<port>` on requests *and*
upgrades (Vite's `allowedHosts` check answers 403/400 otherwise — verified), and
`x-frame-options` / CSP `frame-ancestors` are dropped, for the same reason the
IDE proxy drops them. The transport — hop-by-hop rules, decoded-body headers,
the raw-socket upgrade pipe — is `reverse-proxy.ts`, shared with `ide-proxy.ts`;
what differs between the two is only prefix handling, `Location` rewriting and
the forwarded-host origin rule, and those stay in the wrappers.

When the manager is not `ready` the proxy answers 503 with a self-contained
page: "Starting…" that reloads itself every two seconds while `installing` /
`starting`, and a plain "not running" page otherwise (no reload loop — the
panel has the real controls). The page is what the iframe holds; it is not the
UI.

## The bridge is injected, not shipped

Every `text/html` response gets
`<script src="<prefix>__daedalus/bridge.js">` injected after `<head>`, and the
proxy serves that script itself (`preview-bridge.ts`, a string constant because
`tsc` emits only compiled sources into `dist/`). Injecting from the proxy rather
than from the template means the agent cannot break or forget it, and the same
bridge works for a project that was never scaffolded from a template but has a
`devCommand` set in its settings.

The iframe stays sandboxed **without `allow-same-origin`**. The preview is on
the harness's origin, and a same-origin frame could read the page's
localStorage — the bearer token. So the bridge's origin is opaque, and it
speaks only `postMessage`; the panel accepts a message only when
`event.source === iframe.contentWindow`. What crosses: `daedalus:ready` (the
in-app path, on load and on every `pushState`/`popstate` — the URL bar shows
the app's path, not the proxy's), `daedalus:error` (window `error` and
`unhandledrejection`, a `console.error` wrapper, and Vite's own `vite:error`
and `vite:ws:disconnect` through `createHotContext` imported from the served
`@vite/client`; identical messages within a second are dropped), and
`daedalus:pick` (the element picker: a fixed overlay for the hover outline —
never a style on the app's own nodes — plus a selector, the text, and the
nearest React component name read off the fiber). The parent sends
`daedalus:inspect`, `daedalus:navigate` and `daedalus:reload`.

Browser errors and terminal errors are merged into one strip in the panel with
"Fix" and "Fix all", which send the bolt-shaped prompt
`Fix this preview error:` + a fenced block (message, then file/frame/stack
trimmed to 30 lines) to the project's thread — the focused chat's session when
it belongs to the project, else the project's most recent one. A picked element
is appended to that thread's composer draft as a line, not sent: choosing what
to say about it is the user's.

## The stack is sensed, and "none" is an answer

The first build page opened on three cards with the first one selected.
Every prompt that did not stop to change it was scaffolded from React + Hono,
including "a Flask API for my inventory" — the agent then spent its first
turn deleting a Vite app. The picker asked a question the prompt had already
answered.

`client/src/lib/stack-sense.ts` reads the prompt on every keystroke against
two vocabularies. Each starter's **`signals`** (in its `template.json`, so a
template's author owns what points at it: "api", "login", "save" → React +
Hono; "landing page", "portfolio", "docs" → the static site) score the brief,
a multi-word phrase counting double as the more specific claim; the highest
total wins and a tie or an empty prompt falls to the lowest `sortOrder` — the
first card, as before. Above that sits a table of **stacks no starter ships**
(Next.js, Nuxt, Svelte, Astro, Express, Django, Flask, FastAPI, Go, Rust,
Rails, Laravel, .NET, Electron, Expo, a CLI, a browser extension…): a prompt
naming one is answered *from scratch* with that name, whatever the signal
score, because "a Next.js landing page" is a Next.js project. Matching is on
word boundaries so "reacting" is not React and "godot" is not Go. It is pure
and client-side because it has to run per keystroke on the cached template
list, and because a wrong guess costs one click: the cards stay, a click on
one is an explicit pick sensing never overrides, and "auto" is the way back.
The sensed card wears a sparkle rather than the dot so the user knows the
highlight moves as they type.

**From scratch is a project with no dev command.** `POST
/api/projects/from-template` with `templateId: null` (or the sentinel
`"scratch"`) runs `scaffoldFromScratch`: the same one-mkdir rules and undo,
but the directory gets only `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`) and a
`.gitignore`, one commit, and a row with `templateId: "scratch"`
(`SCRATCH_TEMPLATE_ID` — `listTemplates` refuses a `templates/scratch/`
directory so the sentinel cannot be shadowed) and `devCommand: null`. Nothing
is started, and the build page queues no preview: there is nothing to run.
The rules file carries the stack the prompt named (`stack` in the request,
free text) and says how a preview is earned — scaffold into this directory
with the stack's own tooling, honour `PORT` and `BASE_PATH`, and **say how it
runs**: a `dev` (or `start`) script in `package.json`, or for any other stack
a `daedalus.json` at the root with the command half of a template manifest
(`install`, `dev`, `check`, `build`). The agent's first turn is therefore the
scaffold, which is exactly the cost the template path was built to avoid —
accepted here because the alternative was no Flask at all.

**The harness senses the command when the turn ends.** `TurnChangesRecorder`
already reports every top-level `turn_ended` to the manager;
`SessionManager.senseDevCommand` runs there for a session whose project is a
`scratch` build with no command yet: `templates.ts › detectDevCommand` reads
`daedalus.json`'s `dev` first (the stated answer, any stack), then
`package.json`'s `dev`/`start` through the lockfile's package manager. A hit
is written onto the row once — from then on it is the user's, editable in
Settings › Projects and never re-sensed — every live session of the project
gets the fresh row, the peers get the live-only, absolute `project_changed`
event (the client invalidates the projects slice rather than patching the
row in from a frame — the catalog is TanStack Query's), and `startDevServer`
runs, the same call the scaffold route makes for a template, one turn later.
The shell's auto-open gate (`templateId && devCommand`) then fires on the
refetched row, so the preview appears beside the chat without anyone asking.
A plain project the user never gave a command is left alone: sensing is
keyed on the sentinel, not on the absence of a command.

The same reader serves everything a template manifest used to answer for a
project without one: `taskCommand` falls back to `detectCommand` (`daedalus.json`,
then `<pm> run check|build`), and `startDevServer` installs from `daedalus.json`'s
`install` or `<pm> install` beside a `package.json` when `node_modules` is
missing. `pnpm test:templates` covers the scratch scaffold, the sentinel and
the detection order.

## The flow: the real composer on a real draft

`/build` is a page outside the dock, but its prompt box is **the thread
composer itself**, not a lookalike. On mount the page creates an ordinary draft
thread (`newDraftThread`) on the `builtin:app-builder` persona and renders
`Composer` against it, so the agent and profile scope row, the settings popover
(model, effort, persona, the agent's own options, tool picks), attachments and
long-paste chips are the same controls with the same defaults as ⌘N — the only
difference is that the project half of the scope row is replaced by the starter
picker, because the project does not exist yet. The draft starts on the
remembered project rather than a placeholder id: the option probe, the `@`
file-mention menu and the sidebar all resolve a draft's project against the
catalog, and an id the catalog does not have makes each of them misbehave.

Sending runs `beforeSend` first: sense the stack once more against the text
being sent (unless a card was picked), post `from-template`, wait for the projects
query to be invalidated (a draft resolves its project from the catalog cache),
re-point the draft with `configureDraft({ projectId })`, queue the preview
panel (only when the row has a dev command — a from-scratch project earns
one later), navigate to the thread — and only then does the composer's own send
materialise the draft with the persona, picks, links and attachments the user
set. A page cannot call `openPanel`, because the dock does not exist until the
thread route mounts, so it **queues** the preview descriptor
(`lib/workspace/pending-panels.ts`) and the shell's route effect flushes the
queue right after `openChat`, which is what puts the preview to the right of
the chat. Leaving `/build` with an empty draft drops it; a typed one survives
like any other draft. The persona is the Lovable-style system prompt fitted to
this harness: build the whole feature, small components in their own files,
never touch the dev server, run `check`, commit, answer in two to four lines
with what to try in the preview.

Any project can do this. `projects.devCommand` is a column, set by the
scaffold and editable in Settings › Projects; a project with one gets a dev
server, a preview panel and "Open preview" on its page, template or not.

## Opening the preview is asking for the app

Every opener names the panel the same way — `previewPanel(projectId)` in
`lib/workspace/preview-bridge.ts` — so a layout holds one preview per
project, and opening it again focuses what is there. The openers: the build
page (queued, see above), the project page's "Open preview" (queued, with the
dev server's live state drawn on the button from the same stream the panel
reads), the thread header's own button, the header menu's "Open a panel ›
Preview" row, ⌘K "Open the preview", and the `preview` chord (⌘⇧E). All of
them are gated on the project having a `devCommand` — a control that opens
a panel with nothing in it is not a control.

**The panel starts the server.** A preview holding a stopped server is a
button asking to be pressed before it does anything; the panel presses it,
once per mount, and only from `off`. A `failed` or `exited` server stays
put with its reason on it, because a restart loop against a broken command
is the failure again, faster.

**A scaffolded app's thread opens with its preview beside it.** The shell's
route effect, right after `openChat`, opens the preview in the background
for a thread whose project has a `templateId` — once per thread per page
load, so closing it is respected for the rest of the visit, and never over
a panel the build page queued. Threads of ordinary projects, dev command or
not, are left alone: the preview is what Build mode is *for*, and a repo
somebody added a `pnpm dev` to is not necessarily being built in.

## What the panel does beyond framing

- **Back and forward** are `daedalus:history {delta}` to the bridge, which
  calls `history.go`; the panel counts the depth it has seen (a sandboxed
  frame will not say how long its own history is) so the arrows grey
  honestly.
- **The console** is every level the page logs, forwarded by the bridge as
  `daedalus:console` (cut at 2000 characters, 200 lines a second), drawn in
  a drawer under the frame with a problems-only filter, identical
  consecutive lines folded with a count, and a per-line "send to the agent".
  `console.error` also lands as an error, as before.
- **Failed fetches** are errors: the bridge wraps `window.fetch` and reports
  a rejection or a 4xx/5xx as kind `network` with the method, the in-app
  path, the status and the first 300 characters of the body — the API's own
  message, usually. Vite's client and the bridge's own path are exempt.
- **A pick names the file.** The bridge reads the React component chain off
  the fiber (nearest first, six deep) and folds the element's `outerHTML` to
  400 characters; the composer line reads
  `Selected element: button.primary in Button < TodoItem < App — "Add" ` with
  the markup on a second line. React 19 dropped `_debugSource`, so a source
  path is not available without a compile-time plugin; the chain plus the
  markup is what lets the agent grep its way there.
- **Check and build** are the project's own scripts, run on demand
  (`POST …/dev {action: "check" | "build"}`) in a `role: "build"` terminal,
  one at a time per project. `DevStatus.task` is the last run — running,
  passed or failed, with the command and the terminal — drawn as a chip
  beside the status pill; the output goes through the same error grouping
  as the dev server's, tagged `check`/`build`, so a failing typecheck sits
  in the strip with the runtime errors and takes the same Fix. The command
  is the template's (`build`/`check` in the manifest) or, for a project with
  no template, `<pm> run <script>` when `package.json` declares it, the
  package manager read off the lockfile. A task is not tied to the run's
  generation: restarting the dev server mid-typecheck neither kills nor
  forgets it.
- **Auto-fix is a loop with a ceiling.** Switched on (the wand), a new error
  is collected for 1.5s and sent to the project's thread by itself, but only
  when that thread is idle — an error mid-turn is usually the agent's own
  half-finished edit. Each error signature (source plus message with digits
  folded) is sent at most twice; the third time a toast says auto-fix gave
  up, which is where Lovable and Replit both stopped, for the reason that a
  third round is the agent arguing with itself. A (re)start clears the
  ledger: the strip is empty and a repeat is a new question. The persona is
  told the same thing from its side — if the same error comes back after a
  fix, say what was tried and ask.
- **Copy the address**, beside open-in-browser, with the toast saying the
  key in it is this boot's.

## History is the repository, and restore is a commit

The persona commits after every completed change, with a one-line message
from the user's point of view — the prompt says so, and says why: every
commit is a restore point. The panel's History drawer lists them
(`GET /api/projects/:id/history`, `git log --shortstat`, parsed from a
record-separated format rather than the human one) with files changed and
the plus/minus counts.

**Restore is a new commit whose tree is the old one, never a reset.**
`git.ts › restoreTo`: the target is verified as a commit; anything
uncommitted is committed first as "Checkpoint before restore" (so the one
thing a restore never does is lose work); then `read-tree -u --reset <hash>`
puts the index and worktree at the target — which, unlike `checkout <hash>
-- .`, removes the files the target did not have — and the result is
committed as "Restore to <short>: <subject>". Untracked ignored files
(`node_modules`, `.env`) are not the tree's and are left alone. A restore
onto HEAD's own tree is answered as a no-op. The history stays whole, the
dev server's watcher sees an ordinary write, and a restore can itself be
restored from.

**Checkpoint** (`checkpoint`) commits everything under a name — the way to
pin a working state before a risky ask. A clean tree is "nothing to
checkpoint", not an error. Both verbs answer the refreshed list, written
straight into the query cache. `pnpm test:history`.

## Templates

Three starters now: `react-hono`, `react` and `static` (Vite, TypeScript and
Tailwind over plain HTML — every top-level `*.html` is a page, discovered by
`vite.config.ts`, and links between pages are relative so they survive the
prefix). The manifest gained `build`; `check` and `build` are what the panel
runs. Each was verified under `BASE_PATH` — the shell, the assets, the HMR
upgrade at exactly the base path, and a production build whose asset URLs
carry the prefix.

## Not in this pass

`data-loc` source mapping for the picker (a compile-time plugin in each
template, once one is chosen), a production *preview* (serving `dist/`
beside the dev server), a diff view per history row, and templates beyond
the three. Each is a data or panel change on top of what is here, not a new
mechanism.
