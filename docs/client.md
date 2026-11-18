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
  colours are index.css's `:root` / `.dark`) is the one CSS built-in; the
  product-inspired schemes (`lib/color-schemes.ts`, below) are built-ins too, but
  their CSS is *emitted at load* by `applyBuiltinSchemes` in `custom-themes.ts`
  from that one table (same three blocks as a saved theme, plus the `--theme-*`
  echo vars), never hand-copied here. And
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
  **Glass is blur *and* opacity, and they move together.** The card, sheet, menu
  and composer fills are 72-90% of their token, which only reads as glass because
  the blur softens what shows through; at `--app-blur: 0` the same fills were
  see-through text on text. Each blur preset therefore also states `--app-solid`
  (0-1, `BLUR_PRESETS.solid`), and the fills are `80% + 20% * var(--app-solid)`
  etc. — None is fully opaque, Light halfway, Medium and Heavy unchanged. The
  composer's fills are the `bg-composer-glass(-hi)` utilities for that reason: a
  `bg-composer/80` alpha cannot follow a variable.
  **The composer's shape follows the theme on four more axes.** The box is
  `rounded-composer` (the 2xl step capped at 1.5rem, so Pill is not a lozenge) with
  `p-composer-pad` (0.4 x that radius, floor 0.5rem — concentric with a 28px key at
  the cap); its round buttons are `rounded-key` (the capsule radius, so a circle
  in a round theme and a small square in a Sharp/Square one); its hairline is
  `ring-edge`, whose strength is the depth's `--depth-<id>-edge` (flat 18% down to
  deep 8%) because a flat theme has no shadow to separate the box; and its focus
  ring is `ring-focus-soft`, an alpha that scales with the ring colour's chroma so
  a black/white primary gets a whisper rather than a stark outline.
  **The studio is a section nav, not tabs** (`theme-builder/editor.tsx`): Presets,
  Type, Shape, Surfaces, Layout, Color — a column of rows beside the controls and
  the sticky mock from `@panel-lg`, a scrolling chip row over them below it. The
  Design half is `design-tab.tsx`'s four sections. Four axes beyond the first
  version are theme-owned and **unset means "follow the old pairing", never a
  default written on open**: `edge` (`--app-edge`; unset = the depth's own),
  `solid` (`--app-solid`, the Opacity control; unset = the blur preset's pairing,
  shown selected through `solidIdFor`), `density` (a multiplier inside the theme's
  own `--spacing`) and `composer` (`--app-composer-mult`/`-cap`, the box's corner).
  **The UI-scale slider no longer writes `--spacing`**: it writes `--app-scale`
  and `--spacing` is derived from it in `:root`, because an inline `--spacing` on
  `html` outranks any theme's block and would have made density unthemeable.

  **The edge is the app's, not the composer's.** `Card` and the `ui/` surfaces
  wear it: `ring-edge` (cards), `ring-edge-float` (menus, popovers, dialogs —
  half of it, as their old `ring-foreground/5` was), and `ring-edge-extra` for
  surfaces that were always separated by ground alone (the shelf's cards, the inset
  layout's dock cards) — only the part above Default's 10%, so Default is
  unchanged and a flat theme gets a hairline where it has no shadow.
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
  design in another colour, and they touch colour alone. The curated ones are no longer studio presets but gallery
  built-ins, so a copy via "New theme" is how one reaches the studio
  (`lib/color-schemes.ts`: OpenCode, Claude, ChatGPT, Gemini, Perplexity, Grok, Cursor, Copilot) are the
  looks of the AI products people already work in, and they set the **Design half
  too**, because Claude under a geometric sans with capsule badges is not Claude.
  **None of those products publishes a token table**, so the values are their
  surfaces as shipped, approximated — each entry's `source` says what it was
  modelled on, and a product accent that fails AA (Claude's clay under a white
  label) is swapped for the nearest passing shade of the same hue, marked
  `adjusted:`; gaps are marked `derived:`. No logo, wordmark or typeface is
  bundled. The old editor schemes (Nord, Dracula, Solarized, Gruvbox, Catppuccin,
  Rosé Pine) were replaced; they are in git history. The same
  `CONTRAST_PAIRS` gate applies. Every preset swatch draws *itself* — the
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
  **A call into an MCP server reads as that server, not as a generic call**
  (`lib/tools/mcp.ts`, `tool-views/mcp.tsx`). Three things were missing and they
  are the same fact three ways. The row wore its ACP kind's glyph — a wrench for
  the `other` Claude Code files every MCP tool under, a terminal for Codex's
  `execute` — so four servers read as four identical marks; it now wears the
  server's own face, resolved from the library by `mcpServerKey` (case- and
  punctuation-blind, because `GitHub Work`, `mcp__GitHub_Work__…` and
  `mcp.GitHub_Work.…` are one name in three spellings) with `catalog: false`,
  since a transcript row draws what the row holds and a listing read per server
  mentioned would turn reading a thread into catalog requests. A server nobody
  in the library names keeps the kind glyph: a guess wearing a logo is worse
  than a wrench. **The row is then two facts in two shapes**: the tool is the
  title ("Get Task" is what happened) and the integration is a chip beside it
  (`McpServerChip`, the same `CHIP` a file gets), because a mono `Server · Tool`
  only reads as a sentence when it is one — when one half is a *place*, a chip is
  this app's answer for it. **Each integration wears its own colour** — the
  chip's wash and ink, the disc behind its mark, and the disc it gets in a run's
  stack — and nobody assigns it: `mcpTintIndex` derives it from the server's name
  (FNV-1a with one avalanche step, because a plain multiply left eight
  integrations on six colours), and `MCP_TINTS` is ordered *across* the wheel
  rather than along it, so two buckets that do collide are the two furthest
  apart in hue. The same server is the same colour on every device, and a server
  somebody adds tomorrow has one before anyone opens Settings. `toolHeading`
  still returns the joined pair as `title` (the approval card, the inspector and
  the composer's activity line have no chip slot), and carries the halves on
  `integration` for the row that does. It also captions the row with the subject (`mcpSubject` — the argument
  that names the thing: a `query`, a `path`, a task's `name`, with `id` last
  because plenty of servers put a workspace's id there), so `Clickup · Get Task`
  no longer means an unnamed task. And the answer arrived as MCP's envelope,
  `{content:[{type:"text",text}], structuredContent, isError}`, drawn as a JSON
  tree three folds deep around an escaped string; `mcpAnswer` flattens the
  blocks, unwraps the runtime's own `{result, error}` and `{output}` wrappers one
  level, and says `isError` as a failure. `structuredContent` is read as the
  answer *only* when the server sent no text at all: it never earns a section of
  its own, so the pane a call draws is the same pane whatever the server put the
  reply in — which is the rule this view is held to, and why a two-column
  exchange layout was drawn here once and taken back out. A server that answers a document still gets the tree —
  it is the same reader, pointed at the letter instead of the envelope — and an
  answer that arrived as ACP content blocks is drawn once, not twice. The pair in
  the title is `mcpCallLabel`, which spells the server as a person typed it
  (`GitHub_Work` is never "Git Hub Work") and drops the vendor's own name from
  the tool, because Clickup's server names its tools `clickup_get_task`.
  `mcp.check.mjs` holds the three dialects' shapes.
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
  **Parallel calls are bracketed, and the wait between steps is said under the step it follows**
  (`lib/tool-batches.ts`, the parallel group's wash and `StepGap` in `thread-items/rows.tsx`). A batch is the
  calls of one model request. **The runtime's word beats a guess**: our agent stamps every call
  with `_meta.daedalus.stepId` (one per `start-step`, read through `stepIdOf`), and two
  neighbours are one batch exactly when the ids are equal. Only a call with no id — another
  runtime, an older journal — falls back to timing: starting within `batchBurst` of the batch's
  first call, or before its latest call has ended. A step with neither (a notice, a `session/load`
  replay, whose stamps are the reload's) never joins, so no evidence marks nothing. The batch is
  drawn as a group of its own (`ToolRun`'s `parallel`), **bracketed as a ledger and nothing
  else**: a hairline above and below the group, one between every call, no tint, and the calls on
  the run's rail — the same trunk, elbow and indent a plain run's steps have — because a batch is
  still steps of the run. Six treatments (`wash`, `card`, `columns`, `bracket`, `ledger`, `tiles`)
  were a reading preference once (`groupStyle`); the picker and the other five are gone, and a
  stored `groupStyle` is ignored. **The chrome is one module** (`thread-items/group-style.tsx`):
  the row asks for a treatment (`frame`, `list`) instead of spelling `border-… divide-…` inline.
  **It sits flush on the transcript's column**, the same edge a step row's hover ground, a todo
  card, the thinking panel and the gap rule are on — and `px-1` is not a free number, because the
  header and every call row inside the frame carry StepRow's `-mx-1 px-1`, which holds *their*
  content on the column while their hover ground bleeds 4px.
  The frame supplies exactly that 4px. It used to bleed instead (`-mx-2 px-2`, which put the frame
  8px outside the column while technically holding its content still), and in one turn that read
  as three different columns — thinking panel at +4, todo card and step rows at 0, batch at −8 —
  so the batch's header started left of the card above it and its chevron ran past the prose
  below. **A bleed is only free when it is the one thing on screen with an edge**; beside cards
  and rules that all sit on the column, it reads as a box that does not line up. The paint room in
  the clips that can hold a group (`-mx-2 px-2` in `thread-view.tsx`, `rows.tsx`,
  `thread-cards.tsx`) stays and costs nothing — it is room, not an offset — so a style added
  tomorrow that does want to bleed may use it.
  **The weight is the transcript's, never a badge's**: the wash is the `!` run's strength
  (`bg-primary/[0.06]` — one shape for "this stretch is marked") and the ring is the app's own
  edge tone (`ring-foreground/10`, what a card's border is). A first
  version reached for `bg-primary/10` and `ring-primary/25`, which put one row's frame 56 levels
  below every other edge on screen — a box shouting over its own contents, and the one thing in
  the transcript drawn that way. **A live batch takes the accent's colour on that same weight
  (`ring-primary/30`, or `border-primary/30` on the card)**, so "these went out together and are
  still coming back" is said by hue rather than by a heavier frame. **`columns` reflows on the
  panel's width, not the window's** (`@panel-sm`, the container query): two step rows side by side
  in half a panel is two columns of truncated titles, so below it the grid falls back to the list.
  The header says `3 in parallel` in the batch's hue, on the app's own chip shape
  (`CHIP` — one radius, one line box and one size as every other chip in the row, told apart by
  colour alone rather than by a pill of its own), and, beside it, how the batch stands: `1 of 3 running`
  (`StepBatch.running`) while any call is out, then the span from first start to latest end once
  every call has ended — the calls ran side by side, so it is never a sum. **Each call says where
  it sat**: a `2/3` chip between its mark and its title (`StepMarker`, read through
  `StepMarkerContext` because a batch of mixed kinds folds into nested runs, so the calls to number
  are below a row that knows nothing of the batch). The numbering is taken over the batch's *whole*
  member list, never over the part a peek shows, and off the group's own layout rather than the
  visible one, so a five-call batch never numbers its last three `1/3..3/3`. A notice between two
  calls of one batch is inside the wash. The wait (`gapMin`, Off draws
  none) is measured from the batch's *latest* end to the next batch's start, hangs off the batch's
  last call, and never reads as a row of its own, because a row would take a mark and a rail
  elbow. A reader's approval time is already out of a call's length (`waitedMs`), so the figure
  is the agent's own. Both options are Segmented presets, not free numbers (`BATCH_BURSTS`,
  `GAP_MINS`): `pick` drops a stored value outside the list.
  **A thinking row is a live view while it streams, and its shape is a view option.**
  `RowView`'s `streaming` flag (set by `thread-view.tsx` on the rows the open turn is still
  writing, and by the subagent rail on its own while the child is active) opens the
  `thought` case for as long as it is being written (`autoOpen`, so a settled one folds again
  unless the reader opened it) and ticks the clock that is its title. **What is "still writing" is
  `streamingRowIds`, not "the last row"**: a trailing thought stands outside the fold it explains
  (`groupToolRuns` leaves it as the live tail), so a tail test answered by `rowTailId` alone
  stopped matching the run the moment the model started thinking — the group folded shut on every
  thinking block and opened again when the call after it landed. The reading is the newest row
  plus the group under a thought standing at the tail (never prose: an answer already on screen
  does not become unfinished because the agent thought again), and a work fold and a subagent rail
  ask it of their own rows, because the newest item is a level down from both. **Thinking as a step**
  (`thoughtStep`, on) draws it the way a tool call is drawn — `BrainIcon` in the same mark
  column, `Thinking 12s` / `Thought for 12s` as the title, the reasoning behind the same
  disclosure a call's body is behind, and `toolLayout`/`toolVariant` applied to it — so a
  thought lines up with the calls around it. Off, it is the block, and it is a card: no mark of
  the row's own and no gutter, because the card draws both. `ThoughtPreview` is a
  `thought-surface` well under the clock — three lines of reasoning, the last fading into the
  well (`.thought-preview`'s clamp and mask), so a folded thought says whether opening it is
  worth the click — and `ThoughtDetail` is the same well holding the whole of it, capped by
  `THOUGHT_MAX_H` and following itself while it streams. Opening swaps one for the other.
  Either shape stands where it arrived, or rides inside the run it leads or sits within (`groupToolRuns`).
  **The reasoning's palette rides the prose element itself** (`thought-prose`), which restates
  `--tw-prose-*` so thinking reads a step below the answer rather than at its body colour — a
  wrapper class cannot do it, because such a rule would match a descendant and the class and
  `.prose` are the same element, which is why every thought used to render at the answer's
  weight. Derived at view time from position, not from a flag in the store: the
  reducer never marks a thought done.
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
  `ThoughtBlock` follows *itself*: the transcript's `useFollowStream` measures the
  content element, and a capped box stops growing when it fills, which would leave the
  newest thinking — the part being written — exactly what falls out of view. Settled it
  is inert and opens at the top. **The cap is a view option, not a rule** (`thoughtFullHeight`,
  Appearance › Transcript › Thinking, off by default): on, `ThoughtReading` draws with no
  `max-h` and no scroller of its own, so a long reasoning block runs on and the transcript is
  what scrolls — the reader who wants the whole thought in the flow asks for it, and everyone
  else keeps the steps after it in reach. `ThoughtBlock`'s open clip already measures
  `scroller.clientHeight`, which is the content at natural height, so the fold's animation
  needs no second branch.
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
  path is the machine's.) `lib/layout-options.ts` (timestamps/tool grouping/density) is
  device-local too but **global and persisted**: one set of reading settings for
  every thread, keyed by nothing, so `useLayoutOptions()`/`setLayoutOption(key, …)`
  take no session and there is nothing to prune. Per-session was the older rule
  and it meant finding and flipping the same switch again in every thread — how a
  transcript is drawn is a property of the reader, not of the conversation. The
  pre-global blob (`{ [sessionId]: Partial<LayoutOptions> }` under the same
  `ui.viewOptions` key) is folded into the one set on first read, later threads
  winning, rather than dropped. **The sidebar
  is `components/thread-sidebar.tsx`**, laid out like the Codex and Claude desktop
  apps: fixed nav rows on top (`SidebarNav`: New thread, Search, Tasks — menu rows,
  so they survive the icon rail), then Pinned, an **Opened** tier of the threads
  with a tab open (in dock order — `lib/workspace/open-threads`, published by the
  dock and rebuilt from the restored layout on a reload), a flat Recents, and —
  under "By project" — **one section per project**, Scheduled, Trash. **A
  project section is one level, not a folder**: the project's own mark and name
  are a heading over its threads (`ProjectSection`), not a control that folds,
  with the `+` that starts a thread *in* that project and the way into its page
  as the heading's hover controls and right-click rows. It was a foldable folder
  per project under a foldable "Projects" tier, which made the sidebar a tree
  three deep (project → thread → its sub threads) and buried every project after
  a long open one. The heading keeps the folder's rollups — running, needs-you,
  thread count — because a section scrolled to the top is still a reading, and
  its body is capped and scrolls itself (`SECTION_BODY`) so one project with a
  year of threads in it cannot push the next heading off the foot of the
  sidebar. **It prints no period headings and names no project on its rows**:
  the heading already filed them by project, so a Today/Yesterday tier inside
  would be a second level, and the row would repeat the name it sits under. **Recents lists what is not open**:
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
  likely to be looked for, the one missing from where it lives. Inside a project
  section the rows are flat — the heading is its own level — while the **flat
  Recents list is grouped by period** (`periodLabel` in `lib/time.ts`, `grouped`
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
  Rows are one line and title-first: the agent's own mark (when the row dress
  asks for it — the tab's paired agent-over-project stack needs the 28px tab
  slot, not this row's), the title, the project's name where the row names it,
  and at the trailing edge how long ago the thread last spoke, which the ⋯
  floats over on hover. The rest —
  profile, model, the project's path, start time and, when it says something the
  start time does not, last active — lives in `ThreadInfoCard`, and it is read
  twice: as the row's **hover card** (`PreviewCard`, 400ms, a reading and
  nothing more) and as the header of the ⋯ dropdown, which carries the row's
  actions beside it. **The actions are the ⋯'s and the right-click menu's (long
  press on a phone) — never the hover card's.** The row's old native `title`
  ("Needs you · model · project") is gone with it: one hover, one card, rather
  than a tooltip that said less and a second popover when the two met. A
  project folder has the same hover card — its note, its path, how many threads
  it holds, what is running or needs you, and when it last spoke — where the
  pointer used to get the name it was already over. Every row, label and group draws from
  one scale (`ROW`/`MENU`/`GROUP`/`TIER`, exported for the settings nav too). There is no plan-usage
  gauge in the sidebar: the plans are listed on Settings › Usage and nowhere else. The
  main surface (`SidebarInset`) is `bg-card` over the sidebar's tinted ground, and
  the Threads label carries a sort/filter menu (sort: recent / created / title / by project; show: all / running / needs you / unread / trash; active in: any / 24h / 7d / 30d; sub threads: all / active / off). **Hiding is a switch, not a filter** (`sidebarShowHidden`, "Hidden threads"): hiding a thread takes it out of every list, and reading what it hid used to mean spending the list on them — so the switch adds a `Hidden` group after the list instead (count on its label, shut by default, each row carrying its own Unhide), and no reading of the list is given up to find one. A stored `sidebarFilter: "hidden"` from before the switch carries over as `all` plus the group open (`pick`). **Those, and every other sidebar pick (variant, compact rows, row dress, period headings, the Pinned group, the page rows, empty folders), are `sidebar*` keys of the one layout-options store** (`ui.viewOptions`) — Settings › Appearance › Interface edits the same values the menu does, and its Reset counts only the sidebar scope. `ui.sidebarView` and the variant in `ui.sidebarLayout` were folded in once and removed. Fold
  state is `ui.collapsedProjects`, keyed by project id. **Every row wears one status glyph in its trailing slot**
  (`ThreadStateBadge`): the words "Needs you"/"Error" for the two asks, otherwise a
  pause (held at a failure), a spinner (running) or a primary dot (finished since this
  device last looked). Held is `agentState`'s rule asked of every session
  (`sidebar/activity.ts`); **unread is device-local** (`ui.threadSeen`: the `activityAt`
  last in front of you per thread, plus a first-launch baseline so history does not all
  read unread) and is stamped by the thread in front of you — reading is not activity, so
  nothing is written to the server. **A project section's heading rolls up** its running
  and needs-you counts, and the Threads label carries the total needs-you; the heading is
  medium weight, so a column of them reads apart from the thread rows under it. **Trash is
  sticky to the foot of the panel**, not the end of the list: the list grows a page at a
  time on scroll, so a Trash living after the last row was one nobody reached without
  loading the whole history first. It folds shut by default, its opened body is capped
  (`SECTION_BODY`) so a long Trash cannot cover the list it sticks over, and
  `Empty Trash` stays outside that scroll box. **The in-sidebar filter**
  (`sidebarFilter`, Alt+T, or the magnifier on the label) matches already-loaded threads
  by title, project or agent id, locally and unstored; the palette stays the deep search.
  The All / Running / Needs you chips write the same `sidebarFilter` the menu does.
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
  **An MCP server's mark is `McpIcon`, and the harness's own five built-ins carry a hue**
  (`BUILTIN_MCP_HUES`): web search indigo, knowledge green, workflows violet, ask-agents amber,
  harness rose. A built-in is a *known* facet, so its colour is stated once beside its glyph.
  **A server the user added takes a hue hashed off its name** (`lib/hue.ts`'s `hueOf`, the one
  helper the project initial and a task assignee also use): an `http` row usually resolves a
  favicon, but a stdio row has no URL for `resolveMcpLogo` to ask, so it drew one grey
  `TerminalIcon` and two stdio servers in the chip were two identical discs. Hashing is right
  precisely because nothing knows what the server is — the colour is a property of the name, so
  it is the same on every device with no column to store, and renaming re-tints it. Only a
  server with no identity at all (an absent row, a built-in this build dropped) keeps the
  neutral grey. The hue is a number on the element
  (`--mcp-hue`, from `mcpHueStyle`) and the palette says how loudly to wear it in two rules
  (`.mcp-hue-mark` / `[data-mcp-disc]` in index.css, one lightness each per mode): the glyph
  takes the hue at full strength and the disc around it a 12% wash, so the composer chip's
  overlapping stack reads as three coloured discs instead of three identical grey ones. Every
  surface that draws a server — the chip, the picker's rows, Settings › MCP, a transcript's
  tools — gets it from the same two exports, so none of them can drift apart.
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
- **A paste chip's popover reads its body as markdown, when the body is a document.** A paste is
  parked because it was too long to sit in the box, and what it holds is usually a brief or a spec
  whose headings, lists and tables are half of what it says; the popover drew it in a `<pre>`, so
  all of that arrived as characters. `ChipPreview` takes the flag and draws the body through
  `Prose` — the transcript's own pass, so a link there is the chip's and a fence is highlighted —
  while Copy still hands over exactly what was pasted. **The flag is decided, never assumed**
  (`lib/paste-markdown.ts`): markdown's own evidence — a heading, a list item at a line's start, a
  quote, a fence, a table, a reference definition — says it is a document, and failing that a body
  with no long line and no run of four plain lines in a row is a paragraph that was pasted
  hard-wrapped. What it refuses is the case the change would break: a stack trace or a log has no
  blank lines, and markdown joins a line to the one above it, so forty frames would come back as
  one run-on block — less readable than the `<pre>` it replaced. A quote chip and the "sent to the
  agent" bodies stay verbatim, where the characters *are* the point. Both sides of the chip read
  the one decision: the transcript's (`user-chips.tsx`) and the composer's
  (`composer-editor.tsx`). Checked by `paste-markdown.check.mjs`.
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
  turn's other stops — so **the shelf has no *status* tone** and nothing on it is ever wrong: no
  surface of it ever goes amber because a socket died. That is a different statement from the one
  about *kinds* below, and the two must not be conflated — a tone that says "this item is a shell
  command" is not a tone that says "something is wrong". The foot is the
  *pane's*, not the content's: the transcript's content box is `min-h-full`, and the status item
  carries `mt-auto`, so a thread shorter than the pane — an opening replay, a first turn — rests
  its live line just above the composer instead of in the middle of the blank paper under the
  skeleton. It costs nothing once the transcript overflows, where the space is zero.
- **The toolbar is the card's second row**, reading *what goes in → who answers → what
  happens*: a "+" menu (attach, take a photo on touch, mention a file, run a command, run a project command,
  insert a code block, clear), the model/config cluster, the length reading, then the one voice key,
  pause, stop and Send. **Send is always drawn** — a muted disabled chip on an empty box, a filled primary disc the moment
  there is something to send — and the whole row, Send and the "+" included, wears one corner: `rounded-pill`,
  the token `--radius-pill` states rather than derives, so a square theme squares them with everything else.
  It used to be five loose buttons on a row that a phone overflowed first; every
  way of *adding to* the message is behind the "+", and every way of *sending* it is behind
  the chevron beside Send (queue or steer while a turn runs, Schedule…, and the Enter
  preference). A long-press on Send (touch) and a right-click (mouse) open that same menu, so
  the chevron is a hint, not the only door. **Voice is one key with a fold, not two buttons**
  (`composer/voice-button.tsx`): a dictated note and a call are picked behind the fold and a
  click runs the pick, because as two buttons which of them was drawn at all depended on the
  browser's speech API and on a backend being configured, and a mini line had room for neither.
- **The pile is only what is about the message being typed** (`components/composer-strip.tsx`):
  attachments, the history notice, the three completers, the archive notice, and
  the count of subagents out working. It is a "which of these do you want in front" mechanism,
  and a fact that is *always* true is not a card in it — the project spent its life as a card
  nobody brought forward and then stopped being drawn at all. It stacks **above the footer**.
  **Every item wears the hue of its kind** (`StripTone`): `accent` for a file riding along with
  the message, `positive` for a set found by `/` or `@`, `caution` for a project command, which
  is the one row that will *run* something. The rail's mark carries it at full strength and the
  card in front wears a 12% wash of it over `--shelf` (`[data-strip-tone]`), so the thing you
  are looking at is identifiable before its words are read — an untinted item is `neutral` and
  is exactly the grey shelf every item used to be. The vocabulary is the palette's
  (`--shelf-tone-*` in index.css alias `--primary`, `--success`, `--warning`), so a theme
  needs no new token and `.dark` needs no override — the aliases point at tokens that
  already have one. **This is a tone of kind, never of state**: it says "this item is a
  shell command", not "something is wrong", which is the statement the shelf lost on purpose
  when the connection readings left it.
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
  **The cluster is colour-coded by subject, not by alert**: the project and the worktree branch
  wear `text-primary` and `text-step-tool`, the checklist `text-step-think` (the transcript's
  own reasoning blue), the changed-file count `text-success` — each a hue the palette already
  chooses, and each on the *mark* only, with the words keeping the row's own text colour. The
  context ring is deliberately left uncoloured: a dial that turns amber as a thread fills reads
  as an alarm in a cluster of settled facts.
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
  `/name args` is sent, the agent resolves it, the send path is untouched. Library slash
  commands are available in every thread whose runtime declares a command workspace layout;
  they are materialized globally and listed on drafts, not selected per thread. Their content
  is not injected into ordinary prompts: it applies only when the user invokes `/name`. The
  harness's own
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
- **A typed `@kind:ref` is a source on both halves, expanded at send into a `<context>` block.**
  The menu is a registry (`lib/mentions/`, one file per source) and the server's is its mirror
  (`server/src/mentions/`); the kind list is copied and `test:mentions` fails on drift. Grammar,
  kinds, the shared output budget, `@path:40-80` and `@mcp:` are in `docs/mention-sources.md`.

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
- **What an answer closes with is a set of kinds, one registry entry each** (`lib/suggestions`
  `SUGGEST_KINDS`, twinned by `personas.ts` `SUGGEST_REGISTRY`): follow-up prompts, project
  commands, quick replies, files, other agents to ask. A kind is a fence name, a caption and
  mark, how a pick is worded (`fill`), and optionally `keep` (drop lines that name nothing real)
  — the parser, the strip that hides the fences, the card (`suggestion-group.tsx`, one component
  for every kind) and the picker all read the table, so **a new kind is an entry on each side
  and no branch anywhere**. **A group is one card of hairline-divided rows, not a bordered pill
  per line** — a pill each said "four separate things" four times over, and with four kinds on it
  put thirteen rings around what is an offer rather than a form; it is the app's card of rows
  (`rounded-xl bg-card ring-1 ring-foreground/10 divide-y`), the same object at one row as at four.
  The kind's mark sits beside the **caption** and not on every row (four identical glyphs down a
  column are decoration; one beside the name says which family it is, and the row is left to the
  words), prose rows are `text-sm` clamped to two lines and shell rows `text-xs` mono truncated to
  one, and the hover ground comes up across the card's full width — which a ringed pill could not
  do without a second ring inside the first. A kind that must name something real is told it at spawn by a
  loader (`SUGGEST_LOADERS` in `sessions.ts`, read only while the kind is on): the project's
  helpers and package.json scripts for commands (the client then draws only lines that name one
  the project defines, so a hallucinated `!` is dropped rather than offered), the runner's
  installed other pairs for agents (a pick fills "Ask <agent> to <task>", naming the pair so
  the `agent` tool runs without asking which). **A pick fills the box unsent**, always — the
  read-before-it-goes bargain the `!` completer makes. The thread's set is `sessions.suggest_kinds`
  (project default `projects.default_suggest_kinds`; null on an old row reads the legacy boolean,
  `suggestKindsOf`), picked in Session settings › Suggestions, a submenu of switches with each
  kind's description; empty is off, and a changed set costs a respawn like any trailer.
- **A thread is taught the generated-view components by group, not all at once** (`lib/openui/groups.ts`
  `UI_GROUPS`: id, label, caption and the component names; `DEFAULT_UI_GROUPS` is every id). The
  reason is the trailer's size: the whole table is a long block every turn pays for, and a thread
  that never draws a map does not need `Map` described. `gen-openui.mjs` writes
  `server/src/openui-prompt.ts` as `OPENUI_FRAME_HEAD`, one `OPENUI_GROUPS` section per group,
  `OPENUI_FRAME_TAIL` and `OPENUI_GROUP_ORDER`, and `personas.ts` joins head + the chosen groups in
  order + tail (`openuiInstructions`; `normalizeUiGroups`, `uiGroupsOf` and `sameUiGroups` are the
  set's reading, and `layout` is forced in because the root is a `Stack`). The set is
  `sessions.ui_groups` (project default `projects.default_ui_groups`) and it is the **only** switch
  — empty is off, `layout` is the master row of the "Draw answers as UI" picker (unticking it turns
  the lane off), and the old `ui_blocks` boolean survives only as a legacy column `uiGroupsOf` reads
  for a row with no set. A changed set costs a respawn like any
  trailer, staged on a started thread by the same door as `suggestKinds`. It only narrows the
  asking: the renderer reads no set, so a fence from a group the thread was not taught still draws.
  `library.tsx` builds its `componentGroups` from `groups.ts` (names and membership are one
  place), keeping each group's notes beside the components.
- **The generated-view library has a component per recurring answer shape, and the prompt says which to
  reach for** (`Verdict`, `Matrix`, `Checks`, `Findings`, `Bars`, each in
  `lib/openui/components/`). They came from reading what threads actually drew: a table for every shape
  (a column of "Yes", a review as five-column prose, a ranking as a table of counts) and a conclusion
  buried under its evidence. Each takes a **flat** schema with strings the model already has, and each
  tolerates a half-streamed or empty prop. `Matrix` cells are plain strings whose first word is the
  verdict (`yes`/`no`/`partial`/`n/a`), not a typed cell per column, because pairing a
  typed cell with its column is what models get wrong — and both readers are `kit.tsx`'s
  `readStateCell`, which `Table`'s `tones: true` chips from the same word list, so `yes, per request`
  cannot mean two things in one answer; `Findings` sorts worst-first itself so the order
  the model found them in does not matter. The state chip (`ToneChip`), the state said as a dot and a word (`StateLine`) and the
  tone list (`TONES`) live in `kit.tsx` so a severity, a status and a badge cannot drift apart.
  The scale was raised once for legibility on a phone (14px body, uppercase `LABEL`, `FIG` up to 36px), and a status chip is a tone-washed pill rather than a dot-only outline.
  **Every component is one file in `lib/openui/components/`** and `library.tsx` only lists them, so
  adding one is a new file plus a line and restyling one is never a diff in a two-thousand-line
  module; they share one short, dense scale (`TITLE`/`BODY`/`META`/`LABEL`/`FIG`) and one three-step
  inset (`PAD`, `PAD_ROW`, `LIST_ROW`) from `kit.tsx`, and **none of them states a size of its own** —
  a component that wants a new one is a component that has stopped matching the rest. The page ground
  is the card's hairline rather than a shadow, because at this density a stack of seven soft-ringed
  18px cards read as a stack of buttons. **A group's notes may only name its own
  components** (`openui-trailer.test.ts` fails on a bare English word that is another group's
  component name, e.g. "List"), and the three composition rules in `gen-openui.mjs` (lead with the
  conclusion, prefer the most specific component, one view says one thing) name no component for the
  same reason.
- **A drawn answer may hold a choice and ask for words, and neither is a way out of the
  transcript** (`interactive` group, `lib/openui/components/interactive.tsx`). A field's value
  is the renderer's own store — a `$variable` when the program bound one (`reactive()` on the
  prop schema, `useStateField` in the component), form state scoped by the `Form`'s name
  otherwise — so nothing is stored and nothing survives a reload; `bindings:true` in
  `gen-openui.mjs` is what lets the model write one, and it is the library's flag rather than
  a group's, so it also brings the Built-in Functions section to every thread the lane is on
  (`toolCalls` stays false, and with it the Query/Mutation sections; the generator's only
  Forms documentation is gated on both, which is why the form paragraph is ours in
  `additionalRules`). A `Button`'s action arrives as an `ActionEvent` and the two kinds it
  dispatches are both the reader's: `continue_conversation` goes through
  `lib/openui/actions.tsx` into the composer **unsent** — the suggestion pick's bargain, from
  a context `ThreadView` provides because only it owns a composer, and a view drawn where
  there is none says so on the console instead of silently doing nothing — and `open_url`
  opens a real tab, `http(s)` only. `@Set`/`@Reset` never leave the renderer, which is why a
  filter costs no round trip, and no `toolProvider` is passed, which is why a `Query` cannot
  run.
- **Three view options govern the rows** (`lib/layout-options.ts`). **Show `!` commands** hides them
  outright — the command still ran and the journal still holds it, only the row is silent — and
  **Group `!` commands** folds a run of commands run back to back into one line (`ShellRun`,
  `groupShellRuns`). **Group tool calls** folds a stretch of consecutive *calls* into one
  expandable run (`ToolRunGroup`/`ToolGroup`, `groupToolRuns`).
  **A thought rides inside the run it explains.** One that leads a run or sits between two of its
  calls is a `RunItem`, drawn in place (`think -> read -> think -> read` is one fold); it was
  once a break, and the thinking hung over a fold that did not own it. One no call follows —
  trailing, or before prose — stands where it arrived, because it is the live tail and the group
  folds when it settles. A run is calls, thoughts and the settings changed between them. What a
  group cannot be is a group of one call: that is still a step, not a fold.
  The counting line is the
  calls': it says what the group did, not what was on screen.
  **A run is keyed by the integration it went to, not only by the layout** (`runKeyOf`): every
  MCP call resolves to the same `mcp` view, so thirty calls to four servers used to fold into one
  line reading "Running 30 tools" over a stack of six identical wrenches. The server is part of
  the key, so one integration's *consecutive* calls fold together, and the counting line and the
  stack are by integration too ("Bugsnag 6 calls · Clickup 4 calls", one mark per server rather
  than one per call). **The stack holds one mark per distinct act, never one per call** — the
  sentence beside it already counts the calls, so five `Bash` calls drew five identical terminals
  saying nothing the summary had not. Marks are keyed by `callKeyOf`, the same key `summarise`
  groups by, so the stack is a legend for its own sentence and its `+N` counts the acts that did
  not fit. Consecutive is deliberate: **a run never reorders the steps it holds**,
  because a call's result is often what the next call was for — so interleaved servers are
  several stretches inside one group, and that group's own line is what counts them together. **A setting changed between two of
  those calls rides inside the run too** (`isConfigNotice`): the agent changed nothing about the
  work it was doing, and drawn
  as a rule across the transcript the notice split one run into two, each counting half of it.
  Before the run's first call or after its last it is still a break — trailing, it is the last
  thing that happened *and* the item the turn's footer anchors on (`turn-footers.ts`), so it is
  never swept in there. `grouping.check.mjs` holds the cases. These are Detail-group rows, and neither shell option is
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
- **A sideways swipe on the tab strip walks the group's tabs** (`useTabSwipe`,
  `dock-surface.tsx`) — left is next, right previous, wrapping, through the same
  `cycleTab` the chords call. Only the strip: on the transcript a sideways drag is a text
  selection or a code block's horizontal scroll. Native touch pointer events on the
  document (dockview makes and unmakes strips, and a nested group has its own), a 10px
  axis lock that lets a mostly-vertical touch go for good, a 56px commit, and
  `touch-action: pan-y` on the narrow strip so the browser hands over the horizontal half.
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
  global store — the same bargain `layout-options` makes — keyed by a **`ShortcutId`
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

- **The tab strip's keys all pick from the group you are looking at**
  (`dock.tsx`), which is the strip in front of you; while the dock is one group
  that is also "every open tab", and once it is not, following the visible strip
  beats a global order you cannot see. Digits jump (`tabJump`, and the range is
  that binding's — the reader's first chord is what the recorder writes and the
  rest of ⌘1…9 answer to the same key), ⌘/Ctrl+Tab or ⌥/Alt+↓ walk the strip
  wrapping, and Alt+W closes the tab in front through the same guarded door its
  ✕ uses (`setTabIndex`/`cycleTab`/`closeActiveTab`, which the palette's rows
  also call). **Every chord here is one `matchesChord` can spell**, which rules
  out the plain Ctrl+Tab people reach for: `matchesChord` folds Control into
  `mod` by design (⌘ on Apple, Ctrl elsewhere), so the chord is `mod+tab` — the
  browser's own switch-tabs, which Chromium keeps, so it fires in the desktop
  shell and `RESERVED` says so on the row instead of leaving the dead web
  binding to be found by pressing it. Alt is the pair that works in a browser
  tab too, which is why it is the second. **⌘/Ctrl+W is not the close chord
  either** — Electron gives it to close-window, so it would quit the app rather
  than close a tab, the same reason `splitRight` is not ⌘W.

- **A split is split, walked and resized from the keyboard through the same table**
  (`dock.tsx`): ⌘/Ctrl+\ and ⌘/Ctrl+⇧\ split right and down, ⌘/Ctrl+⇧M fills the
  panel, ⌥/Alt+←/→ walk the grid's panes wrapping (`activateNext`, grid groups
  only — a float is not a column), and ⌥/Alt+⇧+arrows push the divider the way
  the arrow points (`resizeActive`): a pane with a neighbour that way grows
  toward it, one at the edge gives way. **Resizing is `group.api.setSize`, never
  the gridview**: dockview's sashes take the mouse only, but a group's size
  event reaches its parent splitview, and a branch forwards a child's
  `orthogonalSize` as its own size — so along the parent's axis it moves the
  group's own edge and across it the branch the group sits in, and a 2×2 moves
  both ways without touching the tree. In a row of three the far end absorbs
  first (splitview's `relayout`), not the neighbour a drag would move. **Both
  decline the key when there is nothing to act on** (`return false` from the
  `useShortcut` handler): ⌥←/→ is the browser's Back/Forward and ⌥⇧← selects by
  word in a composer on a Mac, and claiming them with no split would take both
  for nothing. The resize family is one row (`resizePane`, Fixed — the arrow is
  the key's meaning, as the digit is in `tabJump`); the walk is two rebindable
  rows. It is not ⌘/Ctrl+⇧+arrow, which selects by word in the composer, where
  the caret nearly always is. `splitDown` and `fillPanel` sat in the table and
  the tab menu with no handler for a while: **a row in `SHORTCUTS` is not a
  binding until a `useShortcut` names it.**
- **Full screen is the window, "Fill the dock" is only the dock** (`lib/workspace/fullscreen.ts`,
  `fullscreen` ⌘/Ctrl+Alt+F, the tab's Arrange menu, the palette). Three things move and one
  `leave()` puts all three back, whichever door the reader used: the group is maximized (only
  if we did it, and only when there is another group to fill over), the sidebar is collapsed
  (its prior state is restored, and handed back on `pagehide` because that state persists),
  and the page asks the browser's Fullscreen API where `fullscreenEnabled` (absent on an
  iPhone, where the in-app half stands alone). The browser's own Esc and dockview's restore
  both route to `leave()`. The mode is not persisted: a reload is a way out.

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
- **Clearance and material are the reader's and the OS's, not constants.** The header band pads
  its right by the caption overlay's measured width (`env(titlebar-area-width)` + 12px, 148px
  fallback) on Windows/Linux, and its left by 80px on macOS while the sidebar is collapsed or a
  sheet, so the traffic lights never sit on the toggle or the first tab. The strip pads by the
  header's content box and follows. **The native material can be turned off** (Settings ›
  Appearance › Desktop window, main's `window-translucent.json`, answered to preload
  synchronously so `data-desktop-vibrancy` is set before first paint): no vibrancy/acrylic/mica,
  an opaque window colour, and the page paints its own grounds. It is a window-creation option,
  so a change needs a restart; Windows keeps its Acrylic/Mica choice beside it.
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

## The dock

**Things changed the model after it was written; read the rest with them in mind.** A tab is an
isolated outlet: navigating repoints the tab in front (`navigateActive`), "New tab" always opens a
fresh one on the New tab page (`openTab`), and the same route may stand in several tabs — so the
"focus the tab that already has it" behaviour described below no longer exists (see the tab rule in
`CLAUDE.md`). And the sidebar has two layouts, Flush and Inset, picked in
Settings › Appearance and keyed on `html[data-sidebar-layout]`; in Flush a top group's strip is an
overlay under a progressive blur, in Inset it sits in the row above the card. Focus mode no longer
exists. **Splits are even**: a new group takes an equal share of its row or column
(`workspace/dock-sizes.ts`, from `onDidAddGroup`, skipped while a layout is being restored), and a
double-click on a divider evens out the views it separates — in the main dock and in a thread's own dock
(whose new panes keep the width their kind opens at).

- **How much of a panel the floating app header covers is measured, never assumed.** The
  header is an overlay across the top of the column, so the tab strip and every panel's content
  have to clear it — and both did that with the constant `--app-header-h`, which is right for
  the group at the top and wrong for every other one. A terminal docked *below* a thread
  reserved three rems twice over, once in the strip's margin and once in its own padding, for a
  header nowhere near it. `workspace/dock-header.ts` measures the header's bottom against each
  group's box and publishes `--dock-header-overlap` on the group element, which is what the tab
  strip clears. **What a panel's own content pads by is measured by the panel**
  (`--dock-content-overlap`, `lib/workspace/panel-overlap.ts`), and that split is not tidiness:
  the dock renders with `defaultRenderer="always"`, which attaches panel content to one overlay
  container at the dockview root rather than nesting it in the group — so a variable set on a
  group element reaches its strip and nothing else, and the panels quietly kept falling back to
  the constant. The dock's part is the *nudge*: a group can move without changing size (a sash
  settling, a maximize, a panel dragged between groups), which an element watching only its own
  size never hears about. A popped-out panel measures zero — `ownerDocument` is what tells the
  two windows apart — a zero-height box keeps its last answer rather than reading a hidden tab
  as fully covered, and the constant survives only as the fallback: one frame before the first
  measurement, and the surfaces that are not in a dock at all.
- **Every place-shaped row outside the dock opens any of three ways, and they are one vocabulary.**
  A click navigates the tab in front (`navigateActive`); the row's menu adds "Open in new tab" and
  "Open to the side" (`components/open-in-menu.tsx`, over the doors in
  `lib/workspace/open-threads.ts`); and the row itself is draggable into the dock. The drag is a
  native HTML5 one carrying the route (`lib/workspace/route-drag.ts`), because dockview's own drag is
  pointer-based and internal to its panels — these rows are not its. `dock-drop.tsx` reads the group
  under the pointer off `DockviewGroupPanel.element`: a band's worth of the top of a group is its
  strip (a tab there), a quarter of its width or height at an edge is that side of it (a column or a
  row), and the rest is the group itself. The mark it draws is the half the drop would take, so a
  side drop is believable before the button is released; `within` covers the group, because the
  group is what a tab joins. Floats and the bottom panel are not targets — a float would cover the
  strip the tab is meant to join. A phone is not a target either: `draggable` is off there (the press
  is the long press that opens the menu) and the fold would take the split back anyway.
- **Tabs are grouped by dockview's own tab groups, in one instance.** A tab group is a chip
  over a run of tabs in one strip (`api.createTabGroup`/`addPanelToTabGroup`, serialized in
  each group's `tabGroups`, so the layout save carries it with nothing of ours). The tab's
  menu has "Add to tab group ▸" (a new one, or any of *this strip's* — a tab group never spans
  two strips), "Remove from tab group", and "Open with this tab ▸". Its first rows join the
  new panel to this tab's tab group, right after it (made for the two of them if there is none,
  and only once the panel exists); its second rows — "Terminal below", "Preview/Tasks to the
  right" — are a **split** beside this tab's strip, because a tab group never shows two tabs at
  once and seeing both is the point. The destination travels with the call
  (`OpenPanelOptions.into`, through `openWorkspacePanel`'s `target` and `openTerminal`, across the
  terminal's POST) and so does the tab's own project — it used to be a 2s module-level aim any
  open could spend, and the project was whatever tab was in front. The timed aim went with the
  strip's + menu: the + opens a tab (`openRoute("/", { group })`, so it lands on *this* strip)
  and nothing else, so there is no panel whose arrival a later navigation has to be aimed at.
  The rows come from `useTabNeighbours`, re-read on dockview's layout change, which is where
  tab-group changes are folded in. The chip's menu (`getTabGroupChipContextMenuItems`,
  `dock-surface.tsx`) is dockview's rename, colour picker and collapse plus two of ours:
  Ungroup (`dissolveTabGroup`, the tabs stay) and Close group (`closeTabGroup`, through the
  guarded door, pins stepped over — dockview's own `close` would remove the panels past both).
  The palette is `TAB_GROUP_COLORS` in `dock-context.ts` — `--primary` and `--chart-1…5` — so a
  chip follows the theme; dockview paints it white-on-colour, which the light chart greys
  cannot carry, so `index.css` draws it as a 22% tint with the foreground and the full colour
  as a dot. Chips are hidden below `md`, where the strip draws one tab.
  **This replaced a dock inside a tab** (a `group` panel holding a second `DockviewReact`).
  Everything about it was a second instance: two places to look for a panel, a close-and-open
  to cross between them, a drag between strips dockview never accepted (a foreign panel needs
  `onUnhandledDragOver` to `accept()`, and nothing did), and tab-menu rows that asked the outer
  instance for a grouped tab and got nothing. A saved layout that still holds one is unpacked
  by `pruneLayout` (`unpackGroupPanels`): the group tab's place in the strip becomes the tabs it
  held, as one tab group, the first of them in front if the group was. `layout.check.mjs`
  (`../server/node_modules/.bin/tsx src/lib/workspace/layout.check.mjs`) holds that and the
  pruning of tab groups and the bottom panel.
- **The bottom panel is dockview's edge group, and a tab is only ever *sent* there.** "Move to
  the bottom panel" is `revealEdgeGroupWithData("bottom", …)` — dockview's create-or-fill, whose
  group is flagged to go away with its last panel — then expanded with its strip on top, where
  every other strip is. "Move to the main area" is the way back and is never withheld, phone
  included; the palette's "Show or hide the bottom panel" collapses it to its tabs. It is not a
  split and nothing opens into it, so "opening never splits" still holds. `pruneLayout` prunes
  the serialized `edgeGroups` like a leaf and drops one left empty. A phone's fold
  (`stackAll`) pulls its panels back into the grid with the floats. Auto-hide, dock-to-edge by
  dragging and the peek are enterprise modules and inert here.
- **The outer dock holds five panel kinds: chat, terminal, web (the *Browser* panel), tasks
  and page.** There is no IDE: the editor, file explorer, file search, the source-control panel
  and the server's code-server were removed — a thread's Preview is the project's window, and
  its Changes panel is where a turn is reviewed. The page panel
  (`components/workspace/page-panel.tsx`, descriptor `{kind:"page", path}`) is every route
  that is not a thread, rendered through the app's own route table against the panel's path
  (`<Routes location>`), so the dock is the main area on every route and a settings page
  can stand in a tab beside a chat. **It is the app's browsing tab** (`openPage` in
  `workspace/dock.tsx`): opening a page repoints the tab already standing for that place
  (`pageKey` in `lib/workspace/panels.ts` — one settings tab whose path moves between
  sections, one per project page, one per trace), else the unpinned page tab, else opens a
  new one — so pages do not pile up the way a tab per place did, and pinning is what keeps
  one. Its id is unique and says nothing about its path. The URL points the tab and focusing
  a tab writes the URL; `location.key` is in the route effect's deps so a sidebar row for a
  tab you just closed opens it again. Pages still read `useLocation` from the address bar,
  which is the panel's own path whenever it is the active tab. The landing console is a page
  tab too, and it is what the dock lands on when the last tab closes — **every "New thread"
  gesture mints a thread instead** (`actions.startThreadIn`, so ⌘N twice is two threads). The
  one console that is spent is the one a thread was started from: `consumeConsole` runs on the
  chat route effect, *before* the chat opens (opening it is what makes it active) and only for
  a routed draft, which is what the console mints before it sends. The tab's mark is its
  sidebar row's (`PageIcon` in `panel-kinds.tsx`); its title is written forward only, so a
  restored tab never flashes "Page".
- **The Preview panel is a viewer and editor for project files and diffs, never a browser.** A mention,
  a file link or a source-control row opens it (`web-panel.tsx`): a file is drawn by
  `FilePreview`, a diff by `DiffTab`, and there is no address bar, no embedded page, no
  `<webview>`, no console and no element picker. It was a browser once; **driving it from an
  agent never worked with the desktop shell**, so the shell no longer opens a debugging port
  and nothing in Electron touches CDP. `parsePanel` drops a stored `web` panel that carries a
  browser-era `url`/`trust`; a `web` panel with no file is *not* one of those — it is the
  explorer alone, and it comes back.
- **The project's working tree stands beside the preview, in either dock** (`project-tree.tsx`).
  It was a thread's alone, and the gate (`useThreadDockSession()`) left a Preview opened from a
  source-control row or a mention in an outer tab a window onto one path; the project's files
  are the project's, so the gate is gone and the width rule below is the only one. `Files` (the
  `+` over a transcript, or "Project files" in the palette) opens the Preview panel with no file
  at all. The tree is what makes the panel somewhere to
  *navigate* rather than a window onto one path: a click there repoints the same panel at
  another file, so a file and a diff are places *inside* it, and the descriptor is the state
  (`api.updateParameters`) so a panel showing nothing but the tree restores exactly as it was.
  A directory is read when it is opened and not again unless **the watch stream** says
  something moved (the tree family is invalidated; only the branches on screen are mounted, so
  that is all that is re-read) — no polling, no focus refetch. The file being previewed is
  revealed: every ancestor opens and its row is scrolled to. The find box is the route the
  composer's `@` menu already reads, because a cwd with a `node_modules` in it is not browsable
  by hand; a folder it finds is opened in the tree rather than in the viewer, which cannot show
  one. Dotfiles and git-ignored directories are the reader's call (`preview-prefs.ts`,
  device-local like every other reader's property — with the pane's width), stated in the
  request rather than filtered silently on the client. What fits is measured on the panel,
  never the window: **below the width a tree needs beside a preview, the two stop being panes
  and become two screens** — the tree takes the panel whole when nothing is open, and the
  toolbar's `PanelLeft` mark navigates back to it from a file or a diff instead of hiding a
  pane that is not there. That is what makes a phone, or a Preview docked beside a terminal,
  able to browse at all; before, the panel said it was too narrow for the tree and offered
  nothing, on the one `+ → Files` gesture that asked for it.
- **The Preview panel holds open files, and an unsaved edit is never the editor's to keep.**
  `tabs` in the `web` descriptor are the files open and `file` the one in front; a file pointed
  at from outside arrives as `file` alone and becomes a tab, so there is one reading of the
  descriptor and `parsePanel` keeps the list. Back/Forward walk a history that is the panel's
  own and **not saved** (a back button that survives a reload goes somewhere nobody remembers);
  it is mutated only by `visit`, and a step along it sets a flag so the step is not recorded as a
  visit. Editing is Monaco on a model of the text (`file-editor.tsx`), and **the text of an unsaved
  edit lives in `lib/workspace/edit-drafts.ts`**, keyed by project and path, so a tab switch, the
  viewer toggle and a re-open lose nothing; a draft is *dirty* when its text differs from its base,
  so opening a file to look at it never raises a discard question. A save is a write at the version
  the file was read at (`expectedVersion`); a 409 is said with its two ways out (Reload drops the
  edit, Overwrite sends `force`), and the watch stream is read by asking the file's version, so a
  clean draft follows the disk silently and a dirty one only says so. The tree writes through
  the project's file routes but **does not decide what a rename or delete does to the panel**: it
  reports `onRenamed` / `onDeleted` and the panel moves or drops its tabs, history, open editors
  and drafts together. Closing a tab, a deleted folder holding edits, or the panel (a close guard)
  asks first. Drafts are deliberately not persisted: one that outlived a reload would be applied to
  a file that may have moved on, which is what the version exists to catch.
- **A hidden chat tab is `display: none` while its thread dock stays mounted.** Dockview's
  `always` renderer hides an inactive panel with `visibility`, which the inner dock's own
  overlays escape; `display: none` cannot be escaped, and keeping the dock mounted is what
  lets a Preview's file and a shell come back to what they were instead of reloading.
- **A panel kind is a surface, and a surface that reads the URL cannot be one.** The tasks
  panel is the case that proved it: the board workspace answered "which board, which task"
  from `useParams`/`useSearchParams`/`useNavigate`, so a panel switching board would have
  navigated the page it is drawn on — taking the dock and every other panel with it. The
  three questions are now one interface (`lib/tasks-location.ts`) with two answers: the
  route's, at `/board/:boardId?task=`, still the place a board is linked from, and the
  panel's, which keeps them **in its own descriptor** and so survives a reload the way every
  other panel does. There is **one** tasks panel (`panelId` is the bare `"tasks"`): another
  board is this panel moved, exactly as another file is the IDE moved, and boards belong to
  the server rather than to a project — which is why it is the one kind that opens with no
  project and the one the prune cannot call stale.
- **Opening a thread opens a tab.** The dock's `replace` — a same-kind open with no
  direction and no `newTab` takes the place of the panel it opened from — used to include
  chats, which made the sidebar read as navigation: click the next thread and the one you
  were reading closed. It is the other way round now (`{ newTab: true }` at both doors: the
  route effect and `handleDockReady`). A thread you opened is a thread you meant to keep, and
  `openPanel` keys on `panelId`, so an already-open thread is focused rather than duplicated
  — the flag only decides what happens to a thread that has no panel yet. **Both** doors have
  to say it: `handleDockReady` can run *after* the route effects (a cold load, or a theme
  change remounting DockviewReact), and an open without the flag had the brand-new thread eat
  whatever chat was in front of you. This retired `lib/session-tabs.ts` (the one-shot "open the
  next one in a tab" flag), the ⌘-click on a sidebar row and the row menu's "Open in new tab",
  all three of which now name the plain click — which is also why the row's "New thread in new
  tab" submenu is gone: plain "New thread" opens the tab.
- **A draft's tab comes back after a reload.** The row is client-only, so the server's list
  cannot carry it, and `prunePanels` — whose authority *is* that list — closed every unsent
  thread's tab on the next boot and let the debounced layout save make the loss permanent.
  `lib/draft-sessions.ts` persists the rows per server (mint,
  retune, rename and forget all write through it, `refreshSessions` prunes the ids the server
  learns), and `bootstrap` re-mints them *before* the prune's gate opens — but only the ones
  the saved layout still names a tab for, so a tab you closed stays closed. The half-written
  message was never the problem: `lib/drafts.ts` already kept that per session id, and the
  same id comes back.
- **A tab's title is only ever written forward.** `ChatPanel` sets it from `sessions`, and
  **skips the write when the store has no row yet** — dockview serializes titles, so a
  restored layout already knows every tab's name, and writing the `PANEL_SPECS` placeholder
  unconditionally renamed all of them to "Thread" for the width of bootstrap. A session list
  that loaded slowly showed it as a flash; one that failed left it there for good.
- **What a panel is doing is data, published by the panel and drawn by the tab**
  (`lib/workspace/panel-status.ts`, `components/workspace/panel-status-dot.tsx`). It used to
  be a glyph the chat panel prefixed onto its own title, which made the reading part of the
  *title*: no other kind could have one, it could not be coloured, and a screen reader read
  it as a stray character. (**The project a chat runs in is not on its tab** — it is the
  composer's scope band, where it is a name rather than a 14px mark that drops its label
  below `sm`.) A dock keeps every panel mounted, so the strip is the only place a
  panel nobody is looking at can speak — a turn waiting on you, a shell that exited, a dev
  server that failed, unsaved files in the IDE. Four tones, and the whole sentence in the
  label, because a strip has room for one dot and a pointer and a screen reader both read the
  title. Live, per mount, and never serialized.
- **A tab fills the row it is in, and the row's ground is the hierarchy.** A tab is a real
  object — the piece of the card under it that reaches up into the strip — and it was drawn as
  a 28px slab *floating* in a 32px row, with 2px of air on all four sides and nothing to be a
  slab of. That meant something in the header's band, where the row and the chip were the same
  height, and nothing anywhere else, and the selection was carried by one 4% tint: at 4% of the
  foreground the unselected tab was already a full step of the ramp (`--app-ground-step`,
  lib/theme-ramp.ts), so the active tab's `--background` read as a shade of the same grey
  rather than as a different material. The chip is now `h-[var(--dock-chip-h)]` and the *cell*
  is what keeps the air (`py-0.5`, `m-0.5`), so the selected tab rises the full height of the
  row and the rest are the ground with a title written on them. **Three weights of one
  material, and no colour on any of them**: resting is a 4% wash of the foreground toward the
  ground — the smallest step there is, short of the 7% that is a full step of the page's own
  ramp — hover is the same wash at 8%, and the selected tab is the card's own ground and its
  `shadow-sm`. Hover sitting *between* the two weights rather than on top of the active tab is
  what stops pointing from looking like selecting, and the resting wash is what makes a row of
  six tabs something to aim at rather than six pieces of text: on a bare band the only thing
  marking one cell off the next is where the title happens to stop. A tab's own leading padding
  (`pl-2.5`) is unconditional, so nothing shifts as a tab becomes active, and the slab's corners
  are `--radius` less the cell's 2px inset — concentric with the card's `--radius-xl` rather
  than a small arc against a large one. **One height
  token for everything standing in a strip** (`--dock-chip-h`/`--dock-control-h` on `:root`,
  because the app header's own `HEADER_CHIP` controls stand in the same row whenever a group
  joins the band and a token scoped to the dockview element is one they cannot see): it was
  `h-7` on the chip, `size-6` on the strip's own + and list, `size-5` on the chip's ⋮ and ✕ —
  three numbers in three files, which is how a 24px target ended up running a strip. A tab's
  cap is 256px rather than 304px (five tabs were 1520px of tab in a 1184px strip, so every one
  of them was already squeezed), and the strip's first tab starts on the same 8px line as the
  card under it.
- **Dockview owns the tab's ARIA; `panel-tab.tsx` owns its face.** dockview-core 8.2 already
  builds the WAI-ARIA Tabs pattern around our renderer: `role="tablist"` + `aria-orientation`
  on the strip, `role="tab"` + `aria-selected` + `aria-controls` per tab, `role="tabpanel"` on
  the content, a **roving tabindex** (one tab stop for the whole strip) and the keyboard the
  pattern asks for — ArrowLeft/Right, Home, End, Enter/Space with manual activation. All of it
  rests on one condition, and the tab this replaced broke it: **nothing rendered inside
  `role="tab"` may be focusable.** Dockview routes its keys with
  `tabs.findIndex(tab => tab.element === event.target)`, so focus on a nested `<button>`
  answers -1 and every arrow key goes dead — and two extra tab stops per tab is not a single
  tab stop. So the ⋮ and the close are `tabIndex={-1}` and the keyboard reaches them the way
  VS Code and Chrome do: on the tab itself, `Delete`/`Backspace` closes and `Shift`+`F10` (or
  the Menu key) opens the actions, with both controls drawn while the tab has focus so the
  keys are discoverable by the one reader who cannot find them by pointing — and their slot is
  `pointer-events: none` until the state that reveals it arms it, because an invisible button
  is still a target. The tab also gets
  a **visible focus ring** — a roving tabindex you cannot see is arrow keys into the dark.
  **The two controls float.** They were the tab's last flex item, which held a gutter open on
  every tab in the strip for a pair of things that exist only while one of them is pointed at;
  they are absolutely positioned against the chip's trailing inset now, so a title owns the whole
  of the tab's width. The title and its `PanelStatusDot` are **one box** under the fade — the dot
  inside it is why the ✕ no longer lands on the dot on hover — and what the controls cover when
  they appear, the title stops saying: `--tab-fade-w` masks its end for the width of what is
  actually there, declared on the chip (hover, focused, or holding the ⋮'s menu open) and
  `@property`-registered so it interpolates, with the transition on the mask alone. The **pin is
  a `[data-tab-action]` too**, so it is the one control drawn before you point and the fade can
  size itself to it; the close no longer takes the active tab's exemption, since a floated
  control has nothing to be covered by. The mask's transition joins the strip's other two in the
  `prefers-reduced-motion` block, so the fade is a step for the readers who asked for one.
  What dockview cannot know is what the panel is *doing*: its `aria-label` is the plain title,
  so `useTabLabel` rewrites it with the reading and the pin state folded in.
  **Dockview's own overflow dropdown is off** (`disableTabsOverflowList`): it draws one at the
  same end of the same strip as `TabActions`, and ours lists every tab rather than only the
  hidden ones, says what each is doing and closes one without bringing it back first. It also
  carries the group's **Close all** at its foot — the same guarded bulk close (`closeGroup`,
  pins excepted) the tab's ⋮ offers, so a reader tidying a strip is not made to open one tab's
  menu to close the rest of them — and the phone's tab grid carries the same action, since the
  folded strip shows one tab and the grid is where the others are.
- **A narrow strip is the tab you are on, and the list holds the rest.** A phone's strip used
  to draw every tab as its mark and collapse the ones you were not on to `2.5rem` — the tab's
  `max-width` cap and a grid column taken to `0fr`. That is gone: a row of glyphs is a second
  thing to read beside a list that already names every tab, and a tab you cannot read by name
  is a tab you switch to by trial. `index.css` draws the active tab and `display: none`s the
  others — **a hide, not a collapse**, so there is no width or opacity to interpolate and no
  direction for a node leaving to take: a tab switch is one frame, which is the instant a
  browser gives one. Nothing swaps on the viewport either, so the mark no longer trades a
  chat's `PanelIcon` for the **initials of its title** (`initialsOf` is the assignee avatar's
  again, nothing more) and `panel-tab.tsx` holds no viewport branch. What is *not* hidden is
  unchanged: the wide strip keeps its one-column title container, which is a resize
  (`transition` there was for a collapse that no longer happens), and dockview's reorder is the
  strip's only motion (`--dock-tab-duration`). The tab list (`TabActions`) is the switcher from
  **two** tabs on a phone rather than three: its strip draws one, and the list is the only
  place the other is.
- **A pinned tab is one the tidy-up goes around.** `lib/workspace/panel-pins.ts` is the set
  (device-local, keyed by server, like every other reader's-property store); the dock adds
  the ordering. Pinning means three things together: the tab sits at the front of its group,
  it carries the pin that unpins it instead of a close button, and **every bulk close steps
  over it** — `closeOthers`, `closeToTheRight`, `closeGroup`. Its own Close still names it, so
  nothing becomes unclosable. Dockview 8 ships a pinned-tabs module and this build does not
  have it (`api.setPinned` is inert without it), which is beside the point: "renders first"
  was never the half that mattered.
- **A preset rearranges; a saved layout opens and closes.** `applyPreset` moves what is open
  and nothing else — that rule has not changed. A **named layout** (`lib/workspace/layout.ts`)
  is the whole dock, contents and arrangement, kept under a name and given back by it, which
  is why it is asked for rather than offered as a tidy-up. Saving under a name that exists
  replaces that layout: "Review" saved twice is one arrangement refined, not two rows to tell
  apart. Restored through the same `pruneLayout` as the live one, so a saved layout naming a
  thread the server has forgotten comes back without it rather than not at all.
- **A panel can leave the dock, and the way back is what the layout stores.** Floating groups
  are enabled and bounded within the viewport (a float dragged off-screen is a panel with no
  way home). A **popout** is a real browser window (`addPopoutGroup`, into
  `public/popout.html` — an empty room, no script, no second app; the service worker's
  navigation fallback denies it by name or it would be answered with the whole shell). It is
  a user gesture only, and a blocked popup is *said* rather than swallowed. **On a phone
  neither is offered** — a float covers the dock it came from and a popout is a second browser
  window, so the tab's ⋮ leaves both rows out. On the way back
  in, a float is restored whole or not at all and a popout is **never** reopened —
  `window.open` without a gesture is a popup — so `dockPopouts` brings its panels home to the
  group they were torn from *before* anything is counted, because a panel in `panels` that no
  leaf names is one the dock holds and cannot show.
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
  optimistically. `file-search.tsx` asks **two questions from one box**, and they are two routes
  because they are two questions: the name half is the route the composer's `@` menu already
  reads (one idea of "roughly this name"), and the content half is `/files/grep`
  (`searchContents` in `workspace-fs.ts`). The content half **reads bytes and cannot leave the
  project** — which is exactly why it is a different route from the `@` search, whose query
  names a scope on the whole machine and only ever lists names. It matches a case-insensitive
  substring and returns the whole line, and it is deliberately not a shell out to `rg` or
  `git grep`: a project need not be a repository and neither binary is something the harness may
  assume. Ignores are the explorer's own, so a search never finds something the tree would not
  show. `scm-view.tsx` groups `git status` the
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
- **The history is drawn as a graph, and the walk is pure.** `lib/workspace/git-graph.ts` is the
  half worth testing: an open lane waits for a hash, a commit claims the first lane expecting it
  or opens one, hands that lane to its first parent and appends the rest — which is the whole of
  what makes a merge fan out. The drawing (`scm/commit-graph.tsx`) only turns a `GraphRow` into
  SVG. The log route carries `parents` and `refs` because the picture is unreadable without
  them: lanes are derived from parent hashes, and a branch tip is the only thing that says
  *which* line is which. Lane colours are `stroke-*`/`fill-*` utilities, never `--chart-*` —
  those are deliberately greyscale in this app's neutral palette, so six lanes would be one
  indistinguishable smear. Row height is one constant shared by the SVG and the list, so a dot
  cannot land beside the wrong commit. List or graph is `idePrefs.historyLayout`, device-local
  like the file layouts; the graph is the default because a log read beside a running agent is
  usually "which line did that land on".
- **A commit message is drafted through a profile, and the diff never leaves the server.**
  `POST …/git/draft-message` takes a profile and a repo, gathers the diff itself
  (`git.commitMessagePrompt`) and asks `enhancePrompt` with `kind: "commit"` — one model call,
  not a turn, so nothing is journaled and the key stays server-side, the same bargain the
  composer's enhancer makes. The diff is gathered here rather than sent up because it is
  routinely hundreds of kilobytes and re-implementing `git diff` in the client to ask a question
  about git's own output is the wrong shape. Two things it gets right that a naive version does
  not: **untracked files are in no diff at all**, so they are read in as `--no-index` new-file
  hunks (that command exits 1 whenever there is a difference, which `run` now accepts as an
  answer), and staged work wins when there is any, since that is what a commit would actually
  contain. The button is drawn only where a profile can actually do it — a disabled wand nobody
  can enable is worse than none.
- **Logical commits are the same draft, split, and reviewed before they land.** `POST
  …/git/draft-plan` gathers *every* changed file — staged or not, untracked included, as HEAD
  against the worktree — because what happens to be staged is not a boundary the author drew
  for this question (`commitMessagePrompt(…, "plan")`), and asks `enhancePrompt` with
  `kind: "plan"` for JSON (`{commits:[{message, paths}]}`). The route keeps only paths that are
  really changed and reports the rest as `unplanned`. Nothing is written until the reader
  presses "Make N commits" in `scm/commit-plan-dialog.tsx` (messages editable, files movable or
  left out); the `commit-plan` action then lands it through `git.commitPlan`, which refuses an
  unknown or doubled path before writing anything, and per commit clears the index and
  `add --all`s exactly that commit's paths (a rename brings its old path), so a deletion and a
  rename land whole and anything unnamed stays changed. A refusal mid-plan says how many
  commits it made. `test:git-commit-plan` runs it against a real repository.
- **The Git half is Sublime Merge's shape** (`thread-view/source-control.tsx`): Locations
  (`scm/locations.tsx` - branches, remotes, tags, stashes) | commit table (`scm/commit-table.tsx`,
  every branch via `GET …/git/log?all=1`, "Working Directory" as its first row) over a detail
  pane. Working Directory: files + commit box at the left, **the file's hunks at the right**
  (`scm/hunk-diff.tsx`) - git's own `GET …/git/diff` output cut by `lib/workspace/diff-patch.ts`,
  so a hunk or the picked lines of one go back through the one `apply` door (stage `--cached`,
  unstage `--cached --reverse`, discard `--reverse`; `diff-patch.check.mjs` runs it against git).
  A commit: message + files at the left, its hunks (read-only) at the right. The log omits
  `refs/stash` (`--branches --remotes --tags HEAD`, not `--all`), whose synthetic commits would
  read as history. **Nothing loads whole**: branches, remotes and tags are pages of `GET …/git/refs?kind&offset&limit&q` (`git.refsPage`, newest first, the checked-out branch pinned; a collapsed group asks for nothing) and the commit table pages the log with `skip` - both through an IntersectionObserver sentinel at the foot, so a repository with thousands of refs costs one page. The repository picker is a `ui/Select`, and `GitRepo.worktree` (git dir ≠ common dir, `git.isLinkedWorktree`) draws a WORKTREE badge beside the name. The commit box is Sublime Merge's: a summary line (72-char counter), a description and a full-width Commit button, over the one `message` string. Below `@panel-lg` Locations is an overlay the table's toggle opens. The
  Locations rows carry a right-click (long-press) menu - check out, merge into HEAD, rebase HEAD onto (a conflicting rebase is *aborted* server-side: the panel has no continue/abort, a conflicting merge is left for the conflict group), rename, delete; stash rows apply/pop/drop; tags delete (`git.refOp`). **The four panes are a dockview of their own** (`scm/scm-dock.tsx`, the thread dock's recipe one level in: `.dock-nested`, a closed world, `--dock-header-overlap` zeroed because a custom property inherits): Locations, History, Files and Diff are panels the reader can hide (the tab's close or the Panels menu), drag into each other's strip, split and resize; the arrangement is device-local (`lib/workspace/scm-dock.ts`). `GitWorkspace` builds each pane as a node and hands them down through a context, because every pane reads the one selection. A panel narrower than `@panel-sm` stacks them as one group's tabs and never saves that layout. Opening Source Control from the thread dock gives it 70% of the dock's width (`place` in `thread-dock.tsx`). The Monaco side-by-side diff is still one click away ("Full diff"). `HistorySection` and
  `CommitGraph` (the old sidebar history) are no longer drawn.
- **The working set is grouped rows, not a tree** (`thread-view/source-control.tsx`): each row
  is the file's name, its folder dimmed beside it, and its `+/−` lines (`git diff --numstat`,
  read with the status), under a group header that carries the group's own lines and bulk
  verbs. The tree layout (`git-tree.ts`, the windowed `ScmView`) went with the IDE's view.
- **Touch is the device's; width is the panel's.** Row heights and icon buttons follow
  `useCoarsePointer` (44px on a finger, 24–28px with a mouse), and row actions are always
  visible on a finger because there is no hover to reveal them. Below 560px of *panel* width
  the side view and the editor take turns — a 224px explorer beside a 130px editor is two
  things you cannot use — and picking a file or a diff is what closes the side view. The turn-
  changes tab does the same with its file list and its diff under `@panel-md`.
- **Workers are wired, and by import rather than by path.** Since 0.56 the four *language*
  workers declare themselves as `new Worker(new URL(…, import.meta.url))` inside the package,
  which is exactly the shape Vite compiles into a worker chunk — and for a while that read as
  "workers need no wiring". The editor worker is the exception that made it false:
  `editorWorkerService` names its module with a bare `new URL(…, import.meta.url)` and hands
  the *string* to a blob bootstrap that imports it. Vite reads a bare `new URL` as an asset
  reference, and `editorWebWorkerMain.js` is 544 bytes — under `assetsInlineLimit` — so the
  built app inlined it as a `data:` URL and the worker died on its first import: *Failed to
  resolve module specifier "../../../base/common/worker/webWorkerBootstrap.js". Invalid
  relative url or base scheme isn't hierarchical.* A `data:` URL has no base to resolve a
  relative specifier against. Raising the inline limit does not fix it either — the file would
  then be copied flat into `assets/` and those same relative imports would 404.
  So `lib/ide/monaco.ts` defines `MonacoEnvironment.getWorker`, and two things about it are
  load-bearing. It is `getWorker` and **never** `getWorkerUrl`: each worker is named by a
  `?worker` import (through the package's export map — `monaco-editor/editor/…`, not
  `monaco-editor/esm/vs/…`, which the map would double), so the bundler resolves and bundles
  it and a path that stopped being true is a build error rather than a blank editor. And it
  must answer for **every** label, not just `editorWorkerService`: the language workers' own
  factory (`internal/common/workers.js`) consults `MonacoEnvironment.getWorker` first and
  returns whatever it gets without falling back to the package's own `createWorker`. The new
  chunk is `editor.worker.start-*.js`, added to the service worker's `globIgnores` beside the
  language workers — the IDE stays out of the precache.
- **The terminal panel is chrome around a canvas, and the chrome is the product.** xterm
  draws the buffer; everything a person needs *around* it is this panel's: search over the
  scrollback (`@xterm/addon-search`, ⌘F / Ctrl+Shift+F — never bare Ctrl+F, which is
  forward-a-character in readline and in vi), copy and paste, clear, the type size, and the
  helper key row. Two buttons live in the strip (find, and reconnect/restart when the shell
  is not running); the rest are behind ⋯, because this panel is frequently 300px wide beside
  a transcript and a toolbar that wraps is a toolbar that eats the terminal.
- **Ctrl+C copies when there is a selection and interrupts when there is not**, which is the
  one place a terminal is allowed to reinterpret a key the PTY would otherwise get — no shell
  reads that keystroke as anything else while text is selected. ⌘ takes both outright.
  **Clear is a view, never the record**: `terminal.clear()` drops what is on screen and the
  server's scrollback is untouched, so a reconnect brings the build log back.
- **A shell that exited cannot be reconnected to.** The PTY is gone, so `exited` offers a
  *new* shell in the same project — a new terminal, a new panel — while this one keeps its
  scrollback until it is closed. Reconnect stays for a dropped socket, which is the other
  failure and a different fix.
- **The bell and the OSC title are what a terminal nobody is watching says.** A bell raises
  the tab's `attention` status until the reader types into the panel or clicks it; the title
  the shell sets becomes the tab's, so a strip of five terminals says which one is building.
- **xterm paints its own surface, so every colour it is given has to be a hex.** The palettes
  here are `oklch` and `getPropertyValue("--foreground")` hands that back verbatim; xterm's
  parser knows `#rgb`, `#rrggbb` and `rgb()` and silently drops anything else for its own
  default — which is what "the terminal has no light mode" looked like. Tokens go through
  `colorToHex` (`lib/theme.tsx`, a 1px canvas), and the **background is resolved to the colour
  the panel is actually painted in**: `background: "transparent"` only means transparent with
  `allowTransparency`, which must be set before `open()` and costs performance — without it
  xterm forces the alpha to 1 and `transparent` becomes opaque *black*. The walk up for that
  colour reads the alpha as a number, because `rgb(0, 0, 0)` and `rgba(0, 0, 0, 0)` end in the
  same three characters and one of them is a real theme. The palette is re-read on the mode
  **and** on `colorTheme`, a frame late, since the provider writes the class and the
  `data-color-theme` attribute in its own effect.
- **A keycap's label is its content.** It was briefly a prop nothing rendered — a row of blank
  keys, which is not a keyboard. Every icon-only control in this panel carries a `title` as
  well as an `aria-label`: a strip of unlabelled 24px glyphs is unreadable to a pointer and to
  a screen reader for different reasons, and both are cheap to answer.
- **The helper key row follows the soft keyboard, and that is not a nicety.**
  `interactive-widget=overlays-content` means the keyboard is drawn *over* the page rather
  than resizing it (`lib/keyboard-inset.ts`), so a row anchored to the bottom of the panel sat
  behind the keyboard — present, correct and invisible on the one device it exists for. The
  panel pads its column by `--keyboard-inset`, which lifts the row and shortens the canvas by
  the same amount, and the canvas's ResizeObserver tells the PTY the new size.
- **The key row is compact, wraps, and stops at two rows.** It wraps rather than scrolling
  sideways, because a single scrolling line put half the keyboard — the reader's own half,
  appended after sixteen built-ins — off the right-hand edge, which is a keyboard you have to
  swipe to type on. Two rows is the ceiling (`max-h-15`: two `h-7` caps and the gap, in the
  spacing scale, so it follows the density setting); past that the block scrolls, and the ⌃
  button opens it to full height. Caps are 28px and labelled with the conventional symbol
  where there is one (↑, ⏎, ^C) with the whole name on `aria-label` and `title` — **under the
  44px touch target the rest of the app keeps, deliberately**: these are keys, pressed in
  sequence in sight of what they type into, and a keyboard of 44px keys covers the terminal it
  exists to drive. Order is reach: modifiers, Tab/Esc, the reader's own keys, then the rest.
- **Custom keys are edited, reordered and removed in place** (`lib/workspace/terminal-keys.ts`
  keeps the id through an edit, so a key being corrected is the same key). Order is the point
  of a keyboard — the key pressed most has to be nearest the thumb.
- **How a terminal is drawn is the device's, not the panel's or the project's**
  (`lib/workspace/terminal-prefs.ts`): type size, whether the key row shows, whether it is
  wrapped open. `keyRow: "auto"` asks the *pointer* — a finger has no Ctrl key — and both
  overrides exist because that guess is wrong in both directions: a tablet with a keyboard
  case, and a desktop reader who defined an escape sequence they cannot otherwise type.
- **What is open inside the IDE is the IDE's state, never the dock's.** The old editor
  descriptor carried a path and a comparison, which is why a file at a second line was a
  second panel and why `reveal.ts` existed to work around it. Now the descriptor is the
  project alone and the tabs are a module store (`lib/ide/editors.ts`): they survive the panel
  being closed and reopened, a reveal is a one-shot field on the tab, and a dirty tab is
  known to the tab bar and to the close confirmation without either asking the editor.
  **The tabs themselves survive a *reload*** (`daedalus.ide.tabs.v1`, per server and then per
  project, every tab re-validated on the way in — `parseBody` drops a shape this build does not
  mean), as does unsaved text, through `lib/workspace/buffers.ts`, which matters because this
  app reloads itself on purpose when a service-worker update is taken. A reveal and a dirty
  flag are never stored: both are rebuilt by the editor re-reading the buffer.
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
- **(Removed: the Review half.)** The Source Control panel no longer reviews turns; the text below is history. It was not source control narrowed
  to a filter: the old `ScmView` + `lib/ide/scm-filter.ts` pair could only show what was still
  uncommitted, and both are gone (see "Why not source control any more" below).
  **Whether the "N files changed" chip is drawn at all is the transcript's one contribution to a measurement that is
  otherwise entirely git's.** The snapshots bracket a *window*, and everything landing in that
  window is attributed to whichever turn was open — a second thread on the same cwd, the
  user's own editor, a dev server writing something that is not gitignored. The recorded row
  keeps all of it (it is what a rewind reads), but the chip asks
  `turnCouldTouchFiles` first: did the turn run one tool whose ACP `kind` is not `read`,
  `search`, `fetch`, `think` or `switch_mode` (`couldTouchFiles` in `lib/tools/naming.ts`)? A
  turn that only searched the web cannot have written a file, and used to be handed the
  neighbouring thread's seventy. The predicate is a **read-only allowlist**, not a writer
  list: `execute` counts because a shell can `sed`, `other` counts because it is the protocol
  declining to say (Claude Code files every MCP tool there), and a verb nobody has seen counts
  — a chip drawn over someone else's diff is a smaller lie than one that hides real work.
  Subagent rows count too: they carry a `parentId`, but a child's Edit is the parent turn's
  change. Nothing here spells a vendor tool name — a new runtime's writer is free as long as
  it declares a kind.
  The scope's own reads — `GET /api/sessions/:id/changes/files|file`, the turn's two trees
  compared directly — are what the inspector's Changes timeline reads (below); `patch` is
  still served and called by nothing.
- **The editor wears the app's palette, and the conversion is the browser's.** Monaco's theme
  format takes a hex string per key; the app's palette is `oklch()` and `color-mix()`. So each
  token is resolved by painting it into a 1×1 canvas and reading the pixel back — the one
  thing that understands every CSS colour syntax there is — with a sentinel test around it,
  because `fillStyle` silently keeps its previous value for a colour it cannot parse. The
  syntax hues are `--code-*` in `index.css`, the same values the transcript's fenced code
  uses, so a file and a diff of that file read as the same language. Both themes are rebuilt
  on every theme change (`syncMonacoTheme`), which is what makes a *custom palette* move the
  editor and not just light↔dark.
- **Nothing of the IDE is left on the server**: the code-server spawn, its `/ide/<key>/`
  proxy and `reverse-proxy.ts` were removed with the client's editor. The output and agents panels remain gone for
  the reasons they went: both were second copies of something already drawn where the work
  is.

- **A project has a page of its own (`/projects/<id>`), and it is assembled from two
  halves on purpose.** Until it did, a project was a row in settings (a form), a folder in
  the sidebar (a list) and a name in a thread's header — three surfaces that each say a
  *part* of what a workspace is and none that answers "what is this project, and what has
  happened in it". `components/project-page.tsx` is that answer: the header (mark, name,
  the cwd as a copy button, description, Edit / New thread), four tiles, a 30-day activity
  strip, the project's threads, and the rails beside them (what it is worked on with, what
  is scheduled against it, what it has accumulated). **The header carries a "Run" dropdown**:
  the user's custom **helper commands** (`project_helpers`, `lib/workspace/project-helpers.ts`),
  repeated as one-tap chips in the page's Quick actions strip and edited in Settings ›
  Projects. Beyond a name and a shell line a helper carries **where and how it runs** — a
  project-relative `cwd`, extra `env` (typed `KEY=value` per line, stored as JSON), a
  `description`, and `confirm`. **A helper's `cwd` is resolved inside the project or not at
  all** (`containedPath`): an absolute path, a `..` that climbs out and a symlink pointing
  away all fall back to the project's own cwd. It is clamped at the *spawn* rather than only
  at the form, and it *clamps* rather than throwing the way `resolveInProject` does, because
  the path comes off a stored row — which can arrive from an imported bundle — and not off a
  request.
