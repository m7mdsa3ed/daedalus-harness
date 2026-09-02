# Client architecture & UI

_Extracted from CLAUDE.md; the rationale behind the rules summarised there._

## State ownership, theming, palette, sidebar, tool views

- `client/` — Vite + React 19 + Tailwind v4 + shadcn (Base UI, NOT Radix: compose triggers
  with `render={...}`, not `asChild`; `SelectValue` needs explicit children for labels).
  The browser does **not** speak ACP — the server does. `src/lib/thread-socket.ts` is a plain
  WebSocket that sends the commands in `server/src/protocol.ts` and dispatches its events;
  `@agentclientprotocol/sdk` is a **devDependency**, imported type-only (the payloads are
  still ACP-shaped because the transcript renders them). **State has two owners, split
  by what moves it.** The reducer in `src/lib/store.tsx` holds what the *socket* writes —
  the `sessions` list and every per-thread `ThreadState` (transcript, phase, usage, queue,
  drafts) — because that is state a stream replaces token by token and a replay rebuilds.
  Everything a *route* answers is TanStack Query (`src/lib/queries/`): the catalog
  (profiles, agents, projects, MCP servers, skills, commands, personas), the automations
  (scheduled, routines, their runs and triggers), and the read surfaces (project stats,
  quota, knowledge, boards, tasks, the notification inbox). One owner per slice,
  permanent, and nothing is mirrored between them — a slice held in both is two answers
  that drift, and mirroring a query into the reducer would break the identity contract
  `useStoreSelect` depends on. Reads are cached with a `staleTime` and refetched on
  window focus, which is what retired the hand-rolled freshness this client had grown:
  a `visibilitychange` catalog re-read throttled to a minute, a focus listener on the
  inbox, `loaded` flags and in-flight dedupes on three module-level stores, and a Refresh
  button that bumped a nonce to re-run an effect. Writes are mutations that **invalidate**
  rather than re-read by hand — the rule `lib/rest-actions.ts` stated first and the reason
  that file is gone: a mutation is not done when the server answers 200, it is done when
  the cached list every screen reads has been invalidated. Keys are server-scoped
  (`["srv", settings.id, …]` — `queries/keys.ts` builds every one, never a call site) and
  the `QueryClient` is created per connection in `Connected`, so two servers can never
  read each other's rows — which is what makes **switching servers a state change and not
  a page reload** (see below). **The cache
  outlives the reload** (`queries/persist.ts`, `PersistQueryClientProvider`): it is
  dumped to localStorage and read back on the next load, so an installed PWA opened
  cold paints the app it had rather than a screen of skeletons while the same requests
  run again. Children render immediately and it is the *fetching* that the restore
  holds, so nothing is requested that the dump was about to answer. Four rules the dump
  obeys, each for a way it could otherwise lie: the storage key is **per server**
  (`daedalus.query-cache:<id>`, dropped by `removeServer` along with the layout, since
  rows are no use without a token to refresh them); `buster` is the **build id**
  (`__QUERY_CACHE_BUSTER__`, defined in `vite.config.ts`) because what a query's data
  *is* changes with a release and rehydrating last week's shape is the failure with no
  error message; only **successful** reads are kept, and the notification inbox is
  excluded by key, because a badge saying "3 unread" from yesterday before dropping to
  0 is a wrong answer given confidently, where the rest of the cache is a right answer
  given early; and `removeOldestQuery` sheds least-recently-used entries when
  localStorage refuses the write, since a knowledge base or a task list is not a
  bounded size and one oversized entry must not cost the whole dump. Nothing older
  than a day is restored at all. The three
  non-React readers of catalog rows — `createSession`, `loadQuota`, and the connection's
  deleted-project guard — read the cache through `useCatalogReader()` inside callbacks,
  exactly as they read `getState()`: last-committed, no subscription. Side effects that
  are not one of those two things — the whole thread lifecycle — stay in
  `src/lib/actions.ts`.
  **Switching servers is a state change, not a page reload.** It used to be
  `setActiveServer(id)` plus `location.assign("/")`, spelled out at three call sites
  (the sidebar footer, Settings › General, the palette) — and the reload *was* the
  reset: it took the sockets, the reducer, the caches and every module-level map with
  it. On a PWA that stays open for days that is a cold boot — the bundle re-parsed, the
  theme re-applied, the persisted dump re-read, every panel in the dock rebuilt — to
  change one id. `switchServer` in `App.tsx` is the one door now, reached through
  `useSwitchServer()` (`lib/server-context.tsx`, riding along with `useServer()` because
  it is the same question asked the other way), and the order in it is the whole of the
  design: **the route** moves first, while the outgoing tree is still mounted, and only
  a thread route moves — `/t/<id>` names a session that exists on exactly one server,
  where `/settings/*` and `/projects/*` resolve against whichever is connected; then the
  **storage scope**, which flushes anything buffered under the old server on the way
  past; then the **module-level singletons**; then the **state**, which re-keys
  `<Connected>`. What React owns is reset by that key — the `QueryClient`, the persist
  target, the `ServerProvider`, the whole shell, and **`StoreProvider`, which moved
  below `Connected` for exactly this**: sitting above it, the reducer survived the
  re-key, so server B would have inherited A's `sessions`, transcripts, phases and
  queues, all keyed by a bare `sessionId`. What React does not own is
  `resetServerSingletons()` (`lib/server-reset.ts`), one call for the reason
  `ThreadRegistry` gives about the seven maps it replaced — a teardown split across four
  call sites is one that can half-happen: `resetNetworkWatch` (the health poll and its
  cached probe, both answers about the old URL), `closeAllWatches` (`workspace/watch.ts`
  re-reads `loadSettings()` on every retry, so a stream left open would silently
  re-target the new server's URL and token for the old server's project id) and
  `resetTaskEvents`. The thread registry is deliberately **not** in there: it is keyed by
  the server it was built for and rebuilds itself over the old one on a mismatch
  (`threadRegistry`), which is self-healing where an unmount effect would have to run in
  an order nothing guarantees — and React's dev double-invoke would have fired its
  cleanup against a live one. Re-pointing it would have been worse than leaking it:
  A's open sockets would start issuing B's `api()` calls with B's token, which is the
  two-peers-on-one-session bug in another costume. The same door handles the adjacent
  identity changes — add, rename, forget, disconnect — because each of them ends in
  "read `lib/settings` back and let go of what was there".
  **A theme is not a
  palette any more** — it is colour *plus* corner radius, three font roles,
  a depth and a tracking, because twelve recolourings of one layout were never
  twelve themes. Themes live in `src/styles/themes.css`, not in `index.css`, and
  that file is **generated by `client/scripts/gen-themes.mjs` (`pnpm themes`)**:
  each theme is a hue, a brand chroma and a neutral tint, the ramps are derived
  from those, and that one table is the **only** place a built-in exists — it
  writes `styles/themes.css` *and* `src/lib/builtin-themes.ts`, the list the
  gallery and the palette render, which `lib/theme.tsx` now re-exports rather
  than declaring. It was hand-written there with a "keep in sync" comment at
  both ends, which is precisely how Sunset, Rose, Amber and Slate outlived the
  blocks that painted them. **Three gates run before anything is written**, each
  for a failure that had already happened and that no diff shows: every
  foreground/surface pair at WCAG AA (a hand-authored palette drifts out of it
  in one mode only, unnoticed); no two themes sharing a *design signature* —
  radius, depth, tracking, blur, measure and all three fonts — because Graphite
  and Codex were literally the same theme six degrees apart in hue, and a hue is
  not a theme; and every preset value plus every bundled `@fontsource` family
  worn by at least one built-in, since a shape nothing ships is a control the
  user meets with no example, and `roboto` sat in the bundle for months with no
  theme naming it, shipped to every device for nothing. Three blocks per theme,
  split by what the value depends on: `[data-color-theme="x"][data-color-theme]`
  for radius/fonts/depth/tracking (none of which change with the mode), and
  `:not(.dark)` / `.dark` variants of it for the two colour halves. **The
  attribute is doubled on purpose** — it has to out-specify index.css's `:root`
  (0,1,0) defaults and its `:root:not(.dark)` block (0,2,0) that derives
  `--composer`, and the obvious `:root[...]` fix would restrict the block to the
  document element, which would blank the gallery's previews (they set
  `data-color-theme` on a nested div). Non-colour tokens are themeable only
  because they go through the same indirection the colours already used:
  `@theme inline { --font-sans: var(--app-font-sans) }` resolves at paint, where
  a value declared directly in `@theme` is resolved when Tailwind builds and
  nothing could ever override it. Two vocabularies keep CSS as the single
  source: `--font-family-<id>` (the real face name `@fontsource` registers,
  spelled once) and `--depth-<id>-glass`, which is **redeclared under `.dark`**
  — that is what lets depth be one mode-independent choice on a theme, since the
  same black at 6% that lifts a card off white is invisible over near-black.
  **A theme's shape has to reach the components or it is a lie**, which is what
  the offset scale `--radius-sm: calc(var(--radius) - 4px)` … `--radius-4xl:
  calc(var(--radius) + 16px)` made it: a square theme still drew 8px cards and
  18px dialogs (`calc(0px + 8px)` is 8px), and the small steps went negative,
  which is an invalid declaration the browser silently drops. Every step is a
  **multiple** now — `* 0.6 / 0.8 / 1 / 1.4 / 1.8 / 2.2 / 2.6` — which is
  identical to the digit at the default 0.625rem (6/8/10/14/18/22/26), so the
  change was a no-op for the shipped look, and collapses the whole scale to 0
  when a theme asks for square. `--radius-pill` is the one step that is
  **stated, not derived** (`rounded-pill`, `RadiusPreset.pill`): border-radius
  clamps to half the box, so any value over ~10px is a capsule on a 20px chip
  however small the base radius — a square theme could not otherwise say "no
  capsules". The ~15 genuine capsules in the app (badges, count chips, filter
  buttons, progress bars, the workflow meter) moved to `rounded-pill`; the ~56
  true circles — avatars, status dots, radio marks, the drawer grab handle —
  keep `rounded-full` and never move. `--app-blur` is the same story for glass:
  it was hardcoded at 14px in five places, and the two heavier tiers are
  multiples of it now.
  `src/lib/theme-ramp.ts` is the palette maths, and it is **pure** — no DOM —
  because `scripts/gen-themes.mjs` imports it (Node 22 strips the types) *and*
  the studio's "Generate palette" runs it, so a hue the user picks is built by
  the same ramp and gated against the same `CONTRAST_PAIRS` as a shipped theme.
  `src/lib/fonts.ts` owns the font catalog and resolves an id to a stack;
  bundled families are `@import`ed in `index.css`, and a `google:<Family>` id is
  fetched at runtime by `syncWebFonts` (weighted request first, bare family on
  its `error` — Google 400s a family that lacks a requested weight). A built-in
  may only name a bundled family: it has to paint on a cold offline load.
  User-made themes are the same token set written into a runtime `<style>` by
  `src/lib/custom-themes.ts` — `{light, dark}` for colour, `base` for the rest,
  and a theme saved before `base` existed loads with an empty one, which emits
  no declarations and so looks exactly as it did. Each built-in also echoes its
  choices as `--theme-radius` / `--theme-depth` / `--theme-font-*` holding the
  *ids*, which is how `readThemeBase` seeds a copy that reopens in the studio
  with the same named presets rather than a resolved stack nothing maps back to
  a picker row. The studio is `components/theme-builder.tsx`: **two columns —
  controls left, a live mock of the app right, sticky, in both modes at once** —
  because none of these choices can be judged from the control that sets them (a
  radius is a number until it is on a badge beside a card beside an input), and
  the old single column put the samples above the fold and the tokens below it,
  so every edit was made blind. Three tabs, in the order a theme is actually
  made: Presets (a style preset sets the whole Design half at once; a palette
  preset or the hue/saturation/tint sliders regenerate every colour through the
  ramp), Design (type, shape, depth, glass, measure, tracking), Color (the
  light/dark pair edited together). **Colour presets come in two kinds, and the
  split is the point.** The generated ones drive `theme-ramp.ts` from a hue,
  saturation and tint — coherent and AA by construction, but only ever the same
  design in another colour, and they touch colour alone. The curated ones
  (`lib/color-schemes.ts`: Nord, Dracula/Alucard, Solarized, Gruvbox,
  Catppuccin, Rosé Pine — all MIT) are hand-authored identities no formula lands
  on, and they set the **Design half too**, because Gruvbox under a geometric
  sans with capsule badges is not Gruvbox. Every value is transcribed from the
  project's own source file, named in `source` — Tokyo Night was dropped because
  its light variant is computed by an `invert()` rather than published, and a
  guess under that name is worse than its absence. Two things a scheme cannot
  supply itself: an editor names a background, a foreground, a comment and some
  accents but never "a popover behind a card on a sidebar", so gaps are filled
  from the scheme's own neighbours and marked `derived:`; and **a comment colour
  is not body text** — several fall under AA on the surface this app puts
  secondary text on, since in an editor they are *meant* to recede. `pnpm
  themes` gates the schemes on the same `CONTRAST_PAIRS` as the built-ins, which
  is what caught thirteen such pairs; each was repaired with the scheme's own
  next documented step where one exists (Gruvbox `faded_orange`, Catppuccin
  `subtext1`, Rosé Pine `pine`) and only otherwise by deriving one (Nord and
  Solarized publish no darker blue). Every preset swatch draws *itself* — the
  shape one shows a corner **and** a capsule, the glass one is a real
  `backdrop-filter` over a stripe — since "Soft" and "Deep" are not the choice.
  It is also why the settings frame's width is **`settingsMaxWidth`**
  (`components/settings/sections.ts`) rather than the constant `max-w-3xl` it
  was: forms read at `max-w-5xl` now, and the routes that are *not* forms — the
  studio is the only one so far — take the frame's full width, because at a
  form's measure the preview shrinks to a thumbnail and the colour grid wraps
  its light/dark pair onto separate lines, which is the one comparison the
  screen exists to make. Matched on the pathname there rather than declared per
  route, because the layout is what renders the container and it only knows the
  location; and set by the layout rather than by each page, or the frame would
  jump width as you moved between them.
  **The colour before the app exists is
  `src/lib/boot-colors.ts`** — the address-bar tint, the inlined splash and the
  manifest all need the background named before any stylesheet is parsed, so it
  is written once there in hex and pulled in three ways: `lib/theme.tsx` imports
  it as a fallback, `vite.config.ts` imports it for the manifest and substitutes
  `%BOOT_LIGHT%`/`%BOOT_DARK%` into the static `index.html`. It is the *Default
  palette's* `--background`, not `.dark`'s from `index.css` — ThemeProvider
  always sets `data-color-theme`, so `.dark` alone is a state nothing paints —
  and it is the one theme whose background the generator does **not** derive but
  pins, in `THEMES[0].overrides`, so that these two hex values stay true; moving
  it means moving both. Only the
  floor lives there: every load after the first tints from the real palette,
  which `applyThemeColor` caches per `<palette>:<mode>` for the pre-paint script
  in `index.html` to read back. **⌘K opens `components/command-palette/`, and
  its rule is that the root page never asks the server.** It used to: threads
  were listed inline and a debounced `/api/search` ran on every keystroke, so
  the command list and a full-text query shared one input, one ranking and one
  clock — commands were diluted by conversations, and the fast local half of
  the list redrew whenever the slow remote half answered. The palette is a
  *stack of pages* now (`context.ts`: root, search, projects, start, theme,
  model, effort, mode), and searching is a destination like any other —
  "Search threads and messages…" descends into `search-page.tsx`, which owns
  its own query, debounce, abort and loading line, and answers in two sections
  on two clocks (thread titles matched locally, on the keystroke; transcripts
  from the FTS index, 200ms behind it and saying so). Root is a pure local
  filter over commands, and a page is left by Escape, Backspace on an empty box
  or the chip in the input — Escape in the **capture** phase, because the
  dialog's own Escape-to-close listens on the popup, which bubbles after us, so
  without capture the whole palette would close instead of going back one.
  Rows are **data, not JSX** (`rank.ts`: `PaletteItem`, declared by each page,
  scored by `score.ts`), and cmdk's filter is off (`shouldFilter={false}`) for
  one reason: the two rows that are *about* the query — search for it, ask a
  new thread with it — have to sit below every row that is a real match for it,
  which a yes/no filter cannot express. So they are `rank: "bottom"`, and they
  float to the top exactly when nothing else is **named** by the query (a
  word-boundary hit in a title or keywords, `NAMED` in `rank.ts`) — which is
  what makes ↵ on prose reach Search rather than whichever command happened to
  contain the same letters in order, while ⌘↵ still starts a thread with it.
  With no query the declared order is kept exactly — with one exception the
  same rule pays for: the **Recently used** group (`lib/palette-recents.ts`, a
  device-local MRU of command *ids* like pins and view options; `RECENT_GROUP`
  in `rank.ts`). The five most recent commands are **lifted** into a group above
  everything with no query — moved, never copied, since a row drawn twice is two
  rows sharing one id, which is cmdk's selection value — and with a query they
  stay where they are and take only a small nudge (`RECENCY_BONUS`), applied
  *after* `named` is decided so a habit can never promote a scattered-letters
  match into a row the query counts as naming. Ids are resolved against the rows
  actually on offer, so a remembered command that no longer applies (Stop the
  turn, on a finished thread) simply is not there. Only `root-page.tsx` records,
  by wrapping its own `onSelect`s: it is the one page whose ids are a
  vocabulary — a choice page's rows are this agent's models, the search page's
  are somebody's messages — and it skips the two kinds of row that are not
  commands, the landing list's threads (a destination the sidebar's own Recents
  already answers for) and the `always` rows that are about the query.
  Otherwise a palette that reshuffles itself before you have typed is one you
  have to read.
  **A row is slots, never markup** (`PaletteItem` in `rank.ts`, drawn only by
  `Row` in `list.tsx`): a leading tile (one fixed box, so a stroke glyph, a
  project's mark and an agent's logo share a vertical line), a body (title,
  optional `badges`, optional `subtitle`), a `meta` column (`label` with an
  optional `icon`, `mono`, `dim`; drawn `a · b`, truncating from the right as
  one unit) and an end slot for a `chord` *or* a tick. Before, every page
  brought its own `trailing` JSX with its own `ml-auto`, and `ui/command`'s
  `CommandItem` drew an invisible tick at the end of every row — which is why
  nothing lined up. `Row` is cmdk's primitive directly, and `index.tsx`
  turns the dialog's roomier `[cmdk-item]` spacing back off, so one row is one
  shape on the root, the choice pages, search and the routine digest alike.
  Reading a tool call — inferring its kind, target, language and diff out of
  ACP's opaque `rawInput`/`rawOutput` — is quarantined in `lib/tools.ts`, and
  **drawing** one is `components/tool-views.tsx` on top of the primitives in
  `components/tool-parts.tsx` (which exists so those two and `thread-items.tsx`
  can share a pane without importing each other). No component matches on a
  vendor tool name: `toolViewOf` picks the layout and the matching `extract*`
  supplies the fields, so a new runtime's tool is one file's edit. ACP `kind`
  still decides the layout *family* — it is the part that is protocol — but it
  is too coarse on its own, because the three runtimes describe the same act
  three ways: a checklist arrives as tool input under `think` from Claude Code,
  under `other` from OpenCode and as a real ACP plan from Codex; an MCP call
  arrives under `execute` from Codex (`mcp.<server>.<tool>`, `{server, tool,
  arguments}`) and as `mcp__server__tool` from the others; a web search arrives
  under `search`, which is also where ripgrep lives. Each of those rendered as
  a JSON dump or a wrong-shaped pane before it had a view — as did a
  `MultiEdit`, whose hunks are one level down in an array. The loudest of them
  is **the terminal**: Codex announces every shell command as `content:
  [{type:"terminal"}]` and streams the bytes through `_meta.terminal_output_delta`
  on later updates, *whether or not the client claimed the capability* — the
  content block is a handle, not a payload, and `_meta` is merged key-wise per
  update, so drawing it printed the literal `[terminal]` and kept only the last
  chunk. `applyTerminalMeta` accumulates the chunks onto `ToolItem.terminal` in
  the store reducer, which is also what makes replay work, since a replayed
  thread runs the same reducer over the same journaled updates.
  **The web has two views of its own, and they are matched on the tool's
  *leaf* name** (`toolLeafName`: `web_search` out of `mcp__web-search__web_search`
  or Codex's `mcp.web-search.web_search`), so Claude Code's built-in
  `WebSearch`/`WebFetch`, OpenCode's `websearch`/`webfetch`, Codex's browsing and
  any MCP search server — the harness's own included — land in the same layouts.
  `extractWebSearch` reads results out of whatever the tool answered: structured
  `results[]` on `rawOutput` or on `_meta.claudeCode.toolResponse` (flat, or Claude
  Code's nested `content[]` — whose array also carries the prose strings of the
  built-in search's own answer, kept as `summary` and drawn under the list),
  `N. title / url / snippet` blocks (what `websearch.ts` and the cc-cli proxy
  write), `Title (url)` lines, or markdown links; the web heading wins over the
  agent's own title (`"query"` from Claude Code, the raw MCP name from the server)
  so both read `Search the web for “…”`; `extractWebFetch` is any named fetcher or `kind:
  "fetch"` with an http URL. `WebSearchDetail` draws results as sources (favicon,
  host, title, a clamped snippet that opens on click); `WebFetchDetail` draws the
  page as markdown under its address. Two rules made this reachable at all: an
  MCP server name may carry a hyphen, so `NAME_RE` accepts `[\w.-]` (it read
  `mcp__web-search__web_search` as *prose* and made it the row title), and an
  agent's `kind: "other"` is the protocol saying nothing, so `toolKindOf` lets
  the name answer instead (Claude Code files every MCP tool under `other`). The
  **Sources** strip under a finished turn (`lib/sources.ts`, `SourcesStrip`,
  inserted by `withTurnSources` in `thread-view.tsx`) is derived from the
  transcript alone — pages the agent *fetched* plus search results whose URL it
  *cited* in its prose, never every hit it saw — so it survives replay with
  nothing journaled, and it waits for `turnActive` to drop so it does not grow
  under the reader. Sources exist at the **tool-call level** too: `ToolSources`
  (`tool-views.tsx`) is the `below` slot of every `StepRow` — a shadcn
  `AvatarGroup` stack of site favicons, one per host a search returned (result
  order, a `+N` count past six that opens the rest) or the page a fetch read —
  visible whether the step is open or not, so a collapsed run still says which
  sites answered. Each avatar is a link, rendered with Base UI's `render={<a/>}`
  so the anchor *is* the avatar root and the group's ring selector
  (`*:data-[slot=avatar]`) still finds it. The two strips answer different questions: the row's is
  "what did this call see", the turn's is "what did the answer use".
  **A run of subagents is a step row, not a surface of its own.** A harness
  workflow and an ad-hoc batch of workers are the same question asked twice — a
  workflow knows its shape up front, a batch does not — so `workflow-run.tsx`
  draws both through one `RunRow`: a `StepRow` like every other row in the
  transcript, whose line carries the run's name, `done/total`, elapsed, cost
  and, while it runs, the phase and step being written with what that step is
  on. Opening it lists the steps on the same rail a subagent's own rows hang
  off (`RAIL_CLASS`, in `step-row.tsx` because thread-items and workflow-run may
  not import each other), each one the *same* `SubagentStep` row it would be on
  its own, each opening its own transcript in place. Steps the runner has not
  spawned yet are pending rows, so the run's shape is whole from the first spawn
  and does not change under the reader. This replaced a preview card (icon tile,
  state pill, progress bar, fact line, live foot) over a modal dialog that
  restated all five and then drew its own step rows, phase rules, tone table and
  two fact renderings — a second design language, and a modal that took the
  transcript off the screen to show a part of it. What was lost with it is
  deliberate: there is no run-level progress bar (the count says it), no state
  pill (the row's own status colour and the `failed` label say it), and a
  settled *step* no longer prints a duration, which is how every other step row
  in the transcript already behaves. A run that is live when it mounts opens
  itself and then stays wherever the reader leaves it; a settled or replayed one
  is folded. The naming rule is one function (`stepNameOf`): the definition's
  step name when there is one, else what the worker was asked to do — so a step
  does not change its name depending on whether it is read inside the run or on
  its own.
  **A thinking row streams as a ticker**: `RowView`'s `streaming` flag (set by
  `thread-view.tsx` on the transcript's tail row while `turnActive`, and by the subagent
  rail on its tail while the child is active) makes the `thought` case draw in-progress —
  primary icon, elapsed timer, a shimmering title that is the *newest* line's tail
  (`thoughtPreview`), clipped from the front because the end is the part that is new.
  Settled, the title is the opening line as before. Derived at view time from position,
  not from a flag in the store: the reducer never marks a thought done.
  `components/ui/diff-view.tsx` is a dependency-free line LCS.
  Device-local, per-session state lives in its own tiny stores — `lib/drafts.ts`
  (unsent prompts) and `lib/pins.ts` (pinned threads), both pruned from
  `refreshSessions` and both **scoped to the active server** (`lib/server-scope.ts`),
  along with `pastes.ts`, `draft-attachments.ts`, `agent-options.ts`,
  `thread-defaults.ts`, the sidebar's collapsed folders and the tasks board's
  remembered board. Every one of those keys is an id the *server* minted — a session,
  a profile, a project, a board — and unscoped they meant a `prune*` run at server B's
  bootstrap deleted server A's unsent drafts and pins, since the sweep walks
  `localStorage` by prefix and every id looked equally dead. `scopedKey`/`scopedPrefix`
  are resolved **per call**, never captured, because the active server moves without a
  reload now; `createScopedLocalStore` is `createLocalStore` with a key that follows the
  scope and a re-read when it does; and `onBeforeScopeChange` is the deadline the
  debounced draft/paste buffers flush against, exactly as `pagehide` is — a 300ms window
  that outlives the switch would write the old server's text under the new one's key.
  A one-shot `migrateLocalScope` adopts the pre-scope keys into whichever server was
  active when the build first ran, which is the only server they can have belonged to.
  What is *not* scoped is what is genuinely the reader's rather than a server's: the
  theme, the keybindings, the view options, the sidebar's sort. (`lib/workspace/buffers.ts`
  is the known exception — unsaved editor buffers are keyed by filesystem path, and a
  path is the machine's.) `lib/view-options.ts` (timestamps/tool grouping/density) is
  device-local too but **global and persisted**: one set of reading settings for
  every thread, keyed by nothing, so `useViewOptions()`/`setViewOption(key, …)`
  take no session and there is nothing to prune. Per-session was the older rule
  and it meant finding and flipping the same switch again in every thread — how a
  transcript is drawn is a property of the reader, not of the conversation. The
  pre-global blob (`{ [sessionId]: Partial<ViewOptions> }` under the same
  `ui.viewOptions` key) is folded into the one set on first read, later threads
  winning, rather than dropped. **The sidebar
  is `components/thread-sidebar.tsx`**, laid out like the Codex and Claude desktop
  apps: fixed nav rows on top (`SidebarNav`: New thread, Search, Tasks — menu rows,
  so they survive the icon rail), then Pinned, a flat Recents, **one folder per
  project** with its threads under it and a hover `+` that starts a thread *in*
  that project, Scheduled, Trash. **Recents puts every running thread at the
  top**, whatever its age, and there is no Running tier of its own any more: a
  tier above Recents drew the same threads twice, and by-activity order alone
  buried the turn that is happening *now* under whatever was typed most
  recently. Pinned and Recents are **shortcuts, not
  places**: a folder holds every one of its project's threads, the recent and
  the pinned included, because a folder that dropped whatever was recent was an
  incomplete index of its own project — with the newest thread, the one most
  likely to be looked for, the one missing from where it lives. Inside a folder
  the rows are **grouped by period** (`periodLabel` in `lib/time.ts`, `grouped`
  on `ThreadList`): Today / Yesterday / Previous 7 days / Previous 30 days, then
  by month. Counted in calendar days, so 00:10 says "Yesterday" about 23:50, and
  the headings are inserted over the rows that are *visible*, so `limit` still
  counts threads and "Show more" can never reveal an empty heading.
  **Every one of those orders — and the period a row is filed under — is
  `activityAt` (`lib/settings.ts`), the last *turn*, never `createdAt`**: a
  thread is recent because something was said in it, so an old thread picked up
  this morning belongs at the top of Recents and under Today, and ordering by
  creation buried it under threads nothing had happened in for weeks. The clock
  is `sessions.last_activity_at`, bumped server-side in `SessionManager.emit` on
  the journaled `turn_started`/`turn_ended` — once per turn, not once per
  streamed token — and reported by `list()`. **Reading is not activity**:
  attaching journals nothing, so opening yesterday's thread does not promote it,
  which is also why the client's own optimistic stamp (the `turn-active` case in
  the store) fires on a turn *starting* only — `turn_ended` is replayed, and
  stamping on it would move a thread to the top of the list for having been
  scrolled. Rows written before the column existed read 0 and are backfilled
  from the journal's own `max(at)` in `reload`, once, rather than by a migration.
  Rows are one line and title-only: a running turn
  **shimmers the title** (`harness-shimmer`, the same band as the working line and a live
  thought), a thread waiting on you gets an amber dot at the trailing edge; agent,
  profile, model, project, start time and — when it says something the start
  time does not — last active live in `ThreadInfoCard` — one popover
  that opens on hover (Base UI `openOnHover`) and, on a phone, on long press,
  where it also carries the row's actions (it replaces the right-click menu there). Every row, label and group draws from
  one scale (`ROW`/`MENU`/`GROUP`/`TIER`, exported for the settings nav too). The
  main surface (`SidebarInset`) is `bg-card` over the sidebar's tinted ground, and
  the Threads label carries a sort/filter menu (recent first / by project;
  all / running / needs you) remembered per device as `ui.sidebarView`. Fold
  state is `ui.collapsedProjects`, keyed by project id. The shelf above
  the composer is `components/composer-strip.tsx`; app icons regenerate from
  `client/build/icon.svg` via `pnpm icons`.
  **Everything with a face is drawn by `components/entity-icon.tsx`**: `EntityIcon`
  is the one round, ringed mark (picture when the URL loads, fallback otherwise,
  a broken URL remembered per src), and `AgentIcon` / `ProfileIcon` /
  `ProjectIcon` wrap it with each entity's rule for where the picture comes from
  — built-in brand PNGs, the profile's `logoUrl` (else its agent's mark), the
  project's `logoUrl` (else its initial in a disc whose hue is hashed from the
  name). Projects carry `logo_url`; the API reports `""`
  for none, like profiles. No component draws a folder for a project any more.
  **Settings › Knowledge base** (`components/settings/knowledge.tsx`) is the cross-project
  view of what the built-in `knowledge` MCP server has written: one `GET /api/knowledge`
  (`listAllKnowledge` in `server/src/knowledge.ts`, every entry newest-updated first with its
  `projectName` resolved server-side), grouped by project on screen with a project filter,
  delete and a hand-written add — both through the existing per-project routes, which the
  project form's own knowledge section still uses.
  Theme/layout ported from
  `/var/www/mawared-off/social-live-agent/ai-agent-web` (glass surfaces, Inter, step-row
  transcript). Electron shell lives in `client/electron/` (frameless, vibrancy/acrylic).

