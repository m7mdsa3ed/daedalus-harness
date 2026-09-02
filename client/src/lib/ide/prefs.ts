/* ── How the IDE is read ──
   Device-local, global, and deliberately not on the panel's descriptor: whether
   changed files are drawn as a tree or as a list is a property of the reader,
   the same way the transcript's density is (`lib/view-options.ts`). Putting it
   in the dock's params would make it a property of one panel in one layout, so
   the same reader would have to set it again in the next project — and it would
   be serialized into a stored layout, where it would outlive any decision to
   change the default.

   One key, one store, on the shape every device-local store in this app uses
   (`lib/local-store.ts`), so a second tab follows along. */
import { createLocalStore } from "@/lib/local-store"

/** How a set of changed files is laid out. */
export type FileLayout = "tree" | "list"

export interface IdePrefs {
  scmLayout: FileLayout
  changesLayout: FileLayout
}

const DEFAULTS: IdePrefs = {
  /* A tree by default: a working set is usually a handful of files in two or
     three directories, where the tree is shorter than the list and says where
     the work happened. */
  scmLayout: "tree",
  changesLayout: "tree",
}

const isLayout = (value: unknown): value is FileLayout => value === "tree" || value === "list"

export const idePrefs = createLocalStore<IdePrefs>(
  "daedalus.ide.prefs.v1",
  (raw) => {
    if (!raw || typeof raw !== "object") return DEFAULTS
    const stored = raw as Partial<Record<keyof IdePrefs, unknown>>
    return {
      scmLayout: isLayout(stored.scmLayout) ? stored.scmLayout : DEFAULTS.scmLayout,
      changesLayout: isLayout(stored.changesLayout) ? stored.changesLayout : DEFAULTS.changesLayout,
    }
  },
  DEFAULTS
)

export function setIdePref<K extends keyof IdePrefs>(key: K, value: IdePrefs[K]): void {
  idePrefs.set({ ...idePrefs.get(), [key]: value })
}
