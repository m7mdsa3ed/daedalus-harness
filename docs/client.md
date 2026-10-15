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
  that file is **hand-maintained**: Default (shadcn's stock palette, whose
  colours are index.css's `:root` / `.dark`) is the only built-in, and
  `src/lib/builtin-themes.ts` is the list the gallery and the palette render,
  which `lib/theme.tsx` re-exports. The generator and the eleven generated
  themes were removed.
  A user-made theme is three blocks (Default needs only the first),
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
  so it can run anywhere, and the studio's "Generate palette"
  runs it, so a hue the user picks is gated against `CONTRAST_PAIRS`.
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
  a picker row. The studio is `components/theme-builder/editor.tsx`: **two columns —
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
  It is also why the settings frame's width is chosen by **`isFullWidthSettings`**
  (`components/settings/sections.ts`, handed to `PageFrame` as `full` or
  `settings`) rather than the constant `max-w-3xl` it was: forms read at
  `max-w-4xl` now, and the routes that are *not* forms — the studio, and the
  MCP server's own page (a rail of what it offers beside one entry's contract,
  `mcp-detail.tsx`) — take the frame's full width, because at a form's measure
  the preview shrinks to a thumbnail, the colour grid wraps its light/dark pair
  onto separate lines, and the rail leaves the field list a column too narrow to
  read. Matched on the pathname there rather than declared per
  route, because the layout is what renders the container and it only knows the
  location; and set by the layout rather than by each page, or the frame would
  jump width as you moved between them.
  **The window's own material — macOS vibrancy, Windows Acrylic or Mica — is
  native window state, not a theme token.** On Windows its device-local choice is
  in Appearance; Electron only accepts `backgroundMaterial` when creating a
  window, so a change is saved for the next app launch and applies to new thread
  popouts immediately. Acrylic remains the default. The `data-desktop-vibrancy`
  blocks in `index.css` drop the page ground so the OS material shows through;
  the preload sets the attribute before first paint on macOS and Windows, where
  the material is available. Mica is offered despite its known limitation:
  on Windows 11 build 26200 it drew nothing behind a frameless window in our
  measurement, leaving near-black through the transparent page; Acrylic draws
  the desktop wallpaper there.
  **The colour before the app exists is
  `src/lib/boot-colors.ts`** — the address-bar tint, the inlined splash and the
  manifest all need the background named before any stylesheet is parsed, so it
  is written once there in hex and pulled in three ways: `lib/theme.tsx` imports
  it as a fallback, `vite.config.ts` imports it for the manifest, and the static
  `index.html` carries the same two hex values as literals (kept equal by hand —
  it cannot import). It is the *Default
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
  **drawing** one is `components/tool-views/` on top of the primitives in
  `components/tool-parts.tsx` (which exists so those two and `thread-items/rows.tsx`
  can share a pane without importing each other). No component matches on a
  vendor tool name: `toolViewOf` picks the layout and the matching `extract*`
  supplies the fields, so a new runtime's tool is one file's edit. Reading a
  vendor's `_meta` block is unavoidable — it is ACP's extensibility hatch and
  every adapter uses it — but the *namespace* is named once, in
  `lib/tools/helpers.ts` (`VENDOR_META`/`vendorMeta`): seven files spelled
  `asRecord(asRecord(item.meta)?.claudeCode)` by hand, so a renamed block or a
  fourth runtime was a grep. Each reader still knows its own dialect's shape,
  because a shape is not a name. ACP `kind`
  still decides the layout *family* — it is the part that is protocol — but it
  is too coarse on its own, because the three runtimes describe the same act
  three ways: a checklist arrives as tool input under `think` from Claude Code,
  under `other` from OpenCode and as a real ACP plan from Codex; an MCP call
  arrives under `execute` from Codex (`mcp.<server>.<tool>`, `{server, tool,
  arguments}`) and as `mcp__server__tool` from the others; a web search arrives
  under `search`, which is also where ripgrep lives. Each of those rendered as
  a JSON dump or a wrong-shaped pane before it had a view — as did a
  `MultiEdit`, whose hunks are one level down in an array. The harness server's
  two meta-tools are the newest such view (`tool-views/harness.tsx`,
  `lib/tools/harness.ts`): `harness_run`/`harness_help` reach every part of the
  harness, so their row names the operation (`tasks_create` reads "Create
  task", captioned with the name it was given) and their result is drawn as
  the operations list, a field-set, or — for a list — a table of at most three
  chosen columns (`harnessTable`), with the unabridged JSON folded below. A
  `data:` URL is "inline image · N KB", never its base64. The closed row says
  the same without opening: the mark is the *act* (`harnessAction` — plus,
  pencil, bin, list; a removal wears the failure red), the trailing reading is
  the outcome ("11 projects"), and a list's first names are chips under the
  title (`HarnessPreview`, the `below` slot). **JSON is a tree, not
  a dump** (`JsonView`, `tool-parts.tsx`): every place a call arrives *as* JSON
  is drawn as foldable nodes — the arguments `ToolInput` falls back to (which is
  also what `McpDetail` points it at, and what the approval card shows in place
  of its raw-input well), and whatever `SmartBlock` recognized as a document —
  a key in its own colour, a folded node summarizing itself, because the shape
  of an MCP result is the thing you opened the step to see and a brace-matched
  wall of text is what you were doing instead. `preview` is the caller's,
  because the two sides are not the same payload: arguments open three levels
  (they are what you came to read), a returned document one. A *flat* object
  is deliberately left as the key/value table or the one-liner it already was —
  a tree of four scalars is a table drawn with more punctuation. It replaces the
  JSON *block* and never the code block — `parseJsonDocument` is what says the
  bytes are a document — so a log file beginning with `{` still lands where it
  did, and a payload that will not parse keeps the block it already had. A
  `SmartBlock` in the error tone is deliberately not parsed at all: a failure is
  read for what went wrong, and its copy is `CodeBlock`'s. Depth is a mount-time
  read (`depth < preview`), so opening a node does not re-fold what is under it;
  a child list stops at `JSON_CHILD_LIMIT` with an "N more" row, the same
  bargain `OUTPUT_LIMIT` makes; and nothing in the tree is a vendor's, so it
  lives with the panes rather than in `tool-views/`. Its colours are
  `--color-code-*` in index.css, tied to the same `--code-*` palette the
  transcript's own fences use but named for the *roles* the tree gives them, so
  a JSON key and a JSON boolean read as one language across a `CodeBlock` and a
  tree of the same bytes. The loudest of them
  is **the terminal**: Codex announces every shell command as `content:
  [{type:"terminal"}]` and streams the bytes through `_meta.terminal_output_delta`
  on later updates, *whether or not the client claimed the capability* — the
  content block is a handle, not a payload, and `_meta` is merged key-wise per
  update, so drawing it printed the literal `[terminal]` and kept only the last
  chunk. `applyTerminalMeta` accumulates the chunks onto `ToolItem.terminal` in
  the store reducer, which is also what makes replay work, since a replayed
  thread runs the same reducer over the same journaled updates.
  **A row's default expansion is the view's own decision, and the view is not known
  when the row mounts.** `opensByDefault` is a column on the same table as `Detail` and
  `hasDetail`, so a diff, a checklist and a plan stand open and everything else is a one-line
  row; `toolOpensByDefault` adds the one cross-view rule (a background task keeps producing
  after its turn ends, so folded it would be the one live thing on screen and invisible). The
  trap is that a streamed call mounts with no input — `toolViewOf` answers `generic`, and a
  `generic` row has no disclosure at all — and only becomes an `edit` when its arguments land,
  so a `defaultOpen` read once at mount is thrown away and the diff waits for a click that no
  part of the transcript asked for. `StepRow` therefore applies a `defaultOpen` that becomes
  *newly* true exactly once and only toward opening: the edit opens the moment it is readable,
  and a row the reader closed is never reopened by the rest of its own stream. The other sync —
  the one behind "Show thinking" and "Expand tool output" — is keyed on the option and not on
  `defaultOpen`, for the same reason in the other direction: re-applying the whole expression
  would yank open every row the reader had closed while it streamed.
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
  (`tool-views/web.tsx`) is the `below` slot of every `StepRow` — a shadcn
  `AvatarGroup` stack of site favicons, one per host a search returned (result
  order, a `+N` count past six that opens the rest) or the page a fetch read —
  visible whether the step is open or not, so a collapsed run still says which
  sites answered. Each avatar is a link, rendered with Base UI's `render={<a/>}`
  so the anchor *is* the avatar root and the group's ring selector
  (`*:data-[slot=avatar]`) still finds it. The two strips answer different questions: the row's is
  "what did this call see", the turn's is "what did the answer use".
  **A run of subagents is a card whose steps are rows.** A harness workflow and
  an ad-hoc batch of workers are the same question asked twice — a workflow
  knows its shape up front, a batch does not — so `workflow-run.tsx` draws both
  through one `RunRow`: a card whose header carries the run's name, a state
  badge, `done/total`, elapsed, cost and the hold toggle, a line naming the
  phase and step being written and what it is on, and a segmented progress
  strip (a segment per step, a wider gap per phase) drawn even when folded.
  Opened, it defaults to **Browse**: three levels drilled through at full
  width under a breadcrumb — the phases (state, running step, a strip per
  phase), then the picked phase's steps as cards, then the picked step's own
  turn parts, which is `SubagentStep` with `variant="body"` (its `SubagentBody`
  without the header row, because the breadcrumb already says whose it is). A
  one-phase run starts at its steps.
  The same outline has four other readings, picked per card: **Board** (a
  column per phase of step cards, pending ones dashed), **List** (a numbered
  phase stepper with every step's row inline), **Timeline** (a bar per step on
  the run's own clock, start to last activity) and **Flowchart** (Start → phases → End,
  top to bottom so it reads in a narrow panel; a running node lists its latest three calls,
  live, and a settled one its report on three lines — `stepResultOf`, which the board's
  cards also show for a finished step). A subagent step also keeps
  its newest three child rows under the folded header by default — a separate
  preview, not a disclosure of the brief/report — with its reader-global view
  option to hide that preview; opening the row still reveals the full rail.
  Native workflow transcript previews read at most the recent steps while closed
  and the full transcript when opened. Steps the runner has not spawned yet are
  pending rows, so the run's shape is whole from the first spawn and does not
  change under the reader. **The run stays in the transcript**: its views and
  picked step expand inline. It is a reader, never a form. The **Flowchart**
  (`workflow-graph.tsx`, lazy) draws phases as rows, a join dot between two wide phases,
  node borders by step state, a live clock on a running node, a clicked node opening as the
  same step row under the drawing. It draws **phase joins only** — the outline carries no
  `dependsOn`, so an edge inside a phase is never guessed.
  This replaced a preview card (icon tile,
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
  **A settled step says how long it took, and both ends come from the journal.** The
  ticker is this device's and dies with the mount that started it, so a reloaded
  transcript had a start and no end and said nothing: a thought now reads the merged
  run's `at` and `endAt` (see the replay section of `docs/protocol.md`), and a tool call
  the stamps on the update that opened it and the one that settled it
  (`ToolItem.startedAt`/`endedAt`). `StepRow` draws whichever pair it was given, through
  the same 2s gate and the same `formatElapsed` as the ticking one, so a step reads the
  same live and reloaded — and says nothing where its runtime never said an ending
  (a call still open when the turn ends, a session/load replay, whose stamps are the
  reload's rather than the step's).
  **Its detail is capped — `THOUGHT_MAX_H`, a fraction of `--panel-h`, less of a narrow
  panel than a roomy one (`@panel-sm:`, the container query)** — because an unbounded
  reasoning block pushes everything after it off the screen, and a fixed cap is wrong in
  both a phone and a desktop. A cap means the box is the thing that scrolls, so
  `ThoughtDetail` follows *itself*: the transcript's `useFollowStream` measures the
  content element, and a capped box stops growing when it fills, which would leave the
  newest thinking — the part being written — exactly what falls out of view. Settled it
  is inert and opens at the top.
  `components/ui/diff-view.tsx` is a dependency-free line LCS.
  Device-local, per-session state lives in its own tiny stores — `lib/drafts.ts`
  (unsent prompts) chief among them, pruned from
  `refreshSessions` and **scoped to the active server** (`lib/server-scope.ts`),
  along with `pastes.ts`, `draft-attachments.ts`, `agent-options.ts`,
  `thread-defaults.ts` — down to the one field a project row cannot hold, which project
  the front door opens in; what a project's threads are *configured* with is the project's
  own row now (`projects.default_*`, written by `lib/project-defaults.ts`) —
  the sidebar's collapsed folders and the tasks board's
  remembered board. Every one of those keys is an id the *server* minted — a session,
  a profile, a project, a board — and unscoped they meant a `prune*` run at server B's
  bootstrap deleted server A's unsent drafts, since the sweep walks
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
  so they survive the icon rail), then Pinned, an **Opened** tier of the threads
  with a tab open (in dock order — `lib/workspace/open-threads`, published by the
  dock and rebuilt from the restored layout on a reload), a flat Recents, **one
  folder per project** with its threads under it and a hover `+` that starts a
  thread *in* that project, Scheduled, Trash. **Recents lists what is not open**:
  a thread with a tab is in Opened, so it is not also a shortcut below it, and
  closing the tab is what returns it to Recents. The focused tab's row carries the
  active tint in whichever tier holds it. **Recents keeps every running thread in the
  list**, whatever its age, and there is no Running tier of its own any more: a
  tier above Recents drew the same threads twice, and length alone
  buried the turn that is happening *now* under whatever was typed most
  recently. **Running decides membership, never position**: it used to hoist
  those rows to the top, and a status is only *known* for a thread this client
  has connected to — `useThreadStatuses` falls back to the server's
  `promptActive`, a snapshot refetched on bootstrap and on mutations, so
  clicking a row attached its socket, corrected a stale reading and re-sorted
  the list out from under the click that opened it. The order is the sort alone,
  so a correction can add or drop a row at the end of the list and can move
  nothing. Pinned and Recents are **shortcuts, not
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
  Rows are two lines and title-first: the title wears the running spinner in
  its trailing slot and an amber badge for a thread waiting on you, and the
  quiet second line under it carries the agent's own mark, the project and when
  the thread last spoke (the mark is the agent's alone — the tab's paired
  agent-over-project stack needs the 28px tab slot, not this line's). The rest —
  profile, model, start time and, when it says something the start time does
  not, last active — lives in `ThreadInfoCard` — the
  header of the row's ⋯ dropdown (it opens from the ⋯, never on hover), which
  carries the row's actions beside the reading; the right-click menu and, on a phone, long press
  open the same action list. Every row, label and group draws from
  one scale (`ROW`/`MENU`/`GROUP`/`TIER`, exported for the settings nav too). There is no plan-usage
  gauge in the sidebar: the plans are listed on Settings › Usage and nowhere else. The
  main surface (`SidebarInset`) is `bg-card` over the sidebar's tinted ground, and
  the Threads label carries a sort/filter menu (recent first / by project;
  all / running / needs you) remembered per device as `ui.sidebarView`. Fold
  state is `ui.collapsedProjects`, keyed by project id. **Every row wears one status glyph in its trailing slot**
  (`ThreadStateBadge`): the words "Needs you"/"Error" for the two asks, otherwise a
  pause (held at a failure), a spinner (running) or a primary dot (finished since this
  device last looked). Held is `agentState`'s rule asked of every session
  (`sidebar/activity.ts`); **unread is device-local** (`ui.threadSeen`: the `activityAt`
  last in front of you per thread, plus a first-launch baseline so history does not all
  read unread) and is stamped by the thread in front of you — reading is not activity, so
  nothing is written to the server. **Folders roll up** running and needs-you counts when
  closed, and the Threads label carries the total needs-you. A folder wears a heavier,
  faintly tinted header so it reads apart from the two-line rows. **The in-sidebar filter**
  (`sidebarFilter`, Alt+T, or the magnifier on the label) matches already-loaded threads
  by title, project or agent id, locally and unstored; the palette stays the deep search.
  The All / Running / Needs you chips write the same `ui.sidebarView` the menu does.
  **A running or waiting thread's Delete is disabled** in the row menu ("Stop the turn
  first"): Delete is Trash, and Trash stops the agent. The shelf above
  the composer is `components/composer-strip.tsx`; app icons regenerate from
  `client/build/icon.svg` via `pnpm icons`.
  **Everything with a face is drawn by `components/entity-icon.tsx`**: `EntityIcon`
  is the one round, ringed mark (picture when the URL loads, fallback otherwise,
  a broken URL remembered per src), and `AgentIcon` / `ProfileIcon` /
  `ProjectIcon` wrap it with each entity's rule for where the picture comes from
  — the agent row's own `icon` (`AgentDef.icon`: a URL, usually the `data:` URI
  the seed ships, or the literal `"app"` for the harness's own runtime, whose
  mark is the app `Logo` in currentColor; read from the already-cached agents
  query, so it costs no request). That was a table of three PNGs keyed by agent
  id in this file, which meant an agent somebody added could never have a face
  and the client held an opinion about which runtimes exist — the profile's
  `logoUrl` (else its agent's mark), the
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

- **The composer is one component, `components/composer/composer.tsx`, and one card of two rows** — the
  box and a toolbar — with the shelf above it. The box is a Tiptap editor over the same plain
  string a textarea held (`composer-editor.tsx`): long pastes are inline chips and quoted
  excerpts ("Ask about this" on a transcript selection) are inline quote chips, *in* the box, and
  `editor-text.ts` maps string offsets to editor positions so every caret reader is unchanged
  (checked by `editor-text.check.mjs`).
- **The composer can be *away*, and away is the scroller's answer, never its own**: `ThreadView`
  passes `collapsed={!follow.pinned}` — the pin `useFollowStream` owns, the same state that reveals
  the scroll-to-end button — so a reader who scrolls away from the tail gets the transcript back and
  a reader who reaches it gets the box back, with **no control of its own between the two**: the
  bottom of the transcript and the scroll-to-end button are both the reader's own gesture.
  It is drawn away as `opacity-0 translate-y-6`, `pointer-events-none` and `inert`, **never
  `hidden`**, because this element is what `--composer-dock-h` is measured from — the transcript's
  bottom padding and its `scroll-padding-bottom` are both read off it — so dropping it from the flow
  would re-flow the transcript under somebody mid-scroll *and* shrink the very distance to the bottom
  that decided the collapse. `revealed` is the one exception: a fill from outside the box (a
  suggested follow-up, a queued row's Edit, an "Ask about this", the prompt enhancer's rewrite, the
  Preview's picked element) re-opens it, because those words have to be seen, and the box is handed
  back to the scroll the moment the reader is at the tail again. **Nothing here collapses by
  itself** — it did briefly, on a narrow panel (`useIsNarrow`) or a short window, which took the box
  away from someone who was typing with no gesture behind it and left a "Show composer" button where
  the box had been.
- **The shelf has a floor: `ComposerStrip`'s `footer`, the one row that is always there**
  (`DraftScopeRow` in `components/draft-config.tsx`): the project this thread runs in at the
  row's start, and at its **end** a cluster of readings — the tools it carries
  (`ThreadToolsMenu`, first of them) and then the context ring (`ContextIndicator`, opening
  upward), with `trailing`'s checklist, subagent and changes readings after. The tools menu
  used to stand on the row's start behind a hairline divider, which made the one control that
  is a reading look like a control that was not; it is placed by the cluster now, where **the
  divider is gone** because nothing needs separating. It is not a card — it registers no
  sliver, never goes behind, and holds the shelf open between turns, so **the strip is a
  permanent object with a pile that comes and goes** rather than the other way round. It wears
  the shelf's width (half a rem narrower than the composer, a rem and a half from
  `@panel-sm`) and **`--composer`, not the pile's `--surface`** — it belongs to the box it sits
  on, not to the shelf, so the seam below it disappears and the one above it is where the shelf
  begins.
  **The tuck belongs to whoever is last** (`TUCK`): with a footer the cards stand on it and
  give up their `pb-4`, and the footer takes it, so the shelf still ends behind the composer
  and nothing reserves that edge twice. The footer squares its top corners the moment a card
  stands on it — a rounded corner under a card's square one is a notch of transcript through
  the seam. Both halves used to be a draft-only card on the shelf,
  so the project — *which directory these edits land in* — was visible while you typed the
  first message and never again; the tools menu meanwhile hopped into the toolbar as a
  read-out, which is the same question answered in two places. It is one row now, on both
  sides of the first message: a started thread's project is fixed (it **is** the agent's cwd)
  so that half reads out instead of picking, and `editable` is the only thing the draft
  changes. The ring is there because how full the window is, is a fact about the thread rather
  than a control on the send row — the tab wears the same component, opening downward.
  **`ThreadToolsMenu` renders nothing when a started thread carries no links**, so the row
  asks `useThreadToolCount` before it draws the divider in front of it; that hook is also what
  the menu counts with, so neither can drift. **Which way its popup opens is the caller's**
  (`side`), not read off `editable` — that was only ever a proxy for where the trigger stood,
  and it pointed the draft's menu off the bottom of the screen the moment the row moved into
  the composer. The routine form passes `side="bottom"`; the composer takes the default.
  **The connection is not on this row, or anywhere on the shelf.** It spent time as a lead
  reading beside the project, with the shelf's own ground wearing its tone (`--shelf-info`/
  `-warn`/`-error`); that made the composer wear the state of the *thread*, and it reported a
  dead socket as an entire surface coloured amber. It is a `Notice` at the foot of the
  transcript now (`components/thread-view/thread-status.tsx`), with the wait, the working line and the
  turn's other stops — so the shelf has no tone and nothing on it is ever wrong.
