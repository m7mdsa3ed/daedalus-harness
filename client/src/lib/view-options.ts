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
  /** Render file diffs side by side instead of unified. */
  splitDiffs: boolean
  /** Hairline rule above each user turn. */
  stepDividers: boolean
  /** Tick marks down the right edge, one per user turn, to jump between them. */
  turnRail: boolean
  /** Favicon strips: the pages a step saw and the ones the answer cited. */
  showSources: boolean
  /** Drop the row entrance animation and the running-turn shimmer. */
  calmMotion: boolean
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
  splitDiffs: false,
  stepDividers: false,
  turnRail: true,
  showSources: true,
  calmMotion: false,
}

/** Carries the resolved options to the items that render the transcript, so the
 *  deep tool/diff/thought components can read them without prop drilling. */
export const ViewOptionsContext = createContext<ViewOptions>(VIEW_DEFAULTS)

export function useViewOptionsContext(): ViewOptions {
  return useContext(ViewOptionsContext)
}

const STORAGE_KEY = "ui.viewOptions"

const KEYS = Object.keys(VIEW_DEFAULTS) as (keyof ViewOptions)[]

/** Keep only known boolean fields: the stored blob is user-editable and outlives
 *  any one release, so an option this build has never heard of must not reach
 *  the resolved object. */
function pick(raw: unknown): Partial<ViewOptions> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const out: Partial<ViewOptions> = {}
  for (const key of KEYS) if (typeof source[key] === "boolean") out[key] = source[key] as boolean
  return out
}

function read(): Partial<ViewOptions> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown
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
  } catch {
    return {}
  }
}

const listeners = new Set<() => void>()

/* The resolved object is memoised so useSyncExternalStore's snapshot is
   referentially stable — returning a fresh object each call is an infinite
   render loop, not a subtle inefficiency. */
let stored = read()
let resolved: ViewOptions = { ...VIEW_DEFAULTS, ...stored }

function commit(next: Partial<ViewOptions>) {
  stored = next
  resolved = { ...VIEW_DEFAULTS, ...next }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // A forgotten preference is not worth throwing out of a click handler.
  }
  for (const listener of listeners) listener()
}

export function setViewOption<K extends keyof ViewOptions>(key: K, value: ViewOptions[K]): void {
  commit({ ...stored, [key]: value })
}

export function resetViewOptions(): void {
  commit({})
}

export function useViewOptions(): ViewOptions {
  const snapshot = () => resolved
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot,
    snapshot
  )
}
