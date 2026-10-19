/* ── Fold memory ── which sidebar groups are folded, shared by project folders,
   Trash and a thread's sub threads. */
import * as React from "react"
import { createLocalStore } from "@/lib/local-store"

/* Which groups are folded, on this device. One list for every foldable thing —
   a project folder is keyed by its id, Trash by a name no project can have —
   so the sidebar has one fold memory rather than one per kind of group. */
const COLLAPSED_KEY = "ui.collapsedProjects"

const collapsedStore = createLocalStore<string[]>(
  COLLAPSED_KEY,
  (raw) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []),
  []
)

/* Reactive across every instance (and tab): a fold written here is what each
   other reader of the key sees, with no re-read of localStorage per toggle. */
export function useFold(key: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const open = React.useSyncExternalStore(
    collapsedStore.subscribe,
    () => collapsedStore.get().includes(key) !== defaultOpen
  )
  const setOpen = React.useCallback(
    (next: boolean) => {
      /* Only the *departure* from the default is stored, so a group that defaults
         closed (Trash) does not need a row in the list to stay closed — and one
         that defaults open does not need one to stay open. */
      const collapsed = collapsedStore.get().filter((id) => id !== key)
      if (next !== defaultOpen) collapsed.push(key)
      collapsedStore.set(collapsed)
    },
    [key, defaultOpen]
  )
  return [open, setOpen]
}