- **A helper runs in a terminal panel, and that is the whole feature**
  (`openHelperTerminal`, `lib/workspace/use-run-helper.ts`,
  `POST /api/projects/:id/helpers/:helperId/terminal`). It used to be a one-shot `spawn`
  whose captured output was posted back into a dialog, which meant every helper that *asked*
  something — pick an environment, a password, `[y/N]` — hung against a stdin that was never
  coming and then died at the two-minute timeout with the question as its last line. A PTY is
  the thing that can be answered and the terminal panel is where the harness already knows
  how to draw one, so a helper is now a terminal that starts with its command typed in — and
  inherits the scrollback, the search, the key row and the detach/reattach for free. **There
  is no run dialog and no run timeout**: the terminal's own detach grace and idle sweep bound
  it, and a countdown that kills a program *while it waits for the user's answer* is a bug,
  not a setting. **The command, the directory and the environment are read from the row on
  the server**, never sent up — a helper the browser could define on the way out is an
  arbitrary-exec route wearing a helper's name. **A `confirm` helper asks before the terminal
  exists**, through the app's own confirm dialog, because a PTY starts the instant it is
  created and there is no later moment to ask in; the mark that says so is drawn on both the
  menu row and the chip. **The project page has no dock**, so its helpers *queue* the panel
  (`pending-panels.ts`) and then navigate to a thread, the same trade `openRules` makes.
  A terminal's `title` is the name it was created under (a helper's) or null for a plain
  shell, which the panel keeps titling after its project. The **live** half is the store's —
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