- **`/settings` itself is a page, not a redirect** (`components/settings/overview.tsx`):
  every section as a link, in the groups the sidebar nav draws
  (`SETTINGS_NAV_GROUPS`). It exists for the phone, where the sidebar is a drawer
  that closes on every pick — "Settings" used to drop you into General with the
  other sections behind the menu button. Every opener that means *settings* and
  not a section (the footer row, the palette's "Settings", an unknown
  `/settings/<x>`) lands there through `settingsRootPath`; the nav rows and the
  palette's per-section entries still go straight to a section. The nav's first
  row, "All settings", is lit when no section is (`section === null` in
  app-shell, which is also what drops the "Settings" suffix from the header).

## Composer

- **The composer is one component, `components/composer.tsx`, and one card of two rows.**
  The textarea, and under it a single toolbar reading *what goes in → where it goes → what
  happens*: a "+" menu (attach, take a photo on touch, mention a file, run a command, insert a
  code block, clear), the model/config cluster, the length reading, the context ring, then
  expand, voice, pause, stop and a filled primary Send. It used to be five loose buttons on a
  row that a phone overflowed first; every way of *adding to* the message is behind the "+",
  and every way of *sending* it is behind the chevron beside Send (queue or steer while a turn
  runs, Schedule…, and the Enter preference). A long-press on Send (touch) and a right-click
  (mouse) open that same menu, so the chevron is a hint, not the only door.
