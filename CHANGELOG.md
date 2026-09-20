# Changelog

All notable changes to the Daedalus harness are documented here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version is
[SemVer](https://semver.org/) and lives in the root `package.json` — bump it in
the same commit as the new entry. The server parses this file for
`GET /api/meta` (Settings › General shows it), and reads it line by line: keep
each bullet on a single line.

## [0.2.0] - 2026-09-13

### Added

- **Generated answers.** A model can reply with a fenced `openui-lang` program — stats, a key/value list, a table, a callout, a chart — and the transcript draws the UI it describes instead of the source. Nothing it writes can act: no tool provider is passed, so a query is dropped rather than run, and every tool call stays an ACP call with a permission in front of it. The prompt is generated from the component library, so what the model is told and what the reader gets cannot drift. A per-thread "Draw answers as UI" toggle governs whether the lane is offered, never whether a fence that arrives anyway is drawn.
- **`!` shell lines in the composer.** A `!` line is a shell command, not a prompt: the project's saved helpers are suggested, picking one fills its command into the box, and the send path runs it on the server against the project rather than prompting the agent. The output is journaled as a `_daedalus/shell` row — part of the transcript, replayed on reload, drawn as a Bash step open from the moment it starts.
- **A commit graph in source control.** The history section is drawn as lanes — one row per commit, merges fanning out, branches closing where two lines meet — with each commit's parents, refs and decorations read alongside it.
- **Draft a commit message.** The commit box can write one from the repository's own diff through the picked profile's endpoint; the diff is read server-side, and the staged diff is used when anything is staged.
- **A development-server preview.** A project can name its dev server, and the Browser panel opens it — probing loopback for a helper marked as the one that starts it, while never rewriting where the browser points.
- **Plan usage in the sidebar footer**: one row per readable plan and its fullest window behind a popover, reading the same list route the Usage page reads rather than polling on a timer. Providers read from their own account API rather than a runtime's CLI, so a thread on one plan no longer reports another company's.
- **Profiles are hidden or disabled rather than deleted.** Hiding takes a profile out of the pickers while its plan keeps being tracked; disabling closes it and its usage everywhere. Both keep the row and its threads running.
- **A translucent window**, a switch in Settings › Appearance, in the Electron app: off, the macOS vibrancy / Windows mica stops showing through the sidebar and the top bar. Stored on the device, and offered only where the platform has a material to turn off.
- **An "Opened" sidebar tier** listing the threads that have a tab open, in the dock's own order and out of Recents.
- **Images and audio ride through a prompt**, so a steer that carries one is still a prompt with an image in it, and a model-less Default thread inlines the attachment rather than vetoing it.
- **Off-peak pricing** is declared on a model and read back as a live indicator, for providers that price a window of the day rather than a request.
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
