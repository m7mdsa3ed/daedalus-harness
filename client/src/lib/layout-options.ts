/* ── Layout options ──
    How the app is *displayed* — not what it contains, and not anything the
    agent needs to know. Two scopes share the one store: the transcript's, and
    the interface's (the sidebar and the dock's tabs; which key is whose is
    `layout-settings.tsx`'s groups, not a prefix). They were three
    stores (this one, `ui.sidebarLayout`, `ui.sidebarView`) and the sidebar's
    sort and filter were the only reading preference that could not be searched,
    reset or found next to its siblings. The storage key is still
    `ui.viewOptions`, so nobody's saved switches are lost to a rename.
    Whether the sidebar is *open* is not an option but a state, and stays in
    `sidebar-layout.ts`: a toggle must not re-render every transcript row.

    The transcript half: how a transcript is displayed. Local to this device and **global**: one set of reading
    settings for every thread, persisted in localStorage, so a switch you flip
    once is how you read from then on. They were per-session once, which meant
    the same switch had to be found and flipped again in every thread — reading
    preferences are a property of the reader, not of the conversation.

    Adding an option:
      1. add the field to `LayoutOptions` and a value to `LAYOUT_DEFAULTS` — the
         interface is what types `layout-settings.tsx`, so a typo is a build
         error rather than a switch that does nothing. A choice of more than two
         also lists its values in `CHOICES`, which is what `pick` validates by;
      2. add an item to the right group in `GROUPS` in `layout-settings.tsx`
         (declarative — the page renders itself; a group's `scope` says which
         tab of Settings › Appearance draws it). A switch and a choice are the
         same kind of item, in one ordered list, and an option that only
         modifies another goes in that one's `children` — dimmed under a switch
         that is off. Which group is the design decision (the file's header
         lists them, one question each); an option that fits none of them is
         probably not a layout option;
      3. read it where the transcript renders, through `LayoutOptionsContext`
         (`useLayoutOptionsContext`), not by threading props. Deep components —
         diffs, tool panes — are the reason the context exists.

    Step 3 has one trap, and it has caught two of these already. Read the value
    during **render**. An option handed to a `useState` initialiser is read once
    and every later change is silently discarded, so the switch appears dead on
    everything already on screen and works only on rows that mount afterwards —
    which reads as "sometimes". If an option must seed component state, the
    component has to re-sync when the option itself changes; `StepRow`'s
    `openSetting` prop in `thread-items/rows.tsx` is the worked example, including
    why it watches the option rather than the derived value.

    CSS-only options are the cheap path and don't have that problem: set a data
    attribute on the transcript column (`data-density`, `data-wrap` on
    MessageScrollerContent) and write the rule in index.css. */
import { createContext, useContext, useSyncExternalStore } from "react"

import { createLocalStore } from "./local-store"
import { isStreamSpeed, type StreamSpeed } from "./stream-pace"
import { isBatchBurst, isGapMin, type BatchBurst, type GapMin } from "./tool-batches"
import type { StreamEffect } from "./stream-words"

/** When a folded subagent shows its latest steps under its row. A mode, not a
    count: the count is the tool run's own peek (`PEEK`), so a worker and a run
    read alike, and the question the reader actually has is *when* — a finished
    worker's line and report are its reading, the way a finished run's
    counting line is. */
export const SUBAGENT_PEEKS = ["off", "live", "always"] as const
export type SubagentPeek = (typeof SUBAGENT_PEEKS)[number]

export function isSubagentPeek(value: unknown): value is SubagentPeek {
  return SUBAGENT_PEEKS.some((peek) => peek === value)
}

export const TOOL_LAYOUTS = ["timeline", "rail", "branch"] as const
export type ToolLayout = (typeof TOOL_LAYOUTS)[number]

/** Each layout's variants, the first being its own default. One stored
    `toolVariant` serves every layout, so switching layout keeps the pick and
    `toolVariantOf` falls back to the new layout's first when it names none. */
export const TOOL_VARIANTS = {
  timeline: ["default", "compact", "minimal"],
  rail: ["default"],
  branch: ["commits", "fork", "hollow"],
} as const satisfies Record<ToolLayout, readonly string[]>
export type ToolVariant = (typeof TOOL_VARIANTS)[ToolLayout][number]