- **Two "mobile" answers, used for two different things.** `useCoarsePointer` (the device's
  pointer) sizes the touch targets — 36px on a finger, 32px on a mouse — and decides whether
  "Take a photo" is offered (`capture="environment"` on a second picker: `capture` is an
  attribute, not a mode, so the attach picker stays gallery-first). `useIsMobile` (the width)
  keeps deciding what Enter means, because a soft keyboard is a width question in practice.
- **What Enter does is a preference, not a key binding** (`lib/composer-prefs.ts`,
  `ui.composerPrefs`, global and device-local like the view options). `enterSends` on: Enter
  sends, Shift+Enter breaks the line. Off: Enter breaks the line and the steer chord (an
  ordinary send while nothing runs) or the button sends. Rebinding Enter in `keybindings.ts`
  was refused for a reason — that is a broken composer — but choosing its meaning is what
  every chat app offers. Touch ignores the switch; Return is always a newline there.
- **Expand is about this prompt, not the reader**: state, never persisted, offered once the
  text is more than a sentence (`LONG_PROMPT_CHARS`/`LONG_PROMPT_LINES`) and folded back by a
  send. The taller box is a fraction of `--panel-h` (the viewport outside the dock), half a
  phone. The length reading beside it prints a *rough* token count (4 chars ≈ 1 token) with a
  tilde, so a pasted document reads as "about 3k tokens" before it goes rather than after.
