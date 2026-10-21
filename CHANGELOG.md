# Changelog

All notable changes to the Daedalus harness are documented here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version is
[SemVer](https://semver.org/) and lives in the root `package.json` — bump it in
the same commit as the new entry. The server parses this file for
`GET /api/meta` (Settings › General shows it), and reads it line by line: keep
each bullet on a single line.

## [0.3.0] - 2026-10-21

### Added

- **Unread threads, and the count of them.** A thread whose turn ended after you last looked wears a bold title — the only bold title in the list — and the Sessions label carries how many there are, which is also a click away from the Unread filter. "Read" is when the thread is in front of you *and the window is in front of you*: an answer that lands on the thread you left open while you were in another app is news, and it is stamped read when you come back. The reading is per device, because it is about eyes.
- **Unread automation runs.** An automation runs with nobody in front of it, so a run now ends `unread` and stays that way until its page is opened (the runs list rings the unread ones and offers "Mark all read"). The Automations row in the sidebar counts them, polled — nothing else tells a client that a run ended — so coming back to the window tells you an unattended run happened. A `skipped` run is never unread: it is a run that did not happen, and it would bury the ones that did.
- **Spaces — a scope above projects.** "Personal", "Work": each space holds its own projects, and its own threads, so switching the space switches what the sidebar shows and which tabs the dock holds (each space keeps its own dock, synced per space). The switcher stands in the header beside the sidebar toggle and in the sidebar footer; a new project is filed into the space you are in, and an existing one is moved from its form. A space is deliberately neither a *profile* (a provider) nor a *workspace* (the dock and file surface).

### Changed

- **Stop a running subagent from its row.** A child whose runtime says it can be cancelled (the RFD's `capabilities.cancel`) wears a Stop while it works: an ask is cancelled through its run, and the parent agent is told; a runtime's own child gets `session/cancel` on its id. Workflow steps are still stopped from their run's card.
- **An ask can run in another project, and a parent with live asks is no longer idle-retired.** `ask_agent` and a script's `agent()` take an optional `projectId`; the child works in that project's directory instead of the caller's. And the idle sweep now skips a thread whose asks, workflow runs or background tasks are still working — retiring it used to cancel them after 30 quiet minutes.
- **The sidebar row says what it knows on hover.** A hover used to raise one line of text — a folder's own name, or "Needs you · model · project" — while the reading that actually explains a thread (status, agent, profile, model, its project's path, when it started, when it last spoke, why the last turn failed) sat behind the ⋯. That reading is the row's hover card now (`PreviewCard`, 400ms, the same `ThreadInfoCard`) and it opens no actions: the ⋯ and the right-click menu are still what does things. A project folder's card reads its note, its path, how many threads it holds, what is running or needs you, and when it last spoke. The row's native `title`, and the count badges' own, are gone with it — one hover, one card, instead of a tooltip that said less and a second popover where the two met.
- **The connection moved out of the composer.** "Reconnecting", "Waiting for the server", "This thread's agent isn't running" and the rest were a reading on the composer's shelf, and the shelf's own ground took its tone — so a dropped socket coloured the whole unit amber above the box you type into. They are a `Notice` at the foot of the transcript now (`components/connection-card.tsx`), with the wait, the working line and the turn's other stops, where the sentence is readable in place with its button rather than behind a press. The shelf has one ground again (no `tone` prop, no `--shelf-info`/`-warn`/`-error`), and the scope row lost the `leading` slot that existed only to carry it.
- **A project carries the settings its threads start with.** The agent, profile, model, effort, permission mode, persona, tool picks, suggestions and drawn-UI toggles are stored on the project (`projects.default_*`, `PATCH /api/projects/:id/defaults`), so changing the project changes the model — and the pick follows you to every device instead of living in one browser. A project that has never been worked in opens on the profile/agent defaults rather than on an invented value, and a pick publishes only the fields it names, so two devices cannot clobber each other's settings.
- **A turn notification says what it was about, and offers to open it.** The thread's name is the title and the body is the message you sent that the turn answered (a failure's own line follows it), threaded from the bridge through `onTurnSettled` to the push and the inbox rather than announcing a bare "Turn finished" at a thread you cannot recognise. Every notice — a finished turn included — now carries an explicit "Open" (`NotificationShape.openAction`): a button on the toast and an `actions` entry on the OS notification, both landing on the thread the whole banner already routes to; `requireInteraction` stays with the events the agent is blocked on.
- **The Agents panel draws each step's real turn parts.** An entry used to fold away a brief, a list of tool *titles* and a report; it now draws the brief, the real rail of rows and tool views, and the report, through the transcript's own `SubagentStep` (`variant="body"`) — for an ordinary agent and a workflow step alike, so the panel and the transcript agree on what a step did. One fold, open while the step works, because a native workflow step fetches its transcript only when it opens.
- **A thought stands between the folds, not inside one.** "Group tool calls" swept the thinking into the run it happened in, so `call -> think -> call` read as one line saying "Reading 2 files" and the reasoning that explains those calls was only visible after opening the fold and scrolling past them. A thought now ends the run it lands in and is drawn where it arrived, whatever shape "Thinking as a step" gives it: a run holds calls and the settings changed mid-turn between them, and `RunItem` is a call or a notice, so nothing else can be swept in.
- **A fold's arrow sits at the end of its line.** The chevron that opened a run, a work fold or a `!` run stood in the mark column in front of the title, so the row began with an arrow and its avatars started one slot in. It is the row's last element now, after the summary and the counting column, and the header starts on its own marks — so the rail begins at the fold's bottom edge rather than under a chevron.

