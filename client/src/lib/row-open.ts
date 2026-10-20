/* ── A disclosure that outlives its row's mount ──
   A settled row far from the viewport goes dormant (`thread-view/dormant.tsx`):
   its contents unmount and come back when it is scrolled near again. Most of
   what was in them is a reading of the items and comes back as it was; the
   reader's own clicks — a step opened, a run folded — are component state, and
   would come back as the defaults. So the few disclosures a dormant row can
   hold remember their answer here, keyed by item, and a *revived*
   mount (and only that one) starts from it. Every other mount starts where it
   always did, so nothing outside dormancy changes.

   Only an answer that differs from the default is kept, and the map is capped:
   it is a cache of clicks, not a store of record. It is the *view's*
   (`RowMemoryContext`, one per ThreadView, gone with it): the same thread can
   stand in several tabs at once, and one view's mounts must neither erase nor
   hand over another's answers. An entry is tied to the view option it was given
   under (`setting`), and the view drops every such entry when that option moves
   (`clearSettled`), so flipping it — and flipping it back — still takes every
   row back to its default, dormant or not. */
import * as React from "react"

/** True inside a row that is being remounted after dormancy. */
export const RevivedContext = React.createContext(false)

export type RowMemory = Map<string, { value: unknown; setting: unknown }>

/** The answers of one transcript view. Absent, `useRowState` is `useState`. */
export const RowMemoryContext = React.createContext<RowMemory | null>(null)

/** Forget every answer given under a view option — the option just moved. */
export function clearSettled(memory: RowMemory) {
  for (const [id, entry] of memory) if (entry.setting !== undefined) memory.delete(id)
}

// ponytail: insertion-order cap; an LRU only if a long session loses clicks.
const CAP = 2000

/** `useState`, plus memory across a dormant row's revival. `key` is the item's
    id; without one (or outside a view that keeps memory) it is plain `useState`. */
export function useRowState<T>(
  key: string | undefined,
  initial: T,
  setting?: unknown
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const memory = React.useContext(RowMemoryContext)
  const revived = React.useContext(RevivedContext)
  const id = key && memory ? key : undefined
  const [value, setValue] = React.useState<T>(() => {
    const hit = id && revived ? memory!.get(id) : undefined
    return hit && Object.is(hit.setting, setting) ? (hit.value as T) : initial
  })
  React.useEffect(() => {
    if (!id || !memory) return
    memory.delete(id)
    /* Compared to the default as it is *now*: a default that moves (a
       workflow card open while it runs, closed once it is done) turns a value
       that was the default into the reader's answer. */
    if (Object.is(value, initial)) return
    memory.set(id, { value, setting })
    if (memory.size > CAP) memory.delete(memory.keys().next().value as string)
  }, [id, memory, value, initial, setting])
  return [value, setValue]
}
