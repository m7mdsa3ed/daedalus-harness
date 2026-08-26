/* ── New-thread defaults ──
   How the last thread you started was configured, so the next one opens on the
   same agent instead of on whatever happens to sort first. Device-local, like
   drafts and pins: which agent *you* reach for is not a property of the harness
   everyone shares.

   Nothing prunes this. The ids it holds go stale when a profile or project is
   deleted, and the readers all resolve with a fallback — a dangling id costs a
   default, never a crash. */
const KEY = "ui.newThread"

export interface ThreadDefaults {
  projectId?: string
  profileId?: string
  model?: string
  effort?: string
}

export function loadThreadDefaults(): ThreadDefaults {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === "object" ? (parsed as ThreadDefaults) : {}
  } catch {
    return {}
  }
}

export function saveThreadDefaults(next: ThreadDefaults): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // A convenience, not a setting: losing it costs one extra pick.
  }
}