- Every insertion the "+" menu makes (`@`, `/`, fences) goes through the `@` completer's
  `requestCaret` slot, for the reason `file-mentions.tsx` documents: rewriting `text` is a
  render, and the caret must be re-applied after it. A command is put at the *front* of the
  text wherever the caret was, because the completer reads `^/name`; a mention is a word and
  earns a space before it; fences go on their own line.

## Slash commands

- **A slash command is either the agent's or the harness's, and the composer draws one
  list.** Agent commands come from `available_commands_update` and are ordinary prompts —
  `/name args` is sent, the agent resolves it, the send path is untouched. The harness's own
  (`HARNESS_COMMANDS` in `components/slash-commands.tsx`, declared in the same
  `acp.AvailableCommand` shape) are the exception the send path knows about:
  `harnessCommandFor` reads the composed text in `Composer`'s `send` (`components/composer.tsx`) and, for
  `/schedule`, opens the schedule form with the rest of the line as its message instead of
  sending anything. That is how a message is scheduled now — the clock button beside the
  composer is gone: scheduling is *what to say and when*, which is typing, not a second
  control in a row of send/stop/voice. The composer's draft is deliberately **not** cleared
  on that path (nothing was sent, and the form can be backed out of), and a **draft thread
  is offered no harness commands at all** — `/schedule` needs a thread the server knows
  about, which a draft is not until its first message. The agent's catalog **shadows** the
  harness's: a runtime advertising its own `/schedule` keeps it, and `harnessCommandFor`
  then declines to intercept, because a name collision must cost the harness's command and
  never silently swallow the agent's. Harness rows draw with their own mark (`HARNESS_ICON`)
  rather than the generic slash, so a row that opens a harness surface does not read as one
  more thing the agent will answer.

