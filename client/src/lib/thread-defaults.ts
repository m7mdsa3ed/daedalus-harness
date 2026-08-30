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

/**
 * The half of the defaults that is only meaningful inside a profile.
 *
 * `projectId`/`profileId` degrade to a fallback on their own — a deleted
 * project just means the first one. Model and effort cannot: they name ids in
 * the remembered *profile's* catalog, so once the fallback picks a different
 * profile they name something that profile has never heard of, and it is passed
 * straight through to the agent's env at spawn (a codex model id filling
 * claude-code's ANTHROPIC_MODEL). Carry them only when the remembered profile
 * is the one actually resolved — the same rule the `configure-draft` reducer
 * already applies to `configChoices`.
 */
export function defaultsForProfile(
  defaults: ThreadDefaults,
  profileId: string
): Pick<ThreadDefaults, "model" | "effort"> {
  if (defaults.profileId !== profileId) return {}
  return { model: defaults.model, effort: defaults.effort }
}

export function saveThreadDefaults(next: ThreadDefaults): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // A convenience, not a setting: losing it costs one extra pick.
  }
}