const ALL_TOOL_VARIANTS: readonly string[] = Object.values(TOOL_VARIANTS).flat()

export function isToolVariant(value: unknown): value is ToolVariant {
  return ALL_TOOL_VARIANTS.includes(value as string)
}

export function toolVariantOf(layout: ToolLayout, variant: ToolVariant): ToolVariant {
  const own: readonly string[] = TOOL_VARIANTS[layout]
  return own.includes(variant) ? variant : TOOL_VARIANTS[layout][0]
}

export function isToolLayout(value: unknown): value is ToolLayout {
  return TOOL_LAYOUTS.some((layout) => layout === value)
}

/* ── How a parallel group is drawn ──
   `toolLayout` decides how a *step* is drawn; this decides how the calls one
   response sent together are bracketed, which is a different question and was
   the one with an answer hard-coded into the row. Three, and they are genuinely
   different readings rather than three shades of one:
     `wash`    — the group is a marked stretch: a tinted, ringed box bleeding
                 past its rows, the calls on their rail under one counting line.
     `card`    — the group is a card: a titled box, its calls a plain list under
                 a hairline. For a reader who wants the set to look like a thing
                 rather than a highlighted passage.
     `columns` — the group is a grid: the calls stand side by side, because they
                 *ran* side by side. The one shape that says what "parallel"
                 meant, and the one that folds two calls into half the height.
     `bracket` — no box: a thin rule down the start edge spans the header and its
                 calls. The quietest way to say "these belong together".
     `ledger`  — hairlines above and below, one between every call, no tint: the
                 group read as a table of calls.
     `tiles`   — every call a small card of its own under the header, so each can
                 be told apart at a glance.
   The chrome for each lives in `thread-items/group-style.tsx`, so the row reads
   a treatment instead of spelling `bg-… ring-…` inline. */
export const GROUP_STYLES = ["wash", "card", "columns", "bracket", "ledger", "tiles"] as const
export type GroupStyle = (typeof GROUP_STYLES)[number]

export function isGroupStyle(value: unknown): value is GroupStyle {
  return GROUP_STYLES.some((style) => style === value)
}

/** The sidebar's arrangement, and how its list is read. Each tuple's first
    entry is its default; `CHOICES` is what stored values are checked against. */
export const SIDEBAR_VARIANTS = ["sidebar", "inset"] as const
export type SidebarVariant = (typeof SIDEBAR_VARIANTS)[number]
export const SIDEBAR_SORTS = ["recent", "created", "title", "project"] as const
export type SidebarSort = (typeof SIDEBAR_SORTS)[number]
/* `hidden` is deliberately not one of these: hiding a thread is not a way to
   read the list, it is a thing the list can be told to stop doing.
   `sidebarShowHidden` is that switch, and it adds the Hidden group under the
   list rather than swapping the list for it. */
export const SIDEBAR_FILTERS = ["all", "running", "waiting", "unread", "trash"] as const
export type SidebarFilter = (typeof SIDEBAR_FILTERS)[number]
/** Only threads with a turn inside the window. "Any" is no filter. */
export const SIDEBAR_WITHIN = ["any", "day", "week", "month"] as const
export type SidebarWithin = (typeof SIDEBAR_WITHIN)[number]
/** Which of a thread's sub threads (asks, workflow steps) are drawn under it.
    `active` keeps the ones that are running, waiting on you or failed — and the
    one you are looking at — so a finished fan-out stops taking rows. */
export const SIDEBAR_SUBS = ["all", "active", "off"] as const
export type SidebarSubs = (typeof SIDEBAR_SUBS)[number]
export const WITHIN_MS: Record<Exclude<SidebarWithin, "any">, number> = {
  day: 864e5,
  week: 7 * 864e5,
  month: 30 * 864e5,
}

