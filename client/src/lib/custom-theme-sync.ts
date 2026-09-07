/* ── Custom themes ↔ the server ──
   The studio edits through a synchronous local store (custom-themes.ts): every
   change writes CSS and localStorage in the same tick, which is what makes an
   edit repaint the whole app instantly. That store is also what paints the
   first frame, so a cold boot shows the last-synced themes and then reads the
   real list.

   This module is the bridge to `/api/themes`: the **server is the source of
   truth for what exists**, and this side is two movements around it.

   - **Hydrate** — on connect, GET the saved rows and adopt them into the local
     store, replacing the cache. Whatever the database holds is what the gallery
     and the switcher agree on; a theme deleted on another device stops existing
     here too.
   - **Write through** — every save the studio makes is pushed out as a delta:
     unknown ids are created, changed ids updated, ids that vanished from the
     local store deleted. The push is debounced so a keystroke coalesces into
     one request carrying the theme's final state, and a failed push keeps the
     theme marked dirty so the next change retries it.

   A sync goes in and out as JSON over the same `api()` the query layer uses —
   there is deliberately no TanStack query here: the local store already owns
   the list and React re-renders it through `useCustomThemes`, and giving the
   same rows to a cached query would be a second owner with nothing to answer.

   One sync at a time, keyed by an epoch the caller owns: the component that
   mounts it against a server unmounts (or the user switches servers) with a
   different epoch, and a hydration that resolves for a retired epoch drops its
   rows instead of adopting them. */
import { api, ApiError, type ServerSettings } from "@/lib/settings"
import {
  customThemesSnapshot,
  saveCustomThemes,
  subscribeCustomThemes,
  type CustomTheme,
} from "@/lib/custom-themes"

/** A theme row as the server keeps it — the client's `CustomTheme` plus the
    two timestamps that are the server's own business. */
interface ServerThemeRow {
  id: string
  name: string
  light: Record<string, string>
  dark: Record<string, string>
  base: Record<string, string>
  createdAt: number
  updatedAt: number
}

const toCustomTheme = (row: ServerThemeRow): CustomTheme => ({
  id: row.id,
  name: row.name,
  light: row.light,
  dark: row.dark,
  base: row.base,
})

/** The payload a theme's row stores — the three halves the studio edits. */
const contentOf = (theme: CustomTheme): string => JSON.stringify([theme.name, theme.light, theme.dark, theme.base])

/** Id → the serialized content the server was last told about. The diff that
    drives the push is drawn against this, never against the store: a theme the
    flush loop is even now uploading has already been written here, so the next
    edit diff's against what left instead of what left plus what it shows. */
let lastSynced = new Map<string, string>()

// ---- push state ----

type SyncStatus = "offline" | "syncing" | "synced"
export type { SyncStatus }
let status: SyncStatus = "synced"
let statusListeners = new Set<() => void>()

function setStatus(next: SyncStatus): void {
  if (next === status) return
  status = next
  for (const listener of statusListeners) listener()
}

export function syncStatusSnapshot(): SyncStatus {
  return status
}

export function subscribeSyncStatus(listener: () => void): () => void {
  statusListeners.add(listener)
  return () => {
    statusListeners.delete(listener)
  }
}

/** The push loop. `dirty` marks the themes whose local content has moved since
   the last completed flush; `flushTimer` is the trailing debounce until one
   runs. A push is not tied to an epoch — it must reach the server it was made
   against — so every scheduled flush carries the settings it will talk to. */
let dirty = new Set<string>()
let flushTimer: ReturnType<typeof setTimeout> | null = null
/** One flush at a time: rapid edits rearm the timer, the timer starts a flush,
   and the loop there flushes again while anything is still dirty. Serializing
   matters because two flushes in flight for one theme could land out of order
   and leave the newer edit under the older on the server. */
let flushing = false
const PUSH_DEBOUNCE_MS = 450

/** Called on every local-store change: mark the changed themes dirty and arm
    the flush tail. The changed set is the whole difference between the store
    and what the server last knew, so a create, an edit and a delete all land
    in one diff. */
function markDirty(settings: ServerSettings): void {
  const cache = customThemesSnapshot()
  const current = new Set(cache.map((theme) => theme.id))
  // Deleted ids are dirty too — `dirty` drives the DELETE half of the diff.
  for (const id of lastSynced.keys()) if (!current.has(id)) dirty.add(id)
  for (const theme of cache) {
    if (lastSynced.get(theme.id) !== contentOf(theme)) dirty.add(theme.id)
  }
  if (dirty.size === 0) {
    setStatus("synced")
    return
  }
  setStatus("syncing")
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => void scheduleFlush(settings), PUSH_DEBOUNCE_MS)
}

