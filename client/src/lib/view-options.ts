/* ── View options ──
    How a transcript is *displayed* — not what it contains, and not anything the
    agent needs to know. Local to this device and **global**: one set of reading
    settings for every thread, persisted in localStorage, so a switch you flip
    once is how you read from then on. They were per-session once, which meant
    the same switch had to be found and flipped again in every thread — reading
    preferences are a property of the reader, not of the conversation.

    Adding an option:
      1. add the field to `ViewOptions` and a value to `VIEW_DEFAULTS` — the
         interface is what types `session-settings.tsx`, so a typo is a build
         error rather than a switch that does nothing;
      2. add a row to the right group in `GROUPS` in `session-settings.tsx`
         (declarative — the dialog renders itself). Which group is the design
         decision: Layout, Detail, Code and diffs, Motion. An option that fits
         none of them is probably not a view option;
      3. read it where the transcript renders, through `ViewOptionsContext`
         (`useViewOptionsContext`), not by threading props. Deep components —
         diffs, tool panes — are the reason the context exists.

    Step 3 has one trap, and it has caught two of these already. Read the value
    during **render**. An option handed to a `useState` initialiser is read once
    and every later change is silently discarded, so the switch appears dead on
    everything already on screen and works only on rows that mount afterwards —
    which reads as "sometimes". If an option must seed component state, the
    component has to re-sync when the option itself changes; `StepRow`'s
    `openSetting` prop in `thread-items.tsx` is the worked example, including
    why it watches the option rather than the derived value.

    CSS-only options are the cheap path and don't have that problem: set a data
    attribute on the transcript column (`data-density`, `data-wrap` on
    MessageScrollerContent) and write the rule in index.css. */
import { createContext, useContext, useSyncExternalStore } from "react"

import { createLocalStore } from "./local-store"
import { isStreamEffect, type StreamEffect } from "./stream-words"

export interface ViewOptions {
  /** Wall-clock time beside each message and step. */
  showTimestamps: boolean
  /** Fold runs of consecutive tool steps into one expandable block. */
  groupTools: boolean
  /** Tighter vertical rhythm in the transcript. */
  compactDensity: boolean
  /** Pin to the newest content while the agent is streaming. */
  autoScroll: boolean
  /** Render reasoning/expanded by default instead of folded. */
  showThinking: boolean
  /** Soft-wrap long code and diff lines instead of scrolling. */
  codeWrap: boolean
  /** Wider transcript column. */
  wideTranscript: boolean
  /** Expand every tool call's input/output by default. */
  showToolDetails: boolean
  /** The command, path or pattern under a tool row's description. Off, a step
   *  row says what the call *did* and leaves what it typed to the body. */
  showToolCommand: boolean
  /** Render file diffs side by side instead of unified. */
  splitDiffs: boolean
  /** Hairline rule above each user turn. */
  stepDividers: boolean
  /** Tick marks down the right edge, one per user turn, to jump between them. */
  turnRail: boolean
  /** Favicon strips: the pages a step saw and the ones the answer cited. */
  showSources: boolean
  /** What each turn, workflow step and subagent spent, in tokens. */
  showTokens: boolean
  /** Drop the row entrance animation and the running-turn shimmer. */
  calmMotion: boolean
  /** How a live turn's prose resolves as it is written (lib/stream-words). The
   *  one option here that is not a switch — the choice is between shapes, not
   *  between on and off, and "none" is one of the shapes. */
  streamEffect: StreamEffect
  /** Hide the work and keep the conversation: your messages and the agent's
   *  answers, with thinking, tool steps, plans, subagents and compactions left
   *  out. Errors stay — a failure hidden reads as an answer that never came. */
  answersOnly: boolean
}

export const VIEW_DEFAULTS: ViewOptions = {
  showTimestamps: false,
  groupTools: false,
  compactDensity: false,
  autoScroll: true,
  showThinking: false,
  codeWrap: false,
  wideTranscript: false,
  showToolDetails: false,
  showToolCommand: true,
  splitDiffs: false,
  stepDividers: false,
  turnRail: true,
  showSources: true,
  showTokens: false,
  calmMotion: false,
  answersOnly: false,
  streamEffect: "sweep",
}