/* ── How much of a long thread is loaded ──
   A thread opens with its tail and pages the rest back one page at a time
   (`load_earlier`). Both sizes were constants — ten turns at attach, twenty
   per page — and both are reading preferences: an archive being skimmed wants
   a long window and big pages, a phone on a slow line wants neither. They are
   options of the *reader*, not of a thread, so they live here beside density
   and streaming speed and follow the device.

   Values are strings because a stored choice is validated against `CHOICES`;
   `replayWindowSteps` and `earlierPageSteps` turn them back into the counts the
   socket sends. `all` is the absence of a window rather than a very large
   number — the server is asked for no window at all, which is how a log comes
   back whole. */
export const HISTORY_WINDOWS = ["5", "10", "20", "50", "all"] as const
export type HistoryWindow = (typeof HISTORY_WINDOWS)[number]

export const EARLIER_PAGES = ["10", "20", "50", "100"] as const
export type EarlierPageSize = (typeof EARLIER_PAGES)[number]

export interface LayoutOptions {
  /** Wall-clock time beside each message and step. */
  showTimestamps: boolean
  /** Fold runs of consecutive tool calls into one expandable block
   *  (`groupToolRuns`). Prose and a thought end a run and are drawn where they
   *  arrived: a fold counts calls, and reasoning folded behind a line that never
   *  mentions it is reasoning the reader cannot see. */
  groupTools: boolean
  /** Keep the group the agent is still working in open. Off, it folds like a
   *  finished one and peeks its last few steps under the counting line. */
  openRunningGroup: boolean
  /** Fold the calls one model response sent together — the ones that ran side
   *  by side — into a marked group of their own inside the run, its mixed kinds
   *  folded by kind inside it (`groupToolRuns`). Off, the calls are plain rows
   *  of the run and nothing marks them. */
  parallelGroups: boolean
  /** How a group of parallel calls is bracketed (`GROUP_STYLES`): a marked
   *  wash, a card with a hairline list, or the calls side by side in columns.
   *  Off `parallelGroups`, there is no group to draw and this says nothing. */
  groupStyle: GroupStyle
  /** Fold a run of consecutive `!` commands into one line you can open. */
  groupShellCommands: boolean
  /** Open every `!` command's output by default. Off, the row folds like a
   *  Bash step and a click opens it. */
  expandShellCommands: boolean
  /** The `!` commands you ran, and what they printed. Off, the rows are hidden —
      the command still ran and the journal still holds it, only the row is
      silent. This is the switch `answersOnly` deliberately does not cover: a
      `!` line is the reader's own act, not the agent's work. */
  showShellCommands: boolean
  /** After a thread's first message, fold the composer to its one-line mini
   *  form, with the toggle that opens the advanced one. Off — the default — a
   *  started thread keeps the full box: no mini form, and nothing that folds
   *  it. The reverse of the switch it replaces, which was not a choice. */
  miniComposer: boolean
  /** Tighter vertical rhythm in the transcript. */
  compactDensity: boolean
  /** Pin to the newest content while the agent is streaming. */
  autoScroll: boolean
  /** Open a reasoning row while it streams. It folds once the step finishes;
   *  off, a thought stays on its title line while it streams. */
  showThinking: boolean
  /** Draw a thought the way a tool call is drawn — its own mark, "Thought for
   *  12s" as the title, the reasoning one click behind it — instead of the
   *  muted block that stands in the transcript. Off, thinking keeps that block:
   *  its duration over three lines of excerpt. */
  thoughtStep: boolean
  /** Soft-wrap long code and diff lines instead of scrolling. */
  codeWrap: boolean
  /** Wider transcript column. */
  wideTranscript: boolean
  /** Expand every tool call's input/output by default. */
  showToolDetails: boolean
  /** Open edit diffs by default. Off, edits can join grouped tool runs. */
  expandEdits: boolean
  /** When a folded subagent shows its latest steps without being opened. */
  subagentPeek: SubagentPeek
  /** The command, path or pattern under a tool row's description. Off, a step
   *  row says what the call *did* and leaves what it typed to the body. */
  showToolCommand: boolean
  /** The call as the agent sent it — input, output, content, `_meta` — as a
   *  JSON tree at the foot of every tool step's body. For checking what a
   *  runtime actually said, not for reading the work. */
  showRawToolData: boolean
  /** The visual arrangement of tool-call rows in the transcript. */
  toolLayout: ToolLayout
  /** The layout's variant (`TOOL_VARIANTS`); read through `toolVariantOf`. */
  toolVariant: ToolVariant
  /** How close together calls with no step id must start to count as one
   *  parallel batch (`lib/tool-batches.ts`). A runtime that sends the id is
   *  never read by this. */
  batchBurst: BatchBurst
  /** The shortest wait between two batches of calls worth drawing; Off draws
   *  none. */
  gapMin: GapMin
  /** Render file diffs side by side instead of unified. */
  splitDiffs: boolean
  /** Hide the workspace tab strips without closing panels or changing the saved layout. */
  hideWorkspaceTabs: boolean
  /** The second row of every dock tab (project and model, a page's section,
      a shell's directory). Off, the tab is one line and shorter. */
  showTabDetails: boolean
  /** Each tab's own mark at its leading edge (`PanelIcon`): a thread's agent —
   *  the same mark its sidebar row wears — a page's section, a terminal's kind.
   *  Off, a tab starts at its title. The key keeps its old name so a stored
   *  choice survives. */
  tabAgentIcon: boolean
  /** Hairline rule above each user turn. */
  stepDividers: boolean
  /** Tick marks across the top of the composer, one per user turn, to jump between them. */
  turnRail: boolean
  /** Favicon strips: the pages a step saw and the ones the answer cited. */
  showSources: boolean
  /** Place grouped-tool and web-source strips on their heading row. */
  showToolSourcesOnFirstRow: boolean
  /** The setting-change rows (`Mode: Plan → Build`) — mode, model, effort,
      profile, agent, follow-ups, wherever in the thread they were
      changed. Off, a change still takes effect: the row is silent, not the
      switch. This switch is what makes reporting *every* change safe, and it
      is why the server no longer picks which ones are worth mentioning. */
  showConfigNotices: boolean
  /** The sentence under the thread's status line — what a wait, a stop or a
   *  failure means, and the line a long wait adds. Off, a status is its title
   *  alone: the buttons stay (a Retry is a door, not a description), and Copy
   *  still takes the whole report, which is why this can be off by default
   *  without losing the words. */
  showStatusDetail: boolean
  /** What each turn, workflow step and subagent spent, in tokens. */
  showTokens: boolean
  /** Drop the row entrance animation and the running-turn shimmer. */
  calmMotion: boolean
  /** The busy ring a steering message wears while it waits for the step
   *  boundary: one primary arc (off) or a gradient of the chart colours (on).
   *  Queued rows keep the primary arc either way. */
  steerRingGradient: boolean
  /** How fast a live turn's prose is revealed (lib/stream-pace) — the other
   *  half of the reveal, and the half that used to be a constant. Deliberately
   *  *not* folded into calm motion: pacing is when a word appears, not whether
   *  something animates, and a reader who wants nothing moving on its own may
   *  still want to read along rather than be handed a paragraph at once.
   *  `instant` is how they ask for the paragraph. */
  streamSpeed: StreamSpeed
  /** Fold the work into a line you can open: whatever the agent did between
   *  two things said — thinking, tool steps, plans, subagents, compactions —
   *  collected into one collapsed row, so the transcript reads as the
   *  conversation. Errors stay out of the fold, since a failure hidden reads as
   *  an answer that never came, as do your own `!` commands. Nothing is
   *  dropped: open the line and the whole transcript is there, every fold it
   *  already had intact. */
  answersOnly: boolean
  /** Turns that arrive when a thread opens; anything older waits behind the
   *  "Load earlier steps" button. `all` reads the whole log at once. Read at
   *  attach through `replayWindowSteps`, so a change lands on the next thread
   *  or reload rather than rebuilding what is open. */
  historyWindow: HistoryWindow
  /** Turns one press of that button brings (`earlierPageSteps`). Read at the
   *  click, so a change lands on the next page. */
  earlierPage: EarlierPageSize