- **The toolbar is the card's second row**, reading *what goes in → who answers → what
  happens*: a "+" menu (attach, take a photo on touch, mention a file, run a command, run a project command,
  insert a code block, clear), the model/config cluster, the length reading, then voice, pause, stop and
  Send. **Send is always drawn** — a muted disabled chip on an empty box, a filled primary disc the moment
  there is something to send — and the whole row, Send and the "+" included, wears one corner: `rounded-pill`,
  the token `--radius-pill` states rather than derives, so a square theme squares them with everything else.
  It used to be five loose buttons on a row that a phone overflowed first; every
  way of *adding to* the message is behind the "+", and every way of *sending* it is behind
  the chevron beside Send (queue or steer while a turn runs, Schedule…, and the Enter
  preference). A long-press on Send (touch) and a right-click (mouse) open that same menu, so
  the chevron is a hint, not the only door.
- **The pile is only what is about the message being typed** (`components/composer-strip.tsx`):
  attachments, the history notice, the three completers, the archive notice, and
  the count of subagents out working. It is a "which of these do you want in front" mechanism,
  and a fact that is *always* true is not a card in it — the project spent its life as a card
  nobody brought forward and then stopped being drawn at all. It stacks **above the footer**.
- **The readings are one cluster at the end of the footer, one shape each**
  (`ThreadToolsMenu`, then `TodoIndicator`, `AgentsIndicator`, `ChangesIndicator`,
  `ContextIndicator` in `components/composer-status.tsx` — the first placed by the row itself,
  the rest passed as `DraftScopeRow`'s `trailing`). They answer the same *kind* of question —
  one number that is true of the thread right now, glanced at constantly and read in full
  rarely — so each is a 24px trigger over a surface: the checklist's ring and its steps, the
  running-subagent count and their names and elapsed times, the changed-file count and the
  paths with their +/− and a "Review in source control" button, the context ring and the turn's
  numbers, and the tools the thread carries, where the surface is a **menu** — the one reading
  you can change rather than only read, which is why it is a `DropdownMenu` and not a popover.
  **What a reading wears is named once, in `composer/indicator.tsx`**: `ReadingBadge` is its
  value in words where the *panel* has room and `ReadingBubble` is the same number riding the
  mark where it does not, never both — so the tools menu prints "12 tools" beside the wrench
  on a wide panel and a `12` on it where there is not, exactly as the checklist prints `2/5`.
  **The project is the exception that keeps its words at every width**, because it is the one
  control in the row that says which directory the work lands in; it wears the same badge with
  `always` and truncates. Each still answers for itself whether it draws at all, so an idle
  thread's cluster is the ring alone, plus the tools row on a draft, where it is the picker.
  The checklist and the agent count have been a card on the shelf (folded behind a 14px sliver) and
  a card at the foot of the transcript (a screenful of scrolling from view); both were the
  whole list, permanently, for a question that is usually "how far along". **A popover is a
  fixed surface with a viewport of its own**, which is what lets these lists scroll without
  taking the room from the transcript.
- **Queued prompts share one pending-update panel** (`components/composer-queue.tsx`), at the
  very end of the flow. Rows carry the prompt, status and timestamp; "Up next" identifies the
  first item to send after the turn, with later messages marked "Queued". Steering is a composer
  send action only, not a second action on each queued row. Queue actions stay with each item (a checkbox picks several for "Send N selected"; "Send all" sends the lot as one prompt),
  use `useCoarsePointer` for touch sizing and remain reachable by keyboard focus.
- **Editing a queued message takes it back to the composer** — `queueRemove` first, then the
  composer's `fill` handle, and the fill only on success, because a message in the box *and*
  in the queue gets said twice. There is no in-place editor: that was a second, worse composer
  that could not attach a file or run a command. Cancelling is therefore the same gesture.
- **A `MessageScrollerItem` that renders nothing still reserves `contain-intrinsic-size`**, so
  the caller gates (`thread.queue.length`) and the component only draws.
  **A summary bar over the composer was tried and taken back out**: a floating pill of counts
  (checklist `done/total`, messages waiting, the last turn's `files +a −r`), each chip
  scrolling to its card. The readings belong in the footer's cluster, where they are one habit
  and not two. Don't re-add it.
- **Two "mobile" answers, used for two different things.** `useCoarsePointer` (the device's
  pointer) sizes the touch targets — 36px on a finger, 32px on a mouse — and decides whether
  "Take a photo" is offered (`capture="environment"` on a second picker: `capture` is an
  attribute, not a mode, so the attach picker stays gallery-first). `useIsMobile` (the width)
  keeps deciding what Enter means, because a soft keyboard is a width question in practice.
  **Both are imported from `hooks/use-device.ts`, never from `hooks/use-mobile.ts`.** The
  latter is shadcn's own generated file: `useCoarsePointer` used to live there, and a
  `shadcn add` of any component that depends on it rewrote the file back to stock, taking the
  export with it and blanking every screen that imported it. `use-device.ts` is the one home of
  every device question (`useIsMobile`, `useIsNarrow`, `useCoarsePointer`, and
  `MOBILE_BREAKPOINT`, defined nowhere else); `use-mobile.ts` is a one-line re-export of it for
  `ui/sidebar.tsx`, so a regenerated one is a private copy nothing outside `ui/` reads. The
  scroll area's native-overflow switch asks `useCoarsePointer` too — it had its own effect-based
  `useTouchPrimary`, which answered one render late.
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
- Every insertion the "+" menu makes (`@`, `/`, `!`, fences) goes through the `@` completer's
  `requestCaret` slot, for the reason `file-mentions.tsx` documents: rewriting `text` is a
  render, and the caret must be re-applied after it. A command is put at the *front* of the
  text wherever the caret was, because the completers read `^/name` and `^!name`; a mention is
  a word and earns a space before it; fences go on their own line.

## Slash commands

- **A slash command is either the agent's or the harness's, and the composer draws one
  list.** Agent commands come from `available_commands_update` and are ordinary prompts —
  `/name args` is sent, the agent resolves it, the send path is untouched. The harness's own
  (`HARNESS_COMMANDS` in `components/slash-commands.tsx`, declared in the same
  `acp.AvailableCommand` shape) are the exception the send path knows about:
  `harnessCommandFor` reads the composed text in `Composer`'s `send` (`components/composer/composer.tsx`) and, for
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
  `GET /api/projects/:id/files/search?q=` (`searchEntries` in `workspace-fs.ts`), and **the
  query names its own scope**: the text through the last `/` is the directory and the rest
  the term, so `src/com` searches `src/`, and `@/etc/`, `@~/` and a relative `@src/` all
  work — a mention reaches any path on the machine, not only the cwd. The server completes
  the path **as typed** (`parseSearchScope`), so a pick inserts `/etc/hosts` or
  `~/.config/…` rather than a re-rooted one. Inside the project the search is a breadth-first
  walk — not `git ls-files` or `rg`, neither of which a project is guaranteed to have —
  skipping `DEFAULT_IGNORES`, never descending a symlink, budgeted at `SEARCH_VISIT_LIMIT`
  entries and ranked by a greedy fuzzy score that rewards adjacent runs, separator
  boundaries, basename hits, and an exact or prefix basename above all. A truncated walk
  still returns the shallow paths, which are the ones a person meant. A directory **outside**
  the project is browsed one level at a time instead of walked, because recursing from
  `/home` on every keystroke is a stat storm nothing asked for; an empty term is always that
  one-level listing, so `@src/` shows `src`'s children and opening the menu shows the root's.
  The IDE's file finder reads the same route and filters to `isProjectRelative` results, the
  only ones it can open. What the composer sends is unchanged — plain `@src/index.ts` in the
  text, so the draft, the queue, the journal, Retry and the prompt-history walk all stay
  strings and none of them learned a second shape. The protocol half is the server's:
  `AcpBridge.prompt` appends the `resource_link` blocks that `server/src/mentions.ts` derives
  from the text, and **for any token that resolves to a path that exists** — `~` and absolute
  resolved as such, the rest against the cwd. Prose is full of at-signs (an address, a
  handle, a decorator), so a token that names nothing real is not a link; the text still says
  what the user typed. Both halves travel on purpose: the text is what every runtime already
  understands, the links are what a runtime that reads the protocol can resolve without
  guessing, and dropping the text would make the transcript stop saying what the user typed.

## `!` commands

- **A `!` line is a shell command the user runs against the project, and every distinct line
  remains saved in that project's history alongside its saved helpers and package.json scripts.**
  `components/project-commands.tsx` is the third completer — the same
  strip row, the same start-anchored token and the same mousedown/key contract as
  `slash-commands.tsx`. It lists the project's helpers (the list the tab menu draws under
  **Project commands** and the project page under **Run**, matched on name *or* on command), and
  **the scripts the project's `package.json` files declare** beside them — the root's own and one
  directory down (`server/src/project-scripts.ts`, `GET /api/projects/:id/scripts`), read off the
  disk and never stored, helpers first because a row the person wrote outranks one the package
  shipped. A nested package's suggested line carries its own `cd`, so it runs from the project
  root through the same door every other `!` line does — nothing about the run path knows a
  script exists. Picking either fills its **command** into the box rather than its name: what
  will run is the thing worth reading and editing before it does. `Composer`'s
  `send` then consumes the line instead of
  prompting (`shellLineFor`) — it never reaches the agent, and it is **send and forget, like a
  prompt**: the box clears on the send, never on the run's completion, and the running row is
  where the line and any failure are said (`runShell` settles its own optimistic row when the
  request dies, rather than leaving a spinner the cleared box can no longer explain). **The
  result is a transcript row, not a terminal**: `actions.runShell` posts to
  `POST /api/sessions/:id/shell` (`server/src/shell.ts`,
  an `execFile` capture that shares the login shell `terminals.ts` uses, which is why `pnpm` is
  found), and the server journals a **`_daedalus/shell`** update — constructed the way
  `config_notice` is, with `seq: 0`, so `append` assigns the real one and replay, fan-out and
  windowing come for free. It is an `update` and not a sixth journaled kind for the reason
  `AutonomyAnswer` gives: the fold and the replay are already the code path, and a client that
  predates the variant ignores it rather than failing to connect. It is **two updates per run** —
  `running` then `done`, both under a caller-minted `shellId`, folded as an upsert so the second
  settles the first — which is what lets the row draw from the moment the line starts. The row is
  a **Bash step** (`ShellItem` → `ShellStep`): the same `execute` icon, the same heading rule
  (`toolHeading`, so `!pnpm test` reads "Run the tests" over the command, exactly as the agent's
  own call would) and the same `ShellPane` body — the thing itself *is* an `execute` call, so two
  vocabularies for it would be the lie. It differs in one thing: it is **open by default**, because
  nothing else in the thread says what the command printed. It says the command and what it
  printed, tinted as a failure on a non-zero exit, and **no turn runs** — `turnActive` never
  moves. **A line that IS
  one of the saved commands runs
  *as* that helper** — the server resolves it, so the helper's cwd and env apply whether the line
  was picked or typed — and anything else runs in the project root. This is the one route that
  takes a command *up* from the browser; the bearer token is the gate, the same one the terminal
  panel's own prompt answers to. **A draft is offered none of it**: running one needs a session to
  journal the row onto, which a draft has not got until its first message. The helper rows ride
  on `useProjects()` (the server folds a project's helpers into its list) and the script rows on
  `useProjectScripts` (one query per project, a minute stale — a suggestion's cadence, not a
  catalog's), and because a thread opened to read holds **no socket** (`phase.ts`), `runShell`
  draws the running row up front and settles it from the answer — the same idempotent upsert the
  fan-out performs, so a live thread and a read-only one agree and neither shows it twice.
  **A `!` row is never windowed away**: `windowStart` opens the replay at the thread's oldest
  shell command (`firstShell`), because a row that belongs to no turn would otherwise be cut off
  by a turn boundary for good, where an old message is merely behind `load earlier`.
- **The project's own commands can also be recommended under an answer**
  (`command-suggestions.tsx`). With a thread's suggestions toggle on, the spawn trailer lists the
  project's helpers and package.json scripts (`personas.ts` `suggestCommands`, fed from the
  spawn's own project — never a second `getProject`) and asks the model to close with one or two
  of them in a `suggest-commands` fence, beside the follow-ups (`lib/suggestions`). **The client
  draws only the lines that name a command the project defines** (`keepDefinedCommands`), so a
  hallucinated line is dropped rather than offered as a `!` the user could click and watch fail;
  the card wears the shell's dress — monospace, a terminal mark, "Project commands" where the
  follow-ups say "Next" — and a pick fills the box with the `!` line **unsent**, the same
  read-before-it-runs bargain the `!` completer's pick makes.
- **Three view options govern the rows** (`lib/view-options.ts`). **Show `!` commands** hides them
  outright — the command still ran and the journal still holds it, only the row is silent — and
  **Group `!` commands** folds a run of commands run back to back into one line (`ShellRun`,
  `groupShellRuns`). **Group parallel tool calls** folds two or more consecutive tool calls, with
  any thoughts between them, into one expandable run (`ToolRunGroup`, `groupToolRuns`); a single
  call stays as its own step. These are Detail-group rows, and neither shell option is
  `answersOnly`'s business: a `!` line is the reader's
  own act, not the agent's work, which is why it is the one thing that option does not drop.
  A turn's footer never anchors to one either — the strip belongs under the answer, not under a
  command the reader ran in the gap after it (`turn-footers.ts`).

## The soft keyboard

- **The page does not resize when a soft keyboard opens, so nothing moves out from under
  it by itself.** `index.html` asks for `interactive-widget=overlays-content` and
  `lib/keyboard-inset.ts` asks the same of the VirtualKeyboard API, because a transcript
  that jumps half a screen on focus has lost the reader's place. The price of that trade is
  paid here: the keyboard is drawn *over* the bottom of the page, so every fixed surface —
  and the browser's own scroll-into-view — behaves as if it were not there. Each surface
  that a caret can land in is moved by hand, from the one number that module publishes as
  `--keyboard-inset`. It is measured two ways because the two overlay regimes contradict
  each other: Chromium's `virtualKeyboard.boundingRect` (asking for the overlay is what
  turns the geometry on), and `innerHeight - visualViewport.height` everywhere else, where
  the viewport still shrinks. Whichever reports more wins.
- **A surface rides the keyboard by a *named recipe*, never a fresh calc** — the three in
  `lib/keyboard-inset.ts`, and which one is not a preference:
  - `KEYBOARD_LIFT` (a transform) for a surface whose reserved height must not move with
    it: the composer, whose docked height the transcript pads by (`--composer-dock-h`,
    measured from offsetHeight), so a `bottom` change would drag the transcript with it.
  - `KEYBOARD_CENTER` for a centred popup — the desktop half of
    `ui/responsive-dialog.tsx` — which stays centred in what is *left* above the keyboard,
    and caps its height there too. A dialog is opened to be typed into more often than not.
- **The status bar, a notch and the home indicator are cleared at the portal, not in the
  components.** `viewport-fit=cover` draws the page under all three, and every Base UI
  surface is portaled into a `<div data-base-ui-portal>` on `<body>` — so index.css ("The
  float box, applied") makes *that* the float box, and no `components/ui/` file carries any
  of it (they are shadcn's, and a reinstall takes back whatever was added). A **flyout's**
  wrapper (it holds a positioner, `data-side`) is a fixed box with `overflow: clip`:
  floating-ui collides against a clipping ancestor and sizes `--available-height` to it, so
  no positioner needs a `collisionPadding`, and its floor is `--float-bottom` (indicator or
  keyboard). A **dialog's** wrapper is the same box as a containing block
  (`contain: layout`), floored at `--dialog-bottom` (the indicator, *not* the keyboard,
  which `KEYBOARD_CENTER`/`KEYBOARD_RISE` already clear), so `top-1/2` and `100%` measure
  the box; its backdrop is stretched back to the screen's edges. **Sheets, drawers and the
  toasts are not boxed** — edge surfaces that pad themselves by `--safe-*`. A portal opened
  inside a dialog lands in the dialog's wrapper and is set back to its edges. Anything that
  sizes itself by hand (a full-window viewer, a flyout's width cap) reads `--float-h`,
  `--float-w`, `--float-bottom`; the aside window, placed in JS outside any Base UI portal,
  reads the same clearance as numbers from `lib/safe-area-inset.ts`.
  - `KEYBOARD_RISE` (a `bottom`) for a bottom-anchored surface that owns its box: the
    mobile sheet, `ui/sheet.tsx`, `ui/drawer.tsx`, the toast viewport. It has to be the
    edge and not a transform, because the height cap is measured from that edge — a sheet
    that only translated would push its own footer off the top.
  Only `KEYBOARD_LIFT` carries a duration; the other two inherit the surface's own, because
  a duration in a shared string is a `duration-*` fight decided by class order. All three
  are `cn`'d **after** the surface's classes: each overrides a `translate-y-*` or
  `bottom-*` already set, so a caller that sets one itself is the escape hatch, not a bug.
  The 285ms on `cubic-bezier(0.2, 0, 0, 1)` is Android's own IME animation, copied because
  it cannot be followed — the per-frame position lives in `WindowInsetsAnimation.Callback`,
  which Chromium never plumbs into the renderer, so the number arrives once, whole.
- **A Base UI positioner is padded, not moved** (`hooks/use-keyboard-inset.ts`). A dropdown,
  select, combobox or popover collides against a rect floating-ui computes in script, so the
  fix is `collisionPadding` — which is also what `--available-height` is then measured
  against, so a long list shortens instead of opening behind the keys. The same padding
  carries the **safe-area insets** (`lib/safe-area-inset.ts`): the app is edge-to-edge and
  the shell pads itself in CSS a portaled flyout never sees, and `env()` does not exist in
  script, so the insets are probed and folded in — a menu near the top clears the status
  bar, one near an edge the notch. Bottom takes the larger of inset and keyboard, never
  their sum: the keyboard covers the home indicator, so the two never stack. **Only under
  `overlaysContent`**: where the keyboard shrinks the visual viewport instead, floating-ui
  is already colliding above it and padding by the same number again would lift a flyout by
  two keyboards. That is the whole reason the module is a store and not a
  `getComputedStyle` call — the hook has to know *which* measurement answered.
- **A field on an ordinary scrolling form is the caret keeper's** (`lib/keyboard-caret.ts`,
  started in `main.tsx` beside the inset itself). The scroll-into-view a browser performs on
  focus is driven by the visual viewport shrinking, so `overlays-content` turns it off and a
  field near the bottom of a settings form is simply drawn under the keys. It scrolls the
  nearest ancestor that can actually scroll, by the overlap plus a line, and it measures
  **after** the surfaces above have ridden (320ms > 285ms) — so a composer or a dialog that
  has already moved reports no overlap and nothing scrolls twice.

## The phone

A phone is for attention, not deep work — approving, switching threads, reading what
landed. Every rule here is gated on `useIsMobile()` (the device), never a panel's width.

- **There is no bottom navigation bar.** The header's sidebar trigger opens the thread
  drawer on a phone, and is shown on every device. Bottom-anchored shell surfaces use
  `--safe-bottom` for the home-indicator inset; no navigation element claims that space.
- **"Needs you" is the inbox's top** (`components/notifications/needs-you.tsx`), read from
  `GET /api/pending` — every question a live agent is blocked on, across threads, straight
  off each bridge's `pending` map. A permission is answered on the card (Allow/Deny picked
  by ACP option **kind**, the narrow one first) through `POST
  /api/sessions/:id/pending/:requestId`, which is `bridge.answer` — the socket's own
  first-answer-wins door, so a 409 is a lost race and not an error. A question is answered
  in its thread (the card opens it). Freshness is a 15s poll while a reader is mounted, focus,
  and an invalidation whenever the count of open cards across the store moves
  (`lib/queries/pending.ts`) — no global socket.

## Panel vs device width

- **"Mobile" is two questions: width is the panel's, the pointer is the device's.**
  A dockview panel is a box inside the window, so a media query is the wrong instrument
  for anything a *panel* has to fit — a chat squeezed to 320px beside a terminal was
  drawing the desktop layout because the window was still 1600px wide.
  `components/workspace/panel-container.tsx` wraps every panel's content, in the one place
  the component map is built (`dock-surface.tsx`), in an unnamed `@container`, and `index.css`
  declares `--container-panel-sm: 40rem` / `--container-panel-md: 48rem` — deliberately the
  pixel values of `sm:`/`md:`, since the variants they replace were written against those.
  So layout that needs *room* (the workflow table's activity column, the queue rows that
  wrap their actions, the strip's inset, the turn rail) is
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

## The desktop shell

`client/electron/` — `main.cjs` (windows, menu, IPC, the static server), `tray.cjs` (the
tray), `preload.cjs` (`window.desktop`, typed in `lib/theme.tsx`). The renderer's half is
`lib/desktop.ts`, mounted once by the shell (`useDesktopBridge`).

- **Main names a shortcut, never an action.** View › Toggle Sidebar / New Thread / Command
  Palette / Split Right, the tray's New thread and the quick-entry hotkey all send a
  `ShortcutId` on the `shortcut` channel, and the renderer calls `runShortcut(id)`
  (`hooks/use-hotkey.ts`), which fires every mounted, enabled `useShortcut(id)` handler — the
  same one the chord runs. So there is no second implementation to drift, and a binding the
  reader moved moves with it. The menu rows carry **no accelerators** for the same reason: a
  menu accelerator swallows the key before the page's (rebindable) binding sees it. The
  sidebar's ⌘B is a `useShortcut("sidebar")` now, not shadcn's hand-rolled listener, which is
  what made it reachable (and rebindable) at all.
- **The tray reads what the sidebar reads** (`useThreadStatuses`): threads that are
  `running` or `waiting`, pushed as `desktop.setActivity({running, waiting, items})` on a
  1s trailing throttle. Tooltip counts everywhere; on macOS the menu-bar title says
  "2 running · 1 waiting". A row is routed exactly like a clicked notification
  (`notification-click` → `installDesktopNotifications`). "Waiting" is only known for a thread
  with a live connection, the same best-effort the sidebar's badge is.
- **Quick entry is an Electron accelerator, not a chord** (Settings › Keyboard › Desktop,
  device-local `desktop.quickEntry`, default `Alt+Space`, `""` = off). Main registers
  nothing on its own: the renderer re-sends it on every boot. A taken or unparsable
  accelerator comes back as `{ok:false, error}` and is drawn on the row — never thrown.
- **"Open thread in its own window" opens a full workspace** (`lib/popout.ts`): it uses
  `AppShell` and the same dock-backed `ChatPanel`/`PanelContainer` path as the main window, so
  its sidebar, thread list, search, tabs and page routes work there too. The initial URL opens
  the requested thread in its dock; opening another thread navigates or focuses tabs normally.
  Since Electron windows share an origin, a stable `desktop.popoutId` scopes this window's
  dock layout, saved layouts, draft rows, composer text, long-paste bodies and attachment refs;
  it cannot read or overwrite the main window's workspace/drafts, and refresh only prunes its
  own namespaced data. System notifications stay owned by the main window to avoid duplicates,
  while worker notification clicks can navigate this workspace. The identity survives route
  changes through the preload process argument. The native window stays hidden until
  `ready-to-show`, with a four-second fallback and load-failure reveal; each reveal nudges the
  bounds by one pixel and restores them to invalidate stale initial layout. The app-level close
  control closes only the `BrowserWindow` that owns the caller.
- **Auto-update is not wired**: `electron-updater` is not a dependency. Adding it is the
  dependency, a `publish` block in `build`, and `autoUpdater.checkForUpdatesAndNotify()`
  after `whenReady`.

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
  **An agent's own typed failure is the same row** (AIR `sessionFailure`, `docs/protocol.md`
  "AIR"): `upsertFailure` in `store/session-update.ts` keys it `failure:<id>` and a higher
  `revision` replaces it in place, and ACP's `notice` is one too. Both carry a `severity`,
  which is the row's tone (`AlertCard`'s `warn`, or muted for info) — and a row with a
  severity is not a *failed* row, so the inspector's count skips it.
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

- **An undo on a toast is what a settings menu has instead of a confirmation.** The thread
  settings menu (`components/session-config.tsx`) used to open a dialog before it would move
  the persona, the profile or the suggestions toggle, and before the model too whenever a
  restart looked likely mid-turn — four modals in front of four menu rows, for changes that
  are all reversible. They are taken immediately now; the restart raises one toast carrying
  Undo (which re-picks the old value down the same path), and the case those dialogs were
  really protecting — a running turn — is protected by the server staging the change until
  that turn ends instead. See `docs/profiles-and-config.md`. The rule generalises: a dialog
  in front of a reversible action is a tax on every use of it to insure against one.

## The shell and the right panel

The app is chat-first. There is no dock, no tabs and no layout to persist: **the address bar is the
only state about what is open.**

**The frame** (`components/app-shell.tsx`): the sidebar rail (plain shadcn `sidebar` variant), then
one column holding the centre pane and the right panel under an overlay header. The header carries
the sidebar toggle, the space switcher, where you are (`shell/top-bar.tsx`) and the panel's doors
(terminal, preview, panel toggle), over a progressive blur the content scrolls under. Both the
centre pane and the panel pad by `--app-header-h` to start below it.

**The centre pane** (`shell/outlet.tsx`) renders the route table (`routes.tsx`) against the real
location. A thread is `/t/:sessionId` → `shell/thread-route.tsx`, which holds the connection
(`useThreadConnection`) while mounted and does what the shell used to do for a thread tab: redirect
a legacy `?session=`, switch to the thread's space, mint a draft for an id nobody knows, and record
the visit. The wrapper is keyed by place, not URL, so a search param does not replay the entrance.
`ThreadView` is always `docked` (no inspector of its own): its readings are the panel's.

**Which threads are "open"** is `lib/workspace/open-threads.ts`: `useActiveChat` is the route, and
`useOpenThreads` is a device-local MRU of visited threads (cap 12) that keeps their sidebar rows
loaded and orders Alt+↓/↑ (`adjacentThread`). Drafts survive a reload if the URL names them or they
are in the MRU (`core.ts` bootstrap).

**The right panel** (`components/right-panel/`, `lib/right-panel.ts`): a rail of sections and the one
in front. Open/width are the device's; section, shells and preview are the scope's (`t:<id>`,
`p:<id>`, `home`). A scope offers `changes plan agents details tokens trajectory terminal preview`
(a thread) or `terminal preview` (anything else). `ScopePane` mounts a section the first time it is
in front and keeps it hidden; `useMountedScopes` keeps the last three scopes. A closed panel mounts
nothing — a PTY is the server's and replays its scrollback on reattach. On a phone it is a
full-screen `Sheet`, and **the sheet's open flag is not stored** (`rightSheet`), so a reload never
lands on an overlay.

**The terminal and the preview** are the panels the dock used to host, unchanged apart from taking a
`PanelHandle` (id, `setTitle`, `updateParameters`) instead of dockview's api. They open things
through `useDock()`; `ScopeBoundary` (`right-panel/scope-dock.tsx`) provides that context bound to a
scope and answers the four doors they use — `openPanel`, `closePanel`, `registerCloseGuard`,
`isPanelOpen` — against the store, with a chat, page or the board going to the router. Any other
`WorkspaceDock` method is a bug and warns. A thread's shell starts in its worktree
(`cwd`, `sessionId`) and dies with the thread; a helper's shell is `closeOnExit`.

**Jumps**: a reading in the panel scrolls the transcript through `ThreadJumpContext` (published by
`ThreadView`'s `PublishJump`); the palette's in-thread search uses the same ref and navigates to the
thread when none is registered.

**Chords** (`lib/shortcuts.ts`): ⌘J toggles the terminal section (creating a shell if there is none),
⌘⌥B the panel, Alt+↓/↑ (and ⌘/Ctrl+Tab on desktop) walk the visited threads, ⌘B the sidebar.
Tab, split, pane, reopen and ⌘1…9 chords no longer exist; a stored binding for one drops silently.

## Routines and schedules pages

`/routines` and `/schedules` are places, not settings sections, and both are drawn
the way the project page is: a `SurfaceHeader`, a row of `StatTile`s, then the list
(`components/page-primitives.tsx` holds those pieces; nothing in it knows which
surface it is on). **Every scrolling page route sits in its `PageFrame`** — the scroller
that pads for `--app-header-h` and the centred column, with a `width` (`form`,
`settings`, `wide`, `full`) — the schedules, routines, inbox, project, trace and settings
pages alike; only the board (whose views own their scrollers) and the landing console
(a centred composer, not a column) build their own. **The sidebar reaches each through one fixed nav row** (Routines,
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
- **The routine form is a rail of six sections, one in front at a time** — basics, how it
  starts, what it runs, autonomy, limits and overlap, when it finishes — and the same
  component draws the create page and the detail page's Settings tab. Stacked, it was the
  widest thing in the harness configured in one sitting and the section that can hand an
  agent a standing grant sat 400px below the fold. **Each rail row says what its section
  currently holds**, read off the draft, so the whole routine is legible without opening
  anything; **`problemOf` is the one validator and it names a section**, so the rail marks
  what is not ready and submitting from anywhere jumps to it (`toInput` calls it — there is
  no second copy). **Sections are hidden, never unmounted**: `DraftScopeRow` probes the
  agent's option set on mount, and remounting it to look at the prompt would re-probe for
  nothing. The action bar is sticky and carries the autonomy reading, so the distance from
  changing a permission to committing it is zero from every section. `autonomy-control.tsx`
  exports the policy in its two halves — `AutonomyPermissions` (the grant) and
  `AutonomyLimits` (the guard rails) — in one file, because the object they write has one
  owner.
- **A schedule has a page too** (`/schedules/<id>`), and it has no history section on
  purpose: a delivered message is a turn in the thread it was sent to, and that
  transcript is the record. The page names the thread, says when it fires next and how
  often, shows the skip state, and holds the editor. The list files schedules under the
  thread they land in.

## The thread inspector and the agents dashboard

- **On a phone, the inspector is a column of the chat panel, never a dock split**
  (`components/thread-view/thread-inspector.tsx`, rendered by `ThreadView` inside its own
  grid). Opening a panel never splits the dock, and a column that belongs to one thread has
  no business being a panel another thread could land beside. Five tabs, each the *full*
  reading behind one of the composer footer's readings:
  - **Changes** — a **turn timeline** (`inspector-changes.tsx`, pieces in
    `thread-view/changes/`). `ThreadView` still seeds `thread.turnChanges` from
    `GET …/changes` on mount, and the tab count is still the footer's value. The rail is
    `changesTimeline` (`turn-footers.ts`): every measured turn newest first, gated per turn by
    the chip's own `couldTouchFiles` walk — a turn the loaded window holds is drawn only if it
    ran a tool that could write; one from before the window cannot be asked, and is drawn when
    git says it changed something (the allowlist's bargain again). A card is the turn's first
    line, its age, `+/−`, file chips and a status: the running turn is **Live** and reads its
    start tree against the disk every 4s; an unmeasured or pruned one is a sentence. The
    newest is open. **A file's diff opens under its row** (`DiffTab` with `inline`: stacked,
    no toolbar, a bounded box) — the list → diff → back navigation is gone, because reading
    the next file should be one click. A scope switcher (a native select; device-local per
    thread, `lib/changes-marks.ts`) swaps the rail for one flat card: **Whole thread** (the
    first measured turn's start tree → now), **Uncommitted** (HEAD → now) and **Branch vs
    base** (merge-base with `origin/HEAD`, else `main`/`master` → now; a sentence when there
    is none or HEAD is it). Every side is read through the scope's own routes
    (`…/changes/file?scope=&side=`, `DiffTab`'s `TreeSide`), never re-derived client-side.
    **Why not source control any more**: the old `ScmView` (since removed) narrowed to a turn could only ever show
    what is *still uncommitted*, so a committed turn read as nothing, and it could not show a
    turn other than the newest at all. Staging a whole file is still the IDE's; the hunk
    verbs came along (below).
    **Viewed and flagged are the reader's**: a checkbox per row folds and dims it, counted
    "Viewed x/N" in the bar (with "Mark all viewed" in its menu), keyed per thread + scope +
    path on a fingerprint (status and `+/−`), so a file whose content moved comes back unread
    with nothing having to clear it. A flag marks a file for **Fix flagged**, one message
    listing them with any draft comments on them (those drafts and the flags clear on
    success); **Ask to review** is one message naming the scope's files as `@` mentions (≤ 30,
    then "…and N more") — "By turn" means the newest turn's. Both go through `onSend`, the
    same door as Send review. **Revert turn** sits under an open ended turn's files: it
    confirms with the count, and a 409 draws the paths that moved since with "Revert anyway"
    (`force`); success is a toast, since no transcript row fits a working-tree write the
    agent did not make.
  - **Plan** — `threadTodos` (exported from `todo-indicator.tsx`, the one place that decides
    which item *is* the checklist), full height.
  - **Agents** — every subagent, batch and workflow run as **one outline of the whole
    thread** (`agentOutline`: a workflow keeps its phases, named after the run; a batch is a
    phase; each stretch of lone subagents is one), drawn in a run card's own layouts
    (`RunLayout`, `RUN_VIEWS`) — List by default, picked per device
    (`inspectorPrefs.agentsView`) — so the panel and a run card cannot drift. A live
    workflow's pause/resume rides its first phase heading (`PhaseView.hold`, which forces
    the headings on even for a one-phase run; a row above the flowchart, which has none),
    and every step row carries a locate button that scrolls the transcript to it
    (`LocatableStep`, module-level with the jump in context so an open row never remounts).
    A "Runs" view of the transcript's own cards was tried and removed: each card carried
    its own layout tabs, a second picker inside the first. The header carries the shape
    strip (`RunStrip`) and filters counted per agent. Rows are built with the reader's view
    options and provided as context, because the panel is outside the transcript's
    provider. A native workflow step's transcript is still fetched only when its row opens
    (`loadAgentTranscript`). A sheet closes itself on a jump.
  - **Details** — model, workspace, usage, workflow runs and history.
  - **Tokens** (`thread-view/tokens-panel.tsx`, arithmetic in `lib/token-breakdown.ts`,
    checked by `token-breakdown.check.mjs`) — two readings kept apart. **Billed** is the
    provider's own count (new input, cache read, cache write, output, reasoning — exact,
    every runtime), headlined by its total. **Prompt** is what a request held, drawn as one
    column per request (stacked by part, click one to read it) over a table of that request
    beside all of them, then turn by turn with a bar per request. **Every part opens onto
    what it was made of**: the system prompt by section and `##` heading, each built-in
    tool's definition, MCP tools folded by server, each of your messages, the assistant's
    replies and calls by tool, tool results by tool and call — scaled so a part's rows add
    up to the part. The prefix lists ride our runtime's first step of each attempt
    (`_meta.daedalus.breakdown.items`) and carry forward to the steps after it; the history
    lists are the transcript the request carried. For our runtime the parts are
    **measured**; for any other they are **inferred**: the transcript up to the request is
    counted at about four characters a token, a finished compaction replaces what preceded
    it, and what is left of the request's `used` is "Agent overhead" — the system prompt and
    tool schemas inside that agent's process, which have no item list. Every figure carries
    a `~`. **It is the only surface that prints an estimate**: the context popover shows a
    plain fill and a "Token breakdown" button that opens this tab, and the step/turn popovers
    show only what was reported. Older journal entries lack the by-role split and draw their
    history as one "unsplit" row; nothing is reconstructed for past requests. **Its colours
    are fixed hues (`PROMPT_PARTS`/`BILLED_PARTS` swatches), never `--chart-*`**: the default
    theme makes those five greys, which draws a stacked bar as one colour in five shades.
    Billed opens on tiles for what the thread already knows (context window, cache hit,
    average turn, largest prompt, reported cost, output share), every row carries a share
    bar, and a turn says its requests, wall time and cache rate (`TurnTokens.turnId` keys
    `turnDuration`).
- **A review is written on the diff and sent as one ordinary message.** In the Changes tab's
  diff, a "+" follows the pointer down the gutter (`DiffEditor`'s `review` opt-in: a glyph
  decoration, `glyphMargin` on only then); a click anchors a comment at that line — or at the
  selection, if the line is inside one — on either side. Comments are **drafts, device-local
  and per thread** (`lib/review-comments.ts`, a `createLocalStore`, so a reload keeps them the
  way it keeps a half-typed message): counted on the Changes tab, listed under the view with
  edit/delete, and drawn on their lines. **"Send review" (`sendReview`, ⌘/Ctrl+↵, answered
  only with the focus in the tab so the composer keeps its own) is `actions.send` and nothing
  else** — one message (a header, then per comment `@path (line N)`, the quoted lines and the
  words), so it queues behind a running turn and never steers, and `@path` is a mention the
  server links like a typed one. The drafts are cleared only when the send resolves.
- **A hunk is acted on where it is drawn, through doors that already existed.** On a
  comparison whose right side is the disk and whose left is the index or a scope's tree (and
  only when the opener named the `repo`) — or whose right is a scope's "after" tree that still
  reads exactly as the disk does, which is the newest turn before anything else wrote —
  `DiffTab` draws a bar over Monaco's own line changes (`onDidUpdateDiff` →
  `getLineChanges`): the current change, prev/next, **Stage** and **Revert**. Stage is the
  `apply` git route with `cached` — a one-hunk patch cut by `lib/workspace/hunks.ts` with its
  context read off the index, so git's preimage check is what refuses a hunk whose
  surroundings moved (against a turn's start tree that is also what refuses a hunk the index
  does not already agree with). Revert writes the worktree text with the left side's lines put back through
  the **file route at the version the diff was read at**, so a file the agent wrote since is
  a 409 said in the bar. Keep is doing nothing. `hunks.check.mjs` stages every hunk of a few
  shapes (insertions, deletions, no trailing newline) against a real git.
- **Docked or sheet is the panel's width, measured** (a ResizeObserver on the grid root, 1024px
  — `--container-panel-lg`; a hidden tab measures 0 and is ignored). Docked, it is the grid's
  second column (`grid-cols-[minmax(0,1fr)_auto]`), resizable on its left edge (held while
  dragging, written on release, double-click resets — the IDE side view's bargain) and it
  publishes its live width as `--inspector-w` on the grid root so the absolutely-positioned
  composer stops at its edge. Below that it is the same column laid over the transcript
  with a scrim.
- **What is stored is the device's** (`lib/inspector.ts`: open, width, tab — global, like
  `view-options`). **The sheet's open state is not stored**: it is `ThreadView`'s own state,
  because a restored overlay would cover every narrow transcript on a phone.