## `@` mentions

- **An `@` mention is text in the prompt and a `resource_link` beside it.**
  `components/file-mentions.tsx` is the composer's file completer — the same strip row,
  the same key contract and the same mousedown rule as `slash-commands.tsx`, but the token
  is read **at the caret** (a file is named mid-sentence, a command never is), which is why
  the hook takes the textarea's ref and tracks the caret itself: a pick rewrites `text` and
  the caret it wants must be re-applied after that render, ahead of the sync from
  `selectionStart`, or the placement is undone by the effect meant to follow it. Picking a
  directory completes to `@path/` and leaves the token open so the next keystroke drills in;
  picking a file completes to `@path ` and is done. It reads one route,
  `GET /api/projects/:id/files/search?q=` (`searchEntries` in `workspace-fs.ts`): a
  breadth-first walk of the project — not `git ls-files` or `rg`, neither of which a project
  is guaranteed to have — skipping `DEFAULT_IGNORES`, never descending a symlink, budgeted at
  `SEARCH_VISIT_LIMIT` entries and ranked by a greedy fuzzy score that rewards adjacent runs,
  separator boundaries and basename hits. Breadth-first is what makes a *truncated* walk
  still useful: it returns the shallow paths, which are the ones a person meant. What the
  composer sends is unchanged — plain `@src/index.ts` in the text, so the draft, the queue,
  the journal, Retry and the prompt-history walk all stay strings and none of them learned a
  second shape. The protocol half is the server's: `AcpBridge.prompt` appends the
  `resource_link` blocks that `server/src/mentions.ts` derives from the text, and **only for
  a token that resolves to something existing inside the session's cwd** — prose is full of
  at-signs (an address, a handle, a decorator) and inventing a file reference for one sends
  the agent after a path nobody named. Containment is checked lexically and then against the
  real path, like every other path in `workspace-fs`, because `@../../.ssh/id_rsa` is user
  input naming a file *for an agent to open*. Both halves travel on purpose: the text is what
  every runtime already understands, the links are what a runtime that reads the protocol can
  resolve without guessing, and dropping the text would make the transcript stop saying what
  the user typed.