## Automations pages

`/automations` is one place for what used to be two (routines, which start a thread per
fire, and scheduled messages, which speak into a thread that exists). The server's model is
the routine row with `runsIn: "thread" | "session"`; the UI says **automation** everywhere
and the types in `lib/settings.ts` keep the server's `Routine*` names. `/routines*` and
`/schedules*` are redirects (`LegacyRedirect` in `routes.tsx`; `/schedules/new?session=ID`
lands on `/automations/new?session=ID`). The page is drawn the way the project page is: a
`SurfaceHeader`, `StatStrip`, then the list; **every scrolling page route sits in its
`PageFrame`**. The sidebar has **one fixed row** (Automations, carrying the count of
enabled ones), the landing chips and the palette name the same noun. Code is
`components/automations/` (`page.tsx` reads the path and picks a face), one query file
(`lib/queries/automations.ts`, keys `automationsKey` / `automationRunsKey` /
`automationTriggersKey`), and the schedule model in `lib/automation-schedule.ts`.

- **The list reads two extra things per automation** — the newest run and the triggers —
  through `useAutomationReads` (`useQueries`, on the visit, never on a timer), so a row can
  say how it fires, when it fires next and what happened last, and the tiles can count
  across all of them. Mutations invalidate `automationRunsFamilyKey`/`automationTriggersKey`,
  never one limit's key. Filters are the `DataTable`'s: State (Active / Paused / Needs you —
  last run blocked or failed) and Project. A row's switch pauses; a row action is Run now.