### Removed

- **The MCP playground is gone; the details page stays as a reading.** Running a tool, prompt or resource from Settings is gone — the ad-hoc `/settings/mcp/playground` page, the library form's "Try it" and the routes behind it (`POST /api/mcp-servers/:id/invoke`, `/api/mcp-servers/:id/complete`, `POST /api/mcp-playground/:op`, `completeMcp`) are removed. The server's own page (`/settings/mcp/:id/tools`) remains, without a Run button: a rail of what the server offers beside each entry's contract — a tool's input fields and output schema, a prompt's arguments, a resource's URI and type — with the raw schema one fold below. A library row still lists what a server offers, and a thread's prompts and resources still reach the composer.

### Fixed

- **A mention chip sits on the line it is typed into.** The pill is an inline-flex box, and with nothing baseline-aligned its baseline is the *bottom edge* of its first item — for an `@` mention, the icon — so the chip rode a few pixels off the text around it in the composer (a project's circular mark, being text, sat the other way). The pill and its face now baseline-align and the icon centres itself, so an `@` mention's own text lands on the line's baseline, in the composer and in the sent bubble alike; the ✕ the composer adds stays centred.
- **Following the stream no longer lags its content by a frame.** The autoscroll pin corrected its scroll inside a `requestAnimationFrame` scheduled from the resize callback, so the frame that laid the new lines out painted them under a parked `scrollTop` and the next frame snapped to them — invisible at a trickle, a stutter at every frame once a model streams whole lines at once, worst in the capped thought box where each frame's growth is most of the box. The correction is made inside the `ResizeObserver` callback now, which runs after layout and before paint, so the scroll and the content land in the same frame (`hooks/use-follow-stream`).

## [0.2.0] - 2026-09-13

### Added

- **Generated answers.** A model can reply with a fenced `openui-lang` program — stats, a key/value list, a table, a callout, a chart — and the transcript draws the UI it describes instead of the source. Nothing it writes can act: no tool provider is passed, so a query is dropped rather than run, and every tool call stays an ACP call with a permission in front of it. The prompt is generated from the component library, so what the model is told and what the reader gets cannot drift. A per-thread "Draw answers as UI" toggle governs whether the lane is offered, never whether a fence that arrives anyway is drawn.
- **`!` shell lines in the composer.** A `!` line is a shell command, not a prompt: the project's saved helpers are suggested, picking one fills its command into the box, and the send path runs it on the server against the project rather than prompting the agent. The output is journaled as a `_daedalus/shell` row — part of the transcript, replayed on reload, drawn as a Bash step open from the moment it starts.
- **A commit graph in source control.** The history section is drawn as lanes — one row per commit, merges fanning out, branches closing where two lines meet — with each commit's parents, refs and decorations read alongside it.
- **Draft a commit message.** The commit box can write one from the repository's own diff through the picked profile's endpoint; the diff is read server-side, and the staged diff is used when anything is staged.
- **A development-server preview.** A project can name its dev server, and the Browser panel opens it — probing loopback for a helper marked as the one that starts it, while never rewriting where the browser points.
- **Plan usage in the sidebar footer**: one row per readable plan and its fullest window behind a popover, reading the same list route the Usage page reads rather than polling on a timer. Providers read from their own account API rather than a runtime's CLI, so a thread on one plan no longer reports another company's.
- **Profiles are hidden or disabled rather than deleted.** Hiding takes a profile out of the pickers while its plan keeps being tracked; disabling closes it and its usage everywhere. Both keep the row and its threads running.
- **A translucent window**: in the Electron app the macOS vibrancy / Windows acrylic shows through the sidebar, the gutters and the top bar. No setting — the platform either has a material or it does not.
- **An "Opened" sidebar tier** listing the threads that have a tab open, in the dock's own order and out of Recents.
- **Images and audio ride through a prompt**, so a steer that carries one is still a prompt with an image in it, and a model-less Default thread inlines the attachment rather than vetoing it.
- **Options come from a live session or a cached probe** — fetching a profile's models and testing one against the endpoint are now real routes the profile form reads.

### Changed

- **The composer is one card with two rows.** What adds to the message is behind "+", what governs how it sends behind the chevron beside Send; the shelf has a floor permanently saying the project, the tools and the context, and a pile for what is about the message being typed. The queue, a held turn, an approval, a question and the working line moved to the foot of the transcript, where the next thing happens.
- **Turn checklists, agents and changes are readings of the thread** — a 24px trigger over a popover in the composer's footer, each drawing nothing when it has nothing to say.
- **The dock's tabs are one row rather than a slab floating in one**, a tab a piece of the card rising into the strip. A narrow strip keeps the tab you are on and puts every other one in the list at its end, so a tab switch is one frame rather than an animated collapse.
- **A tab's review of a turn is source control narrowed to its paths** — a second changes list that could not stage, discard or commit was removed.
- **Pins live on the server** (`sessions.pinned_at`) rather than the device, so a pinned thread follows you to every device, and its timestamp is the order the pinned group is drawn in.
- **A turn's changes are still measured by git but read off the transcript** — a turn that only read, thought or fetched draws nothing, because in a shared cwd it would otherwise claim another thread's diff.
- **The IDE's open editors, the sidebar's open state and the terminal's prefs are per-device and per-project**, so their tabs survive a reload.
- **The IDE's search runs on the server** (`files/grep`), and the task board grew lists, custom fields and active filter pills.
- **Markdown tables, notices and the harness's own cards are one component each** — `Notice` for every alert and `Empty` for "there is nothing here" — where four components used to spell the same box.
- A spilling project path, a long command and a file list now truncate and elide instead of pushing the row wider.

### Fixed

- **A configuration change picked during a held turn or a retry window is no longer stranded**: it is flushed when the turn resumes or is steered, so a pick made behind a stalled turn lands on the running process instead of waiting for a turn that never comes.
- **A restart no longer clears the transcript** when the thread is live and there is no respawn queued — the journal is kept, so a setting change does not cost every reader the turn boundaries, the rail and every window along with it.
- **A steered message that arrives after the agent has streamed its final step** is now read in one more step of the same turn; it used to be parked as context for a turn that never came.
- **Escape takes back the message that has not landed**, newest first and one only, back into the composer — the take-back comes before the cancel, so a settle cannot draw the held steer first.
- **"Load earlier steps" leaves the reader where they were.** The re-fold mints a new row for every row on screen, which defeated both the scroller's element-matched preserve-on-prepend and the browser's scroll anchoring; the anchor is now distance-from-end, which survives the replacement.
- **A page of history brought back carries every `!` command**, because a shell row belongs to no turn and one the reader ran can never be something the replay withholds.
- **Drafting a commit message, a branch name or a prompt rewrite works on a profile that serves several runtimes again.** Those calls go to the profile's shared endpoint and never the per-agent override, but they were gated by the spawn paths' rule — which refuses to guess an agent when a profile names more than one — so every draft answered "unknown agent for this profile". Their gate is now `profileHasAgent`: at least one runtime the profile names is one the harness knows.
- A failed attempt no longer persists an assistant message whose tool call has no result, which the next `session/load` handed back to a provider that rejects it.
- A pinned thread is no longer listed twice, an exited terminal gets a new shell rather than a reconnect, and a profile model pick is drawn before it lands instead of patching the row.

## [0.1.0] - 2026-09-07

### Added

- One app version, in the root `package.json` — the harness is one product deployed together, so the client's build id and the server's `/api/meta` read the same number.
- This changelog, served parsed by `GET /api/meta` and browsable in Settings › General › What's new.