## Panel vs device width

- **"Mobile" is two questions: width is the panel's, the pointer is the device's.**
  A dockview panel is a box inside the window, so a media query is the wrong instrument
  for anything a *panel* has to fit — a chat squeezed to 320px beside a terminal was
  drawing the desktop layout because the window was still 1600px wide.
  `components/workspace/panel-container.tsx` wraps every panel's content, in the one place
  the component map is built (`dock.tsx`), in an unnamed `@container`, and `index.css`
  declares `--container-panel-sm: 40rem` / `--container-panel-md: 48rem` — deliberately the
  pixel values of `sm:`/`md:`, since the variants they replace were written against those.
  So layout that needs *room* (the workflow table's activity column, the queue rows that
  wrap their actions, the strip's inset and its collapsed labels, the turn rail) is
  `@panel-sm:`/`@panel-md:` now. Touch targets, the terminal's soft key bar and
  Enter-inserts-a-newline stay on `useIsMobile` and plain media queries, because a narrow
  panel on a desktop is still driven by a mouse; and viewport-centred things (the dialog
  that becomes a drawer, the sidebar sheet) stay on the window because that is genuinely
  what they are measured against. The container is `inline-size`, not `size` — sizing both
  axes means size containment, and a panel whose height failed to resolve would collapse to
  nothing rather than merely lay out wrong. That leaves `cqh` unavailable, so the panel's
  **height** is measured by one ResizeObserver and published as `--panel-h`, written to the
  style attribute rather than held in state (it changes every frame of a sash drag and
  nothing renders differently for it). Every `svh`/`vh` cap inside a panel — the shelf, the
  approval's evidence band, `PANE_MAX_H`, the error fallback — reads
  `var(--panel-h, 100svh)`, and that fallback is what makes the same class correct outside
  the dock.

## Keyboard shortcuts

- **A key that is bound is a key that is listed.** `client/src/lib/shortcuts.ts` holds
  the chord vocabulary (`mod` = ⌘ or Ctrl), the matcher, and the `SHORTCUTS` table that
  `components/shortcuts-help.tsx` (`?` / `⌘/`, and a command-palette entry) prints — so a
  binding nobody can discover is a bug in one file, not two. **A chord is printed by
  `components/shortcut.tsx` and nowhere else**: `Shortcut` draws keycaps on shadcn's
  `Kbd`/`KbdGroup`, from a chord (`chord="mod+k"`, split by `chordKeys`) or from literal
  caps (`keys={["1…9"]}`) for a range or a glyph that is not a binding. Every surface reads
  it — the sheet, the palette, the `+` menu, a tooltip, the sidebar's hover hint, the
  permission card's digits — because they each used to draw their own: half printed
  `formatChord()` into bare text and half built keycaps by hand, so one chord read three
  ways depending on where you met it. `formatChord` survives for the places a chord has to
  be a *string* (a tooltip prop, an aria-label). `CommandShortcut`/`DropdownMenuShortcut`
  drop their letter-spacing when they hold a `kbd-group`, since tracking meant for bare
  glyphs pulls keycaps apart. `hooks/use-hotkey.ts` binds on
  `window` with the handler in a ref and skips an event another handler already claimed
  (`defaultPrevented`), which is how a local owner — the slash menu's arrows, a dialog's
  Escape — always beats a global. Scope is the real decision: global keys are unguarded,
  **thread keys are gated on `currentThreadId(location)`** because the dock keeps every
  opened transcript mounted and only the routed one is in front, and composer keys stay on
  the textarea where the caret is what they are about. `ThreadView.useThreadKeys` owns the
  whole Escape chain in one place — skip the elicitation, else reject the permission (only
  if the agent offered a reject), else stop the turn — rather than letting each card bind
  it and race. Digits/Enter answer a permission only when `isTypingTarget`/
  `isInteractiveTarget` say nothing else owns the key. Prompt history (↑/↓) reads the
  transcript's own user turns: no second store, nothing to persist, and nothing that can
  disagree with what is on screen.
  **And a key that is bound is a key that can be moved** (Settings › Keyboard,
  `components/settings/keyboard.tsx` over `lib/keybindings.ts`): a device-local,
  global store — the same bargain `view-options` makes — keyed by a **`ShortcutId`
  on every `SHORTCUTS` row**, so a relabelled shortcut keeps the chord somebody
  chose for it. What is stored is only the difference from the defaults, which is
  what lets a later release move a chord for everyone who never touched that row.
  Nothing reads `KEYS` to *bind* any more: `useShortcut(id, handler)` resolves the
  chords through the store, `Shortcut id="…"`, `useChord`/`useChords` print them,
  and the help sheet renders the bound chord rather than the shipped one — which
  is also why `ui/sidebar.tsx`'s own hardcoded ⌘B listener is gone, since a
  registry component quietly owning a chord is exactly the second table the rule
  exists to prevent. Two things beyond a chord. **A binding is not automatically a
  win**: the browser has its own defaults, so `Binding.override` (on by default —
  what every handler did by hand before) is what decides whether `useShortcut`
  cancels the event, and a handler bound through it must not `preventDefault`
  itself; a handler that only *sometimes* owns the key returns `false` to decline
  it, which is how `?` typed into a prompt stays a character. And **override
  cannot buy back a key the page never receives**: `reservedChord` splits the
  browser's claims into `soft` (Find, Save, Print — cancellable, which is what
  override is for) and `hard` (⌘/Ctrl+N, T, W, Q, R — Chromium never delivers
  them to a tab), so the settings row says in words that a hard-reserved chord
  works only in the desktop shell instead of leaving a dead binding to be found
  by pressing it. Warnings are shown twice on purpose — in the recorder, where
  the question is "do you want this", and on the row afterwards, where it is
  "why is this one not firing" — and an in-app collision is reported with the
  scopes named rather than refused, because Escape in a composer and Escape in a
  thread are deliberately the same key. Rows that are not `rebindable` (Enter
  sends, Escape backs out, the arrows walk the history, a digit picks the option
  it names) are still listed and marked Fixed: an omitted row reads as an
  incomplete list, not a deliberate one. The recorder is a dialog capturing on
  the **capture phase** because while it is open every chord belongs to it — ⌘K
  must be written down, not open the palette — with Escape and Tab left alone so
  a recorder opened by accident is not a trap.

## Errors

