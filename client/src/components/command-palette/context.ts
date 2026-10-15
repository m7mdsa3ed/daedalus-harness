/* What every page of the palette needs from the shell around it: where it is,
   what is typed, and the four things only app-shell can do. Its own module so a
   page can import it without importing the palette that renders the page. */
import * as React from "react"

import type { Actions } from "@/lib/actions"

/** Each page is a screen of the palette. `root` is the command list; the rest
    are entered from it and exited with Backspace, Escape or the chip in the
    input. */
export type PageId =
  | "root"
  | "search"
  | "thread-search"
  | "projects"
  /** Which project the draft in front of you runs in. Not `projects`, which is
      a list of places to *go*: this one answers a question about the thread. */
  | "project"
  | "start"
  | "theme"
  | "model"
  | "effort"
  /** ACP's permission mode — default / accept edits / plan. */
  | "mode"
  /** The routines, as things to fire. */
  | "routines"
  /** What the routines have been doing — runs across every routine, newest
      first. A reading page, not a doing one; see `routine-pages.tsx`. */
  | "routine-activity"

export interface Palette {
  page: PageId
  query: string
  setQuery: (value: string) => void
  /** The message being started, held while the `start` page filters projects on
      its own query — prose in the box would match no project row. */
  askText: string
  close: () => void
  /** Close, then do the thing. Every command that navigates goes through it. */
  run: (fn: () => void) => void
  descend: (page: PageId, opts?: { query?: string; askText?: string }) => void
  back: () => void
  actions: Actions
  newThread: (opts?: { text?: string; projectId?: string }) => void
  newProject: () => void
  importThreads: () => void
  showShortcuts: () => void
  /** How transcripts are drawn on this device. Owned by app-shell for the same
      reason the shortcut sheet is — the palette unmounts as the row runs. */
  showViewOptions: () => void
}

export const PaletteContext = React.createContext<Palette | null>(null)

export function usePalette(): Palette {
  const palette = React.useContext(PaletteContext)
  if (!palette) throw new Error("usePalette() outside the command palette")
  return palette
}

export const PAGE_LABEL: Record<PageId, string> = {
  root: "",
  search: "Search",
  "thread-search": "Search this thread",
  projects: "Projects",
  project: "Project",
  start: "New thread",
  theme: "Theme",
  model: "Model",
  effort: "Effort",
  mode: "Permission mode",
  routines: "Run routine",
  "routine-activity": "Routine activity",
}

export const PAGE_PLACEHOLDER: Record<PageId, string> = {
  root: "Type a command…",
  search: "Search threads and messages…",
  "thread-search": "Search this thread…",
  projects: "Search projects…",
  project: "Search projects…",
  start: "Search projects…",
  theme: "Search palettes…",
  model: "Search models…",
  effort: "Search effort levels…",
  mode: "Search permission modes…",
  routines: "Search routines…",
  "routine-activity": "Search recent runs…",
}