/* ── Options that answer a question `answersOnly` has already answered ──
   Not *forced* off — the stored value is the reader's and comes back the moment
   the filter does — and not read defensively at the render sites either: with
   no tool, thought or diff row on screen, "expand tool output" and "wrap code"
   are already no-ops, so making them lie about their state would be a second
   source of truth for nothing. What they need is to stop *offering* a choice
   that changes nothing, which is a property of the dialog, so it is stated once
   here and the rows read it. Deliberately not the whole Detail group:
   timestamps, sources and token figures are all still on screen and still say
   something about the turn that is left. */
/* The same argument for calm motion: it is a statement about the transcript not
   moving on its own, and a reveal is the transcript moving on its own. The
   stored choice stays the reader's and comes back when calm motion goes off —
   `resolveStreamEffect` is what makes it moot meanwhile, and the picker says so
   rather than silently doing nothing. */
export const CALM_MOTION_SUPPRESSES: readonly (keyof ViewOptions)[] = ["streamEffect"]

/** What the transcript should actually draw, once calm motion has had its say.
 *  Read this, never `options.streamEffect`, anywhere the reveal is rendered. */
export function resolveStreamEffect(options: ViewOptions): StreamEffect {
  return options.calmMotion ? "none" : options.streamEffect
}

export const ANSWERS_ONLY_SUPPRESSES: readonly (keyof ViewOptions)[] = [
  "showThinking",
  "showToolDetails",
  "showToolCommand",
  "groupTools",
  "codeWrap",
  "splitDiffs",
]

/** Carries the resolved options to the items that render the transcript, so the
 *  deep tool/diff/thought components can read them without prop drilling. */
export const ViewOptionsContext = createContext<ViewOptions>(VIEW_DEFAULTS)

export function useViewOptionsContext(): ViewOptions {
  return useContext(ViewOptionsContext)
}

const STORAGE_KEY = "ui.viewOptions"

const KEYS = Object.keys(VIEW_DEFAULTS) as (keyof ViewOptions)[]

/** Keep only known fields *of the right shape*: the stored blob is
 *  user-editable and outlives any one release, so neither an option this build
 *  has never heard of nor a value it cannot mean may reach the resolved object.
 *  The default is what says which shape a key is, so a new switch needs nothing
 *  here and a new choice needs only its own guard. */
function pick(raw: unknown): Partial<ViewOptions> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of KEYS) {
    const value = source[key]
    if (typeof VIEW_DEFAULTS[key] === "boolean") {
      if (typeof value === "boolean") out[key] = value
    } else if (key === "streamEffect") {
      if (isStreamEffect(value)) out[key] = value
    }
  }
  return out as Partial<ViewOptions>
}

function parseStored(raw: unknown): Partial<ViewOptions> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const entries = Object.values(raw as Record<string, unknown>)
  /* Pre-global shape: `{ [sessionId]: Partial<ViewOptions> }`. Fold every
     thread's picks into the one set rather than dropping them — later keys
     win — so upgrading keeps the switches the reader had chosen instead of
     silently resetting them. Written back on the first commit. */
  if (entries.some((value) => value && typeof value === "object"))
    return entries.reduce<Partial<ViewOptions>>(
      (acc, value) => ({ ...acc, ...pick(value) }),
      {}
    )
  return pick(raw)
}

const store = createLocalStore<Partial<ViewOptions>>(STORAGE_KEY, parseStored, {})

/* The resolved object is memoised against the stored reference so
   useSyncExternalStore's snapshot is referentially stable — returning a fresh
   object each call is an infinite render loop, not a subtle inefficiency. */
let lastStored = store.get()
let resolved: ViewOptions = { ...VIEW_DEFAULTS, ...lastStored }

function resolvedNow(): ViewOptions {
  const stored = store.get()
  if (stored !== lastStored) {
    lastStored = stored
    resolved = { ...VIEW_DEFAULTS, ...stored }
  }
  return resolved
}

export function setViewOption<K extends keyof ViewOptions>(key: K, value: ViewOptions[K]): void {
  store.set({ ...store.get(), [key]: value })
}

export function resetViewOptions(): void {
  store.set({})
}

export function useViewOptions(): ViewOptions {
  return useSyncExternalStore(store.subscribe, resolvedNow, resolvedNow)
}