  /* ── Sidebar ── every key here begins `sidebar` (`isSidebarOption`). */
  /** `sidebar` is a flush rail beside the content; `inset` floats the content
      as a rounded card on the shell's ground. */
  sidebarVariant: SidebarVariant
  /** How the thread list is ordered. `project` is the one that changes shape:
      a folder per project instead of one flat list. */
  sidebarSort: SidebarSort
  /** Which threads the list shows, by what they are doing. */
  sidebarFilter: SidebarFilter
  /** Keep hidden threads out of every list. On, they are still out of the
      ordinary list — that is what hiding *is* — but a Hidden group sits under
      it, which is the only place they can be read and unhidden again. Off, the
      group is not drawn at all. */
  sidebarShowHidden: boolean
  /** Which threads the list shows, by how recently they spoke. */
  sidebarWithin: SidebarWithin
  /** Shorter rows, so more threads fit. */
  sidebarCompact: boolean
  /** Which sub threads are listed under their parent. */
  sidebarSubThreads: SidebarSubs
  /** The agent's mark on a sub thread's row. */
  sidebarSubAgentIcon: boolean
  /** How long ago a sub thread last spoke, at its row's end. */
  sidebarSubAge: boolean
  /** The agent's mark at the start of each thread row. */
  sidebarAgentIcon: boolean
  /** How long ago the thread last spoke, at the row's end. */
  sidebarShowAge: boolean
  /** The project's name on each row of a flat list (always one hover away). */
  sidebarShowProject: boolean
  /** Today / Yesterday / … headings between runs of rows. */
  sidebarPeriodHeadings: boolean
  /** The Pinned group above the list. Off, a pinned thread is just a thread. */
  sidebarShowPinned: boolean
  /** The Tasks / Automations rows under New tab. */
  sidebarShowPlaces: boolean
  /** In the by-project view, folders with no thread in them. */
  sidebarEmptyProjects: boolean
}