- The footer readings stay the readings; their popovers end in **Open in inspector**
  (`OpenInInspector` in `composer/indicator.tsx`), which reaches the column through
  `InspectorContext` — null outside a transcript (the landing console), where the row is not
  drawn. **That is the only door** — there is no toggle button, chord or palette row: a
  chat tab reaches the same readings as panels through its thread dock's +, so a second
  control for the column was a duplicate.

- **`/agents` is every listed thread's live state** (`components/agents-page.tsx`, a page panel
  in `PageFrame`, a sidebar nav row and a palette row). It fetches nothing of its own: rows are
  the store's session list (`isListed`, not deleted), and the state is `agentState`
  (`lib/thread/statuses.ts`) — `threadStatus` folded to waiting / held / running / failed /
  idle / archived, plus the two things `markFor` does not say (a turn held at a failure is
  still `turnActive`, and a thread with no process). Context % is `contextPercent`.
- **A thread with no socket is read from the server's snapshot of its bridge.** `list()`
  adds `waiting` (`bridge.pending` non-empty), `held` (paused by error) and `context` (the
  row's `sessions.context`), all derived per request and never stored; `sameRow` compares
  them so a refresh that changed one reaches the page. **The live thread outranks the
  snapshot** wherever a tab holds one (`phase.kind === "live"`), which is also why
  `threadStatus` now lights the sidebar's "Needs you" for a thread nobody has open. The
  snapshot only moves when the list is re-read, so the page re-reads it on mount, on Refresh
  and every 15s while the document is visible.
- The page reads the whole store through one selector that returns a `Map` keeping its
  identity until a reading moves (`useReadings`, the `useThreadStatuses` shape), because
  `state.threads` is replaced on every streamed token. Rows are a table from `@panel-md` and
  cards below it — one element per row, the columns folding onto a meta line.
