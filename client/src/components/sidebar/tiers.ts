/* ── The sidebar's tiers, derived ── pure: no hooks, no store, so it is the one
   place the filter / sort / pinned rules can be read and checked. */
import { activityAt, isListed, type SessionMeta } from "@/lib/settings"
import type { ThreadActivity } from "@/lib/thread/phase"
import { WITHIN_MS, type SidebarFilter, type SidebarSort, type SidebarWithin } from "@/lib/layout-options"

export interface TierInput {
  sessions: SessionMeta[]
  inSpace: (session: SessionMeta) => boolean
  filter: SidebarFilter
  /** Draw the threads hiding took out of the list, in place. Off, they are out
      of every reading — which is what hiding is — and this is the one switch
      that brings them back. */
  showHidden?: boolean
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
  /** The threads `showHidden` put back among the rest, drawn in a group of
      their own so a list that stopped showing them can say how many there are
      without a filter that swaps the whole list for them. */
  hidden: SessionMeta[]
  /** Every live thread in the chosen order (newest activity first unless the
      sort says otherwise) — what the folders file. */
  filed: SessionMeta[]
}

export function deriveTiers({
  sessions,
  inSpace,
  filter,
  showHidden = false,
  within = "any",
  sort = "recent",
  unread,
  now = Date.now(),
  statuses,
  pins,
  query = "",
  projectNames,
}: TierInput): Tiers {
  // Deleting is reversible, so a deleted thread stays out of the ordinary
  // list and is shown only when Trash is the selected filter.
  const needle = query.trim().toLowerCase()
  const scoped = sessions.filter((session) => isListed(session) && inSpace(session))
  const trashed = scoped
    .filter((session) => !!session.deletedAt)
    .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
  const live = (filter === "trash" ? trashed : scoped).filter((session) => {
    if (filter === "trash") return !needle || matches(session, needle, projectNames)
    if (session.deletedAt) return false
    /* A hidden thread is out of every list unless the list was told to draw
       them — and then it is drawn in the group of its own below, never among
       the threads nobody hid. */
    if (session.hiddenAt && !showHidden) return false
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

  /* Trash is its own sorted set and holds nothing to hide; every other
     reading draws what is left once the hidden ones are taken out of it. */
  const shown = filter === "trash" ? live : live.filter((session) => !session.hiddenAt)

  /* By last activity, not by creation: a thread is recent because something
     was said in it, so picking up an old one brings it back to the top. */
  const filed =
    filter === "trash"
      ? [...live].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0))
      : [...shown].sort(
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

  /* The group under the list: what hiding took out of it, newest activity
     first. Drawn only when the list was asked for them, and never while Trash
     is the reading — a deleted thread is not a hidden one. */
  const hidden = filter === "trash" || !showHidden ? [] : live.filter((session) => !!session.hiddenAt)
  hidden.sort((a, b) => activityAt(b) - activityAt(a))

  return { live, trashed, pinned, hidden, filed }
}

/** Title, project, agent or model, every word of the query somewhere in them. */
function matches(session: SessionMeta, needle: string, projectNames?: ReadonlyMap<string, string>) {
  const hay = `${session.title} ${projectNames?.get(session.projectId) ?? "Other"} ${session.agentId} ${session.model}`.toLowerCase()
  return needle.split(/\s+/).every((word) => hay.includes(word))
}