export const LAYOUT_DEFAULTS: LayoutOptions = {
  showTimestamps: true,
  groupTools: false,
  openRunningGroup: true,
  parallelGroups: true,
  groupStyle: "wash",
  groupShellCommands: false,
  expandShellCommands: false,
  showShellCommands: true,
  miniComposer: false,
  compactDensity: false,
  autoScroll: true,
  showThinking: true,
  thoughtStep: true,
  codeWrap: false,
  wideTranscript: false,
  showToolDetails: false,
  expandEdits: false,
  subagentPeek: "live",
  showToolCommand: true,
  showRawToolData: false,
  toolLayout: "timeline",
  toolVariant: "default",
  batchBurst: "250ms",
  gapMin: "1s",
  splitDiffs: false,
  stepDividers: false,
  hideWorkspaceTabs: false,
  showTabDetails: true,
  tabAgentIcon: true,
  turnRail: true,
  showSources: true,
  showToolSourcesOnFirstRow: false,
  showConfigNotices: true,
  showStatusDetail: false,
  showTokens: false,
  calmMotion: false,
  steerRingGradient: false,
  answersOnly: false,
  historyWindow: "10",
  earlierPage: "20",
  streamSpeed: "natural",
  sidebarVariant: "sidebar",
  sidebarSort: "recent",
  sidebarFilter: "all",
  sidebarShowHidden: true,
  sidebarWithin: "any",
  sidebarCompact: false,
  sidebarSubThreads: "all",
  sidebarSubAgentIcon: true,
  sidebarSubAge: true,
  sidebarAgentIcon: true,
  sidebarShowAge: true,
  sidebarShowProject: false,
  sidebarPeriodHeadings: true,
  sidebarShowPinned: true,
  sidebarShowPlaces: true,
  sidebarEmptyProjects: true,
}

/** What the transcript should actually draw: the sweep, the one reveal there
 *  is (lib/stream-words), unless calm motion has stopped the transcript moving
 *  on its own. Read this anywhere the reveal is rendered. */
export function resolveStreamEffect(options: LayoutOptions): StreamEffect {
  return options.calmMotion ? "none" : "sweep"
}

/** Carries the resolved options to the items that render the transcript, so the
 *  deep tool/diff/thought components can read them without prop drilling. */
export const LayoutOptionsContext = createContext<LayoutOptions>(LAYOUT_DEFAULTS)

