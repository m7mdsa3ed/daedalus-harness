/* ── How the IDE is read ──
   Device-local, global, and deliberately not on the panel's descriptor: how the
   commit history is drawn is a property of the reader,
   the same way the transcript's density is (`lib/layout-options.ts`). Putting it
   in the dock's params would make it a property of one panel in one layout, so
   the same reader would have to set it again in the next project — and it would
   be serialized into a stored layout, where it would outlive any decision to
   change the default.

   One key, one store, on the shape every device-local store in this app uses
   (`lib/local-store.ts`), so a second tab follows along. */
import { createLocalStore } from "@/lib/local-store"

export interface IdePrefs {
  /** How the commit history is read: rows, or rows with the lanes drawn. */
  historyLayout: HistoryLayout
  /** Width of the IDE panel's side view (explorer, search, source control), in px. */
  sideWidth: number
}

/** How a commit list is laid out. */
export type HistoryLayout = "list" | "graph"

const DEFAULTS: IdePrefs = {
  /* The graph by default: a log read beside a running agent is usually a
     "which line did that land on" question, which is the one thing the picture
     answers and the flat list does not. */
  historyLayout: "graph",
  sideWidth: 240,
}

const isHistoryLayout = (value: unknown): value is HistoryLayout =>
  value === "list" || value === "graph"

export const idePrefs = createLocalStore<IdePrefs>(
  "daedalus.ide.prefs.v1",
  (raw) => {
    if (!raw || typeof raw !== "object") return DEFAULTS
    const stored = raw as Partial<Record<keyof IdePrefs, unknown>>
    return {
      historyLayout: isHistoryLayout(stored.historyLayout)
        ? stored.historyLayout
        : DEFAULTS.historyLayout,
      sideWidth:
        typeof stored.sideWidth === "number" && Number.isFinite(stored.sideWidth)
          ? stored.sideWidth
          : DEFAULTS.sideWidth,
    }
  },
  DEFAULTS
)

export function setIdePref<K extends keyof IdePrefs>(key: K, value: IdePrefs[K]): void {
  idePrefs.set({ ...idePrefs.get(), [key]: value })
}