- **Errors are never `String(err)`.** `client/src/lib/errors.ts` normalizes everything
  thrown (`AgentError` from `lib/thread-socket`, the plain `{code, message, data}` on a
  `turn_ended`, `ApiError` from `lib/settings`, network failures, aborts)
  into `{ title, detail }`: `describeError` for the values, `reportError(err, context)`
  for the toast, where `context` names the action ("Couldn't save the profile") and the
  normalized title/detail go underneath. Failures that belong to a thread go IN that
  thread instead — `actions.recordError` appends an `error` ThreadItem (title / reason /
  folded detail / `retryText` for a Retry button), which survives longer than a toast and
  comes back on reload from the journaled `turn_ended` (which carries the prompt text, so
  the rebuilt row still offers Retry). `installGlobalErrorReporting()` in `main.tsx` is
  the floor under both.
  **A toast is for a failure that happened *around* the user; a surface that has the
  user's attention holds its own.** `captureError(err, context)` is `reportError` minus
  the toast — same normalizing, same console line, same `markReported` so the global net
  stays quiet — returning an `InlineError` that `components/error-note.tsx` draws next to
  the control that failed (headline, detail clamped to three lines with More, Copy, an
  optional Retry). Every dialog and every form uses it, because a toast is
  bottom-trailing and a dialog covers that corner: the modal's own controls give no sign
  anything went wrong, the user is looking at the thing they pressed, and the card is
  gone in ten seconds while the half-filled form is still there. The sharper half is that
  several of these failures had a **success-shaped fallback** — the import dialog's failed
  scan, the profile form's failed model fetch and the library's failed discovery all fell
  through to an empty list, so "the agent has no past sessions", "the provider serves
  nothing new" and "the request never arrived" were the same screen, told apart only by a
  toast behind the dialog. An error that a surface can render as *emptiness* must be
  rendered as an error by that surface. `FormActions` (settings/primitives) takes the note
  as a prop, which is what puts it on every route-backed settings form at once. Toasts
  stay for what has no surface to go back to: a row action in a list, a copied link, a
  background refresh, a fire-and-forget cancel.

## Toasts

- **Toasts are shadcn's Base UI toast, bottom-trailing, and raised through one
  module.** `components/ui/toast.tsx` is the registry component (`Toast.Provider` +
  `createToastManager`) kept close to as it ships so a later `shadcn add toast` diffs
  cleanly — sonner is gone, and with it the two workarounds it needed: the `theme` prop
  forced past next-themes (this one is drawn entirely out of the palette's tokens) and
  the `[data-sonner-toast] [data-description]` override in `index.css` for a description
  colour sonner hardcoded per theme. `lib/toast.ts` is the sentence form of the manager
  and the only thing call sites import: `toast(title, {description, action, id,
  duration})` plus `.success/.error/.warning/.info/.loading/.dismiss/.promise`, which is
  the vocabulary the app was already written in. Two translations live there and nowhere
  else — a fixed `id` is an **upsert** (`add({id})`, which the pwa-update and
  enable-notifications offers both depend on to replace rather than stack), and
  `duration: Infinity` is Base UI's `timeout: 0`, the same idea spelled with the
  opposite sentinel. **Anything with a visible wait uses the promise form**, and through
  `reportPromise` in `errors.ts` rather than `toast.promise` directly: one card that is a
  spinner while the work runs and becomes its own outcome, with the failure branch wired
  through `describeError` so a rejection reads exactly like the `reportError` toast it
  replaces — same headline, same detail, same Copy — instead of the `String(err)` a promise
  toast otherwise degrades to. It marks the rejection reported and passes it on, so a caller
  can still reset its busy state without the global net saying it twice. The layout rules
  are in the component: the action button sits *inline* beside a bare title and *under* a
  description (next to wrapping text it would squeeze the copy into a gutter), and
  descriptions wrap on `[overflow-wrap:anywhere]` with `whitespace-pre-wrap` and a
  five-line clamp, because what they carry is paths, commands and server errors — one long
  unspaced token used to push the card wide rather than break.

## The dock

- **The dock holds four panel kinds: chat, ide, terminal and web (the *Browser* panel).**
  The IDE panel (`components/workspace/ide-panel.tsx`, descriptor `{kind:"ide", projectId}`)
  holds four surfaces that are one product: the editor, the file explorer, file search and
  source control.
- **Monaco is the text surface and the diff, and nothing else.** The official `monaco-editor`
  package — not `@codingame/monaco-vscode-api`, which is what this replaced. That library
  gave the real VS Code workbench in the page, and with it the whole of VS Code's service
  architecture: forty-odd override packages pinned in lockstep, an in-page extension host, a
  file system provider, an SCM provider, a content-scheme registry, a CSS-as-string Vite
  plugin so its stylesheets did not restyle the app, and one hard rule — services are global
  and `initialize` may be called once per page — from which everything else followed. The
  panel had to be a singleton element parked in a detached holder, switching project was
  `reinitializeWorkspace`, and every feature was a service override rather than a component.
  What that bought was an explorer and an SCM view drawn in VS Code's design language rather
  than this app's, for about 15 MB. Monaco alone is the part nobody should rewrite; a file
  tree and a list of changed files are two afternoons and they then look like the rest of the
  app.
- **The explorer, the search and the source control are the harness's own.**
  `file-explorer.tsx` caches listings **per directory** (`Map<dirPath, entries>` plus a set of
  expanded paths, so a watch event invalidates exactly the directory that changed and every
  other branch keeps its expansion and its scroll), and the server is the authority on what
  exists — create, rename and delete re-read the directory rather than inserting a row
  optimistically. `file-search.tsx` is the route the composer's `@` menu already reads, so
  there is one idea of "roughly this name"; it is file *names*, since the server has no grep
  route, and that limit is stated rather than hidden. `scm-view.tsx` groups `git status` the
  way git thinks — merge, index, working tree, untracked — and every button is a `gitWrite`
  against the project's existing routes; a row's mark is read back from the next status,
  never inferred from what was clicked.
- **A project is not one repository, and the source-control view starts from the list.**
  `GET /api/projects/:id/git/repos` walks four levels below the project for `.git`
  directories (breadth-first, capped, never descending into a checkout) and lists the
  project's own first — which may be a worktree rooted *above* the project, scoped. The view
  draws a **section per repository**, each with its own status, staging and commit box,
  because an index and a HEAD belong to one repository and a commit box spanning two would
  be a button with no single thing to do; with exactly one repository the section chrome
  disappears. Every read and write carries `repo` (project-relative, `""` for the project),
  and the paths inside a status are **relative to that repository** — `projectPath` in
  `git-api.ts` is the one join back to a path the file routes take, so opening a row from a
  nested repository does not read a file that is not there. Past eight repositories a section
  reads its status when first expanded rather than on mount, since each is a git process. The
  list is re-walked only when a `.git` appears in the watch stream, not on every write.
- **Changed files are a tree, and the reader chooses.** `lib/workspace/git-tree.ts` is
  generic in what a row carries (a `GitFileState` in source control, a `ChangedFile` in the
  turn-changes tab) and folds single-child chains into one row (`src/lib/ide`, not three rows
  holding one child each) — the thing that makes a tree readable in a 320px column. A folder
  row acts on everything under it, which on a phone is the difference between one tap and
  twelve. Tree or list is `lib/ide/prefs.ts`: device-local and global, like the transcript's
  density, and deliberately not on the panel descriptor, where it would be one panel's in one
  layout and serialized into stored layouts. The two surfaces remember it separately.
- **Touch is the device's; width is the panel's.** Row heights and icon buttons follow
  `useCoarsePointer` (44px on a finger, 24–28px with a mouse), and row actions are always
  visible on a finger because there is no hover to reveal them. Below 560px of *panel* width
  the side view and the editor take turns — a 224px explorer beside a 130px editor is two
  things you cannot use — and picking a file or a diff is what closes the side view. The turn-
  changes tab does the same with its file list and its diff under `@panel-md`.
- **Workers need no wiring, and that is worth not undoing.** Since 0.56 Monaco declares every
  worker it starts as `new Worker(new URL(…, import.meta.url))` inside the package, which is
  exactly the shape Vite compiles into a worker chunk. Defining `MonacoEnvironment.getWorker`
  would *override* that with paths we would then have to keep true by hand, so `lib/ide/
  monaco.ts` deliberately defines nothing.
- **What is open inside the IDE is the IDE's state, never the dock's.** The old editor
  descriptor carried a path and a comparison, which is why a file at a second line was a
  second panel and why `reveal.ts` existed to work around it. Now the descriptor is the
  project alone and the tabs are a module store (`lib/ide/editors.ts`): they survive the panel
  being closed and reopened, a reveal is a one-shot field on the tab, and a dirty tab is
  known to the tab bar and to the close confirmation without either asking the editor.
  Unsaved text survives a *reload* through `lib/workspace/buffers.ts`, which matters because
  this app reloads itself on purpose when a service-worker update is taken.
- **`lib/ide/open.ts` and `lib/ide/editors.ts` name nothing from Monaco, and that is
  load-bearing.** They are imported by the transcript, which every reader loads; a static
  import of the editor there would put Monaco in the app's entry chunk. A request is plain
  data written into the store, so there is no queue and no performer — a request made before
  the panel exists is simply a tab already open when it appears. Monaco arrives through
  `lib/ide/monaco.ts`'s dynamic import, and its chunks are excluded from the service worker's
  precache **by name** (`injectManifest.globIgnores` in `vite.config.ts`: `editor.api-*`,
  `vs-*`, `*.worker-*`, the codicon font). By name rather than by size, because the size rule
  alone lets the small pieces in and then *warns* about `ts.worker` — and vite-plugin-pwa
  treats that warning as a failed build. Offline, the IDE is the one surface that does not
  open.
- **A turn's changes open as a tab, not as a panel of their own.** The "N files changed" chip
  under a turn (`TurnChangesChip` in `thread-view.tsx`) opens the IDE and requests the scope;
  `changes-tab.tsx` draws the files as a tree (twelve files across four directories is
  unreadable as twelve full paths) and a Monaco diff per file, both sides read whole from
  `GET /api/sessions/:id/changes/file` — the before side from the turn's start tree, the after
  side from its end tree once it has ended and from the working file while it is still
  running. Staging, discarding and committing are not here: they act on the worktree as it is
  now, which is the source-control view's subject and not this one's.
- **The editor wears the app's palette, and the conversion is the browser's.** Monaco's theme
  format takes a hex string per key; the app's palette is `oklch()` and `color-mix()`. So each
  token is resolved by painting it into a 1×1 canvas and reading the pixel back — the one
  thing that understands every CSS colour syntax there is — with a sentinel test around it,
  because `fillStyle` silently keeps its previous value for a colour it cannot parse. The
  syntax hues are `--code-*` in `index.css`, the same values the transcript's fenced code
  uses, so a file and a diff of that file read as the same language. Both themes are rebuilt
  on every theme change (`syncMonacoTheme`), which is what makes a *custom palette* move the
  editor and not just light↔dark.
- **What stayed on the server.** `src/ide.ts` and `src/ide-proxy.ts` — the per-project
  `code-server` spawn and its `/ide/<key>/` proxy — are still there and still routed, and
  nothing in the client reaches them any more. The output and agents panels remain gone for
  the reasons they went: both were second copies of something already drawn where the work
  is.

- **A project has a page of its own (`/projects/<id>`), and it is assembled from two
  halves on purpose.** Until it did, a project was a row in settings (a form), a folder in
  the sidebar (a list) and a name in a thread's header — three surfaces that each say a
  *part* of what a workspace is and none that answers "what is this project, and what has
  happened in it". `components/project-page.tsx` is that answer: the header (mark, name,
  the cwd as a copy button, description, Edit / New thread), four tiles, a 30-day activity
  strip, the project's threads, and the rails beside them (what it is worked on with, what
  is scheduled against it, what it has accumulated). The **live** half is the store's —
  `state.sessions` already carries every thread with its process state, so the thread list,
  the running/waiting dots and the scheduled rows need no request and are right the moment a
  turn starts; the status reading is the sidebar's exactly (`turnActive` ?? `promptActive`,
  a pending permission or elicitation outranking both). The **settled** half exists only in
  SQLite and arrives as one `GET /api/projects/:id/stats` (`server/src/project-stats.ts`,
  `lib/workspace/project-stats.ts`) — one route, so the page paints once, refetched on mount
  and by Refresh and **never on a timer**: nothing in it is worth a poll, and the half that
  moves is the half that already moves on its own. Two rules in the numbers. **Turns, not
  events**: an event is a streaming chunk and a long turn is thousands of them, so
  `session_events.kind = "turn_started"` — journaled exactly once per turn — is the only
  countable that means anything to a person, and the activity strip is grouped by
  `date(at, 'unixepoch', 'localtime')` in SQLite (a UTC bucket cuts every evening in half
  for half the world) and re-expanded client-side into a fixed run of days, because a bar
  chart missing its empty days reads as busy. And **a tile skeletons rather than zeroes**
  while the fetch is out: a 0 that becomes 400 is a statement the page made and took back.
  `cwdExists` is the one health answer it can give — a project whose directory has moved
  spawns nothing, and that failure otherwise surfaces as an ENOENT inside a thread. The
  Its Threads card carries the one **bulk action** in the app: Select turns the
  rows into checkboxes and deletes the picked ones through `actions.deleteThreads`
  (sequential DELETEs, one `refreshSessions` at the end) — reversible, into
  Trash, exactly like the per-row delete. Selection is a mode rather than a
  permanent checkbox column, because the ordinary reading of the list is one
  click per row into a thread; and "Select all" means the rows **shown**, never
  the ones behind a "Show all" nobody pressed. The
  page is reached from the folder's hover control in the sidebar, the project name in a
  thread's header, the palette's Projects group and the settings row — settings keeps the
  *form*, this is the workspace as a thing with a history.

