/* ── Pinned branches ──
   The branches a person keeps at the top of Source Control's Locations, per
   repository. Device-local, like the rest of how that panel is drawn: a pin is
   a shortcut for the reader, not a fact about the repository.

   A pin is a name, not a ref: one deleted outside the app lingers until it is
   unpinned. */
import { createLocalStore } from "./local-store"

type Pins = Record<string, string[]>

const store = createLocalStore<Pins>(
  "ui.pinnedBranches",
  (raw) => {
    if (!raw || typeof raw !== "object") return {}
    const pins: Pins = {}
    for (const [key, names] of Object.entries(raw))
      if (Array.isArray(names)) pins[key] = names.filter((name): name is string => typeof name === "string")
    return pins
  },
  {}
)

const keyOf = (projectId: string, repo: string) => `${projectId}\0${repo}`
const NONE: string[] = []

export function usePinnedBranches(projectId: string, repo: string): string[] {
  return store.use()[keyOf(projectId, repo)] ?? NONE
}

export function setBranchPinned(projectId: string, repo: string, name: string, pinned: boolean) {
  const key = keyOf(projectId, repo)
  const rest = (store.get()[key] ?? NONE).filter((n) => n !== name)
  store.set({ ...store.get(), [key]: pinned ? [...rest, name] : rest })
}