async function scheduleFlush(settings: ServerSettings): Promise<void> {
  if (flushing) return // a run is in flight; it flushes again for anything new
  flushing = true
  try {
    while (dirty.size > 0) await runFlush(settings)
  } finally {
    flushing = false
  }
}

async function runFlush(settings: ServerSettings): Promise<void> {
  if (dirty.size === 0) {
    setStatus("synced")
    return
  }
  const ids = [...dirty]
  dirty = new Set()
  setStatus("syncing")
  try {
    const cache = customThemesSnapshot()
    const byId = new Map(cache.map((theme) => [theme.id, theme]))
    /* One pass over the dirty ids; each dirty id is exactly one request
       (create when the server has never seen it, update otherwise, forget when
       the theme is gone locally). A DELETE that answers 404 is already done —
       the row vanished on the server's side first — so it counts as a success.
       Only genuinely failed ids stay dirty, so a bad batch does not keep every
       healthy theme in limbo. */
    const settled = await Promise.all(
      ids.map(async (id): Promise<boolean> => {
        try {
          const theme = byId.get(id)
          const known = lastSynced.has(id)
          if (!theme) {
            if (!known) return true // never synced, nothing to forget
            try {
              await api<{ ok: boolean }>(settings, `/api/themes/${encodeURIComponent(id)}`, {
                method: "DELETE",
              })
            } catch (error) {
              if (error instanceof ApiError && error.status === 404) {
                lastSynced.delete(id)
                return true
              }
              throw error
            }
            lastSynced.delete(id)
            return true
          }
          const payload = { ...theme }
          if (known) {
            await api<ServerThemeRow>(settings, `/api/themes/${encodeURIComponent(id)}`, {
              method: "PUT",
              body: JSON.stringify(payload),
            })
          } else {
            await api<ServerThemeRow>(settings, "/api/themes", {
              method: "POST",
              body: JSON.stringify(payload),
            })
          }
          lastSynced.set(id, contentOf(theme))
          return true
        } catch {
          return false
        }
      })
    )
    let idle = true
    for (let index = 0; index < settled.length; index++) {
      if (settled[index]) continue
      // The store itself is untouched — the user's edit is safely local — and
      // a failed id stays dirty so any later change retries it.
      dirty.add(ids[index])
      idle = false
    }
    setStatus(idle ? "synced" : "offline")
  } catch {
    /* A failure outside the per-id loop (a cache read throwing, say) keeps the
       whole batch dirty and visible as offline — never silent. */
    for (const id of ids) dirty.add(id)
    setStatus("offline")
  }
}

// ---- the epoch-guarded sync ----

/** A live sync: the connection it talks to and whether it is still the one in
    charge. The teardown flips `alive`, and every await re-checks it before
    touching the store, so a retired sync stops scheduling and drops whatever
    lands after it is gone. */
interface ActiveSync {
  settings: ServerSettings
  epoch: number
  alive: boolean
}

let currentEpoch = 0

async function hydrate(sync: ActiveSync): Promise<void> {
  try {
    const rows = await api<ServerThemeRow[]>(sync.settings, "/api/themes")
    if (!sync.alive) return
    const themes = rows.map(toCustomTheme)
    // We answer for the whole list now; fixed point for the next diff.
    lastSynced = new Map(themes.map((theme) => [theme.id, contentOf(theme)]))
    // Replace the cache before any paint: this is the DB saying what exists.
    saveCustomThemes(themes)
    setStatus("synced")
  } catch {
    if (sync.alive) setStatus("offline")
  }
}

/** Start the sync for one connection. Hydrates immediately, then watches the
    store and pushes every change through. The returned teardown retires this
    sync: its pending flush stops and a hydration that lands afterwards is
    dropped, so a server switch cannot adopt one server's themes over another. */
export function mountThemeSync(settings: ServerSettings): () => void {
  const sync: ActiveSync = { settings, epoch: ++currentEpoch, alive: true }
  void hydrate(sync)
  const unsubscribe = subscribeCustomThemes(() => markDirty(settings))
  return () => {
    sync.alive = false
    unsubscribe()
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    dirty = new Set()
  }
}