/* ── The sidebar's tiers, derived ── pure: no hooks, no store, so it is the one
   place the filter / sort / Opened / Recents rules can be read and checked. */
import { activityAt, isListed, type SessionMeta } from "@/lib/settings"
import type { ThreadActivity } from "@/lib/thread/phase"
import type { SidebarFilter, SidebarSort } from "./view"

/** Rows Recents shows before folding the rest into the project folders. */
export const RECENT_COUNT = 8

export interface TierInput {
  sessions: SessionMeta[]
  inSpace: (session: SessionMeta) => boolean
  filter: SidebarFilter
  sort: SidebarSort
  statuses: ReadonlyMap<string, ThreadActivity>
  /** Pin order — the order pins were added in. */
  pins: readonly string[]
  /** Threads with a tab open, in the dock's order. */
  openIds: readonly string[]
  /** The in-sidebar filter: matched locally against what is already loaded. */
  query?: string
  projectNames?: ReadonlyMap<string, string>
}

export interface Tiers {
  live: SessionMeta[]
  trashed: SessionMeta[]
  pinned: SessionMeta[]
  recent: SessionMeta[]
  opened: SessionMeta[]
  /** Every live thread, newest activity first — what the folders file. */
  filed: SessionMeta[]
}

export function deriveTiers({ sessions, inSpace, filter, sort, statuses, pins, openIds, query = "", projectNames }: TierInput): Tiers {
  // Deleting is reversible, so a deleted thread leaves the tiers above but
  // not the sidebar: it drops into Trash until it is restored or purged.
  const needle = query.trim().toLowerCase()
  const scoped = sessions.filter((session) => isListed(session) && inSpace(session))
  const trashed = scoped
    .filter((session) => !!session.deletedAt)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
  const live = scoped.filter((session) => {
    if (session.deletedAt) return false
    if (needle && !matches(session, needle, projectNames)) return false
    if (filter === "running") return statuses.get(session.id) === "running"
    /* "Needs you" is both readings that are addressed to the reader: a
       question the agent is blocked on, and a turn that ended badly and
       has been sitting there since. */
    if (filter === "waiting") {
      const status = statuses.get(session.id)
      return status === "waiting" || status === "failed"
    }
    return true
  })

  /* By last activity, not by creation: a thread is recent because something
     was said in it, so picking up an old one brings it back to the top. */
  const newestFirst = [...live].sort((a, b) => activityAt(b) - activityAt(a))
  const byId = new Map(newestFirst.map((session) => [session.id, session]))

  // Pinned keeps the order pins were added in, not the order threads were created.
  const pinned = pins.flatMap((id) => {
    const session = byId.get(id)
    return session ? [session] : []
  })

  /* Opened: mapped through `live`, so the status filter narrows this tier with
     every other, and a draft (which no list draws) stays out of it. Recents
     leaves these out; closing a tab returns the thread to it. */
  const openSet = new Set(openIds)
  const opened = openIds.flatMap((id) => {
    const session = byId.get(id)
    return session ? [session] : []
  })
  const closed = newestFirst.filter((session) => !openSet.has(session.id))

  /* Recents is newest first, by activity — and running is a reason to be *in*
     it, never a reason to be at the top: a status correction must not re-sort
     the list under the click that opened a row. Every running thread keeps its
     place whatever its age; the rest fill what is left. By project: no Recents. */
  const shown = new Set(closed.filter((s) => statuses.get(s.id) === "running").map((s) => s.id))
  const cap = Math.max(RECENT_COUNT, shown.size)
  for (const session of closed) {
    if (shown.size >= cap) break
    shown.add(session.id)
  }
  const recent = sort === "recent" ? closed.filter((session) => shown.has(session.id)) : []
  return { live, trashed, pinned, recent, opened, filed: newestFirst }
}

/** Title, project or agent, every word of the query somewhere in them. */
function matches(session: SessionMeta, needle: string, projectNames?: ReadonlyMap<string, string>) {
  const hay = `${session.title} ${projectNames?.get(session.projectId) ?? "Other"} ${session.agentId}`.toLowerCase()
  return needle.split(/\s+/).every((word) => hay.includes(word))
}
