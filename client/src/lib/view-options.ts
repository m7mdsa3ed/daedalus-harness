/* ── Per-thread view options ──
    How a transcript is *displayed* — not what it contains, and not anything the
    agent needs to know. Local to this device, per session, so a thread you read
    with timestamps on stays that way without imposing it on the next one or on
    anyone else connected to the same harness.

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

function read(): Record<string, Partial<ViewOptions>> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as unknown
    return raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, Partial<ViewOptions>>)
      : {}
  } catch {
    return {}
  }
}

let cache = read()
const listeners = new Set<() => void>()

/* Resolved objects are memoised per session so useSyncExternalStore's snapshot
   is referentially stable — returning a fresh object each call is an infinite
   render loop, not a subtle inefficiency. */
let resolved = new Map<string, ViewOptions>()

function optionsFor(sessionId: string): ViewOptions {
  const hit = resolved.get(sessionId)
  if (hit) return hit
  const value = { ...VIEW_DEFAULTS, ...cache[sessionId] }
  resolved.set(sessionId, value)
  return value
}

function commit(next: Record<string, Partial<ViewOptions>>) {
  cache = next
  resolved = new Map()
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // A forgotten preference is not worth throwing out of a click handler.
  }
  for (const listener of listeners) listener()
}

export function setViewOption<K extends keyof ViewOptions>(
  sessionId: string,
  key: K,
  value: ViewOptions[K]
): void {
  commit({ ...cache, [sessionId]: { ...cache[sessionId], [key]: value } })
}

export function resetViewOptions(sessionId: string): void {
  const next = { ...cache }
  delete next[sessionId]
  commit(next)
}

/** Drop options for sessions the server no longer lists — as drafts and pins do. */
export function pruneViewOptions(sessionIds: Iterable<string>): void {
  const live = new Set(sessionIds)
  const kept = Object.fromEntries(Object.entries(cache).filter(([id]) => live.has(id)))
  if (Object.keys(kept).length !== Object.keys(cache).length) commit(kept)
}

export function useViewOptions(sessionId: string): ViewOptions {
  const snapshot = () => optionsFor(sessionId)
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