- **Runs in is the first decision.** `New thread` mints a thread per fire; `This thread`
  delivers into `sessionId` and derives project, agent and permissions from it — so for
  `This thread` the Where, Agent and Access sections are not drawn at all, rather than drawn
  and ignored. It cannot be switched on an existing automation.
- **New is a template gallery first** (`ChoiceTiles`, `templates.ts` — plain data), then the
  form prefilled; Blank is one tile. A template never saves anything. The gallery is
  skipped when the caller already knows: a `?session=` (the composer's `/automate`, the
  thread footer) opens the form pinned to that thread, and the text typed into the composer
  rides in the route state. `/automate` replaces `/schedule`; `actions.createSchedule` now
  creates a session-mode routine (materialising a draft thread first) and the caller writes
  its triggers.
- **When is a preset, never a second representation.** `lib/automation-schedule.ts` compiles
  Manual / Every N min-hours / Hourly / Daily / Weekdays / Weekly / Monthly / Once / Custom
  into a cron (+ tz), `intervalMs` or `atMs`, and `readPlan` reads a stored trigger back
  (anything matching no preset reads as Custom). `SchedulePicker` prints the sentence
  ("Weekdays at 09:07 Cairo time") and the next three fire times (`croner`, the server's
  own library, minus the stagger) and nudges an on-the-hour time to :07 with a button.
  On create the plan becomes trigger rows right after the automation; on an existing one
  the Triggers tab edits them, and the form says so.