export function useLayoutOptionsContext(): LayoutOptions {
  return useContext(LayoutOptionsContext)
}

const STORAGE_KEY = "ui.viewOptions"

const KEYS = Object.keys(LAYOUT_DEFAULTS) as (keyof LayoutOptions)[]

/** The values a plain choice may hold; anything else in storage is dropped. */
const CHOICES: Partial<Record<keyof LayoutOptions, readonly string[]>> = {
  sidebarVariant: SIDEBAR_VARIANTS,
  sidebarSort: SIDEBAR_SORTS,
  sidebarFilter: SIDEBAR_FILTERS,
  sidebarWithin: SIDEBAR_WITHIN,
  sidebarSubThreads: SIDEBAR_SUBS,
  historyWindow: HISTORY_WINDOWS,
  earlierPage: EARLIER_PAGES,
}

/** Keep only known fields *of the right shape*: the stored blob is
 *  user-editable and outlives any one release, so neither an option this build
 *  has never heard of nor a value it cannot mean may reach the resolved object.
 *  The default is what says which shape a key is, so a new switch needs nothing
 *  here and a new choice needs only its own guard. */
function pick(raw: unknown): Partial<LayoutOptions> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of KEYS) {
    const value = source[key]
    if (key === "thoughtStep") {
      /* "Thinking as one line" was this switch's ancestor and is gone. Its two
         positions are the two shapes this one picks between — a label alone
         (a step) and the excerpt block — so a stored pick carries over as it
         stands. Read only when this key itself is absent, and only for a
         reader who had made that pick: nothing is written for a default. */
      if (typeof value === "boolean") out[key] = value
      else if (typeof source.thoughtOneLine === "boolean") out[key] = source.thoughtOneLine
    } else if (typeof LAYOUT_DEFAULTS[key] === "boolean") {
      if (typeof value === "boolean") out[key] = value
    } else if (key === "subagentPeek") {
      /* The older count only reached storage when the reader moved it off
         its default, so a stored count is a choice: zero was "off", and any
         other number showed the steps whether or not the worker still ran. */
      const legacy = source.recentSubagentSteps ?? source.showRecentSubagentSteps
      if (isSubagentPeek(value)) out[key] = value
      else if (legacy === 0 || legacy === false) out[key] = "off"
      else if (typeof legacy === "number" || legacy === true) out[key] = "always"
    } else if (key === "toolLayout") {
      if (isToolLayout(value)) out[key] = value
      /* "compact" and "minimal" were layouts of their own before they became
         timeline variants; the other retired ones fall back to the default. */
      else if (value === "compact" || value === "minimal") {
        out[key] = "timeline"
        if (!isToolVariant(source.toolVariant)) out.toolVariant = value
      }
    } else if (key === "toolVariant") {
      if (isToolVariant(value)) out[key] = value
    } else if (key === "groupStyle") {
      if (isGroupStyle(value)) out[key] = value
    } else if (key === "streamSpeed") {
      if (isStreamSpeed(value)) out[key] = value
    } else if (key === "batchBurst") {
      if (isBatchBurst(value)) out[key] = value
    } else if (key === "gapMin") {
      if (isGapMin(value)) out[key] = value
    } else if (key === "sidebarFilter") {
      /* "hidden" was a position of this choice — one that swapped the whole
         list for the hidden threads. It is a switch now, so a reader parked on
         it was reading exactly what the switch adds: carry the pick over to
         the group and open the list behind it. Read only when the switch
         itself is absent, so a later pick of either wins. */
      if (value === "hidden") {
        out[key] = "all"
        if (typeof source.sidebarShowHidden !== "boolean") out.sidebarShowHidden = true
      } else if (CHOICES[key]?.includes(value as string)) out[key] = value
    } else if (CHOICES[key]?.includes(value as string)) {
      out[key] = value
    }
  }
  return out as Partial<LayoutOptions>
}