## Routines and schedules pages

`/routines` and `/schedules` are places, not settings sections, and both are drawn
the way the project page is: a `SurfaceHeader`, a row of `StatTile`s, then the list
(`components/page-primitives.tsx` holds those pieces; nothing in it knows which
surface it is on). **The sidebar reaches each through one fixed nav row** (Routines,
Scheduled — beside Tasks and Notifications, carrying the armed count) and lists
neither. They used to be two fold groups under an "Automations" tier, each a smaller
copy of its page's list with fewer controls: the page had to exist anyway for the
detail views, so the sidebar copy was a second surface to keep consistent, a second
place a row's menu had to be maintained, and the way *to* the page was a pencil that
only appeared on hover once something existed. A page that is a URL gets a row that
goes to it.

- **The routines list reads one extra thing: the newest run of every routine**, one
  `limit=1` request each through `useQueries`, on the visit and never on a timer, so a
  row can say what happened last and the tiles can count running and blocked runs across
  every routine. Mutations invalidate `routineRunsFamilyKey` — the prefix under every
  limit — never one limit's key, or the list and the detail page would disagree after a
  fire. Rows are filed under their project; a routine whose project is gone is listed,
  not hidden.
- **A routine's page is one URL with four tabs** (`?tab=overview|runs|triggers|settings`,
  the overview carrying no param). The overview shows a little of each — the newest five
  runs, the triggers with their next fire, the policy as facts — and the tiles say last
  run, next fire, run outcomes and tokens. The counts are over what the page has read
  (the server's newest 50), and say "50+" rather than a total they do not know.
  Triggers and runs are read on this page and nowhere else; `trigger-summary.ts` is how a
  trigger is said in one line.
- **A schedule has a page too** (`/schedules/<id>`), and it has no history section on
  purpose: a delivered message is a turn in the thread it was sent to, and that
  transcript is the record. The page names the thread, says when it fires next and how
  often, shows the skip state, and holds the editor. The list files schedules under the
  thread they land in.
