/* ── The sidebar's tiers, derived ── pure: no hooks, no store, so it is the one
   place the filter / sort / pinned rules can be read and checked. */
import { activityAt, isListed, type SessionMeta } from "@/lib/settings"
import type { ThreadActivity } from "@/lib/thread/phase"
import { WITHIN_MS, type SidebarFilter, type SidebarSort, type SidebarWithin } from "@/lib/layout-options"

export interface TierInput {
  sessions: SessionMeta[]
  inSpace: (session: SessionMeta) => boolean
  filter: SidebarFilter
  /** Only threads with a turn this recent. */
  within?: SidebarWithin
  /** How `filed` is ordered; `project` is the activity order, filed by folder. */
  sort?: SidebarSort
  /** Finished turns the reader has not looked at (`useUnreadIds`). */
  unread?: ReadonlySet<string>
  now?: number
  statuses: ReadonlyMap<string, ThreadActivity>
  /** Pin order — the order pins were added in. */
  pins: readonly string[]
  /** The in-sidebar filter: matched locally against what is already loaded. */
  query?: string
  projectNames?: ReadonlyMap<string, string>
}

export interface Tiers {
  live: SessionMeta[]
  trashed: SessionMeta[]
  pinned: SessionMeta[]
  /** Every live thread in the chosen order (newest activity first unless the
      sort says otherwise) — what the folders file. */
  filed: SessionMeta[]
}

export function deriveTiers({
  sessions,
  inSpace,
  filter,
  within = "any",
  sort = "recent",
  unread,
  now = Date.now(),
  statuses,
  pins,
  query = "",
  projectNames,
}: TierInput): Tiers {
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
    if (within !== "any" && activityAt(session) < now - WITHIN_MS[within]) return false
    if (filter === "unread") return unread?.has(session.id) ?? false
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
  const filed = [...live].sort(
    sort === "created"
      ? (a, b) => b.createdAt - a.createdAt
      : sort === "title"
        ? (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true })
        : (a, b) => activityAt(b) - activityAt(a)
  )
  const byId = new Map(filed.map((session) => [session.id, session]))

  // Pinned keeps the order pins were added in, not the order threads were created.
  const pinned = pins.flatMap((id) => {
    const session = byId.get(id)
    return session ? [session] : []
  })

  return { live, trashed, pinned, filed }
}

/** Title, project, agent or model, every word of the query somewhere in them. */
function matches(session: SessionMeta, needle: string, projectNames?: ReadonlyMap<string, string>) {
  const hay = `${session.title} ${projectNames?.get(session.projectId) ?? "Other"} ${session.agentId} ${session.model}`.toLowerCase()
  return needle.split(/\s+/).every((word) => hay.includes(word))
}