function parseStored(raw: unknown): Partial<LayoutOptions> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const entries = Object.values(raw as Record<string, unknown>)
  /* Pre-global shape: `{ [sessionId]: Partial<LayoutOptions> }`. Fold every
     thread's picks into the one set rather than dropping them — later keys
     win — so upgrading keeps the switches the reader had chosen instead of
     silently resetting them. Written back on the first commit. */
  if (entries.some((value) => value && typeof value === "object"))
    return entries.reduce<Partial<LayoutOptions>>(
      (acc, value) => ({ ...acc, ...pick(value) }),
      {}
    )
  return pick(raw)
}

const store = createLocalStore<Partial<LayoutOptions>>(STORAGE_KEY, parseStored, {})

/* The resolved object is memoised against the stored reference so
   useSyncExternalStore's snapshot is referentially stable — returning a fresh
   object each call is an infinite render loop, not a subtle inefficiency. */
let lastStored = store.get()
let resolved: LayoutOptions = { ...LAYOUT_DEFAULTS, ...lastStored }

function resolvedNow(): LayoutOptions {
  const stored = store.get()
  if (stored !== lastStored) {
    lastStored = stored
    resolved = { ...LAYOUT_DEFAULTS, ...stored }
  }
  return resolved
}

export function setLayoutOption<K extends keyof LayoutOptions>(key: K, value: LayoutOptions[K]): void {
  store.set({ ...store.get(), [key]: value })
}

/** Back to the defaults — all of them, or the named keys'. Which keys make a
    page is the page's (`layout-settings.tsx` draws one scope's groups and
    resets what they hold), so the Transcript and Interface tabs each count
    only their own changes without the store knowing a scope exists. It used to
    be a `sidebar` key prefix, which could not put the dock's tab switches on
    the Interface tab. */
export function resetLayoutOptions(keys?: Iterable<keyof LayoutOptions>): void {
  if (!keys) return store.set({})
  const next = { ...store.get() }
  for (const key of keys) delete next[key]
  store.set(next)
}

export function useLayoutOptions(): LayoutOptions {
  return useSyncExternalStore(store.subscribe, resolvedNow, resolvedNow)
}

/** The resolved options outside React. A `ThreadSocket` is opened by an action
    rather than a render — on create, on revive, on an attach — so the window it
    asks for and the page size it pages with are read through this instead of
    being threaded down as props. It is the same memoised snapshot the hook
    returns, so a pick and the socket can never disagree about what was picked. */
export function layoutOptionsNow(): LayoutOptions {
  return resolvedNow()
}

/** The replay window a fresh attach asks for, in turns. `0` is "no window":
    the socket sends no `window` parameter and the whole log comes back, which
    is also how a server too old to window reads it. */
export function replayWindowSteps(options: LayoutOptions = layoutOptionsNow()): number {
  return options.historyWindow === "all" ? 0 : Number(options.historyWindow)
}

/** How many turns one "Load earlier steps" page asks the server for. */
export function earlierPageSteps(options: LayoutOptions = layoutOptionsNow()): number {
  return Number(options.earlierPage)
}

/* ── Sidebar picks made before they lived here ──
   `ui.sidebarLayout` carried `{ open, variant }` and `ui.sidebarView` carried
   `{ sort, filter }`. The variant, sort and filter are folded in once — a pick
   already stored here wins — and taken out of the old keys, so a later Reset
   cannot resurrect them. `open` stays where it was (`sidebar-layout.ts`).
   `index.html` still reads the old key for the first paint of a device that
   has not run this build yet. */
if (typeof localStorage !== "undefined") {
  const read = (key: string): Record<string, unknown> | undefined => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "null") as unknown
      return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  const layout = read("ui.sidebarLayout")
  const view = read("ui.sidebarView")
  const legacy = pick({ sidebarVariant: layout?.variant, sidebarSort: view?.sort, sidebarFilter: view?.filter })
  if (Object.keys(legacy).length) store.set({ ...legacy, ...store.get() })
  try {
    if (layout && "variant" in layout) {
      const { variant: _variant, ...rest } = layout
      localStorage.setItem("ui.sidebarLayout", JSON.stringify(rest))
    }
    localStorage.removeItem("ui.sidebarView")
  } catch {
    // A forgotten migration is not worth throwing at import time.
  }
}