- **The detail page is one URL with five tabs** (`?tab=overview|runs|triggers|access|settings`).
  Runs include the skipped ones with `skipReason` in words (`status.ts` `SKIP_REASON`).
  Access lists what is *always allowed*, revocable per row, and warns on a blanket allow;
  the full per-kind editor is Settings' Access section. `problemOf` is the one validator and
  names a section; the Settings tab and the create page are the same `AutomationForm`.
- **The thread footer reads its automations** (`composer/automations-indicator.tsx`, a
  24px trigger over a popover in the end cluster, draws nothing at zero) — those with
  `runsIn: "session"` and this `sessionId`, each linking to its page, plus Add and Manage.
- **Deferred:** the "also archive its threads?" question on delete (the DELETE route takes
  no such option yet), the inbox's `run` rows and unread badge (phase 4), and a `needs-you`
  run status (the server's statuses are still five).

## The thread inspector and the agents dashboard

- **Wide, the readings are panels of the thread dock; the column below is the phone's sheet.**
  A chat tab on a wide screen is `workspace/thread-dock.tsx`, a nested dockview: the
  transcript (`ThreadView docked`, which draws no inspector of its own, and wears no strip —
  `syncStrips` hides the header of a group holding only it) and, from the + floating over it
  only, Changes/Plan/Agents/Details/Tokens (`ThreadSection`), Terminal, Preview and Tasks — each at
  its kind's own place (`SLOT`: readings a column at the right edge, preview and board beside
  the transcript, a shell below it; later ones join that group as tabs). The panes are flush,
  meeting at hairlines, and their strips are title bars with an underlined tab
  (`.dock-nested`), so a pane never reads as another thread. A hidden chat tab is
  `display: none` (`ChatPanel`): the inner dock's `always` overlays escape the outer's
  `visibility`, and every thread drew over the others. It opens as the transcript alone; the arrangement is kept per thread on the device
  (`lib/workspace/thread-docks.ts`, capped at 100). **Why nested again, when the group panel was
  removed** (see the tab-groups section): that group was general-purpose, so the outer dock had
  to see into it. A thread dock is closed — dockview refuses a drop from another instance unless
  `onUnhandledDragOver` accepts it, and nothing does — so no outer code asks about an inner
  panel. Its tab is its own (`ThreadTab`, the `.dock-tab` material, no outer menu), and it hands
  its panels a `DockContext` whose `openPanel`/`closePanel`/`registerCloseGuard` act on the inner
  instance, so `TerminalPanel` and `WebPanel` needed no change. The Agents panel jumps the
  transcript through `ThreadJumpContext`, which the transcript publishes (`PublishJump`) because
  the scroller's hook answers only inside `ThreadView`. A thread's shell is created with the
  thread's worktree as `cwd` and its `sessionId`, carried on the descriptor so a restart stays
  the thread's, and the server kills it when the thread is trashed or purged.
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
  `layout-options`). **The sheet's open state is not stored**: it is `ThreadView`'s own state,
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
- **Three ACP v1.29 readings, each gated on a feature name and drawn with the kit.**
  Settings › Agents (`settings/agents.tsx`) draws `AgentStatus.auth` — the agent's own
  `auth/status` answer (`AgentAuthReading` in `lib/settings.ts`) — as a `StatusBadge` beside the
  measured Installed/version badge under `useFeature("agentAuthStatus")`: `authenticated` →
  "Logged in", `unauthenticated` → warn "Not logged in", `not_required` → "No login needed",
  `unknown` → "Login state unknown", the accounts in its title and as an "Account(s)" row of the
  expanded detail; with no protocol reading the old CLI-derived `authenticated === false` warn
  badge still draws, so the two never stand side by side. The Import dialog
  (`import-threads.tsx`, `lib/import-sessions.ts`) has an "Include archived sessions" `Switch`
  under the pair row behind `useFeature("sessionArchive")` — it sends `archived: "include"`,
  survives `reset()` like the filters and re-scans a list already on screen; a row with
  `archived === true` wears a neutral "Archived" badge, and when the listing says
  `archive: false` the count line says the agent cannot tell archived sessions apart. The
  subagent row (`SubagentStep`, `useSubagentPlace`) and the `/graph` worker node say `in <dir>`
  from `subagent_update.cwd` (`useFeature("subagentCwd")`), relative to the project's cwd through
  the pure `lib/thread/subagent-cwd.ts` `relativeCwd` (`.` for the root, absolute when outside;
  an isolated thread's worktree reads as its `.daedalus/worktrees/<id>/…` path). The reducer
  patches `cwd`/`additionalDirectories` onto the `SubagentItem` (omitted = keep, `null` =
  cleared); `additionalDirectories` is stored and not yet drawn.
