/* ── What a panel needs from the thing hosting it ──
   The terminal and the preview were written against dockview's panel api; they
   use three things from it — an id, a way to name themselves, and a way to
   change their own parameters. The right panel hosts them without dockview, so
   this is that much and no more, and dockview's api is structurally assignable
   to it.

   Titles are held here, not in the panel: the section that hosts a panel draws
   its sub-tab, and has to read a name the panel only knows once it is running
   (a shell's OSC title, the address a preview is looking at). */
import * as React from "react"

import { createStore } from "@/lib/local-store"

export interface PanelHandle {
  id: string
  setTitle: (title: string) => void
  updateParameters: (patch: Record<string, unknown>) => void
}

export interface PanelProps<T> {
  api: PanelHandle
  params: T
}

const titles = createStore<Record<string, string>>({})

export function setPanelTitle(id: string, title: string): void {
  if (titles.get()[id] === title) return
  titles.set({ ...titles.get(), [id]: title })
}

export function clearPanelTitle(id: string): void {
  const { [id]: _gone, ...rest } = titles.get()
  void _gone
  titles.set(rest)
}

export function usePanelTitle(id: string): string | undefined {
  const all = React.useSyncExternalStore(titles.subscribe, titles.get, titles.get)
  return all[id]
}
