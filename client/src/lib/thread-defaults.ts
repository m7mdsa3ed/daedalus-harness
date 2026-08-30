/* ── New-thread defaults ──
   How the last thread you started was configured, so the next one opens on the
   same agent instead of on whatever happens to sort first. Device-local, like
   drafts and pins: which agent *you* reach for is not a property of the harness
   everyone shares.

   Nothing prunes this. The ids it holds go stale when a profile or project is
   deleted, and the readers all resolve with a fallback — a dangling id costs a
   default, never a crash. */
import { profileAgentIds, profileSupports, type Profile } from "@/lib/settings"

const KEY = "ui.newThread"

export interface ThreadDefaults {
  projectId?: string
  profileId?: string
  /** Which of the profile's agents answered last time. */
  agentId?: string
  model?: string
  effort?: string
  /** The library picks the last draft made on its composer strip — the MCP
      servers, skills and slash commands it brought on top of its profile's.
      Remembered so a reload (which rebuilds an unsent draft from these
      defaults) does not silently drop them, and so the next thread starts
      with the same kit. Ids, so a row since deleted simply matches nothing. */
  mcpServerIds?: string[]
  skillIds?: string[]
  commandIds?: string[]
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

/**
 * The (profile, agent) pair a new thread opens on.
 *
 * Both halves are remembered, and each degrades on its own: the profile you
 * last used may be gone, or may no longer be configured for the agent you last
 * used. The agent is the stickier habit — when the remembered profile cannot
 * serve it, the first profile that can (the agent's virtual Default sorts
 * first) is picked over switching agents. With nothing usable remembered, the
 * first profile and its first agent. Null only when there are no profiles at
 * all, which is the "set up a project" empty state.
 */
export function resolveThreadStart(
  defaults: ThreadDefaults,
  profiles: readonly Profile[]
): { profile: Profile; agentId: string } | null {
  const remembered = profiles.find((p) => p.id === defaults.profileId)
  const agentId = defaults.agentId
  if (remembered && agentId && profileSupports(remembered, agentId)) {
    return { profile: remembered, agentId }
  }
  if (agentId) {
    const serving = profiles.find((p) => profileSupports(p, agentId))
    if (serving) return { profile: serving, agentId }
  }
  const profile = remembered ?? profiles[0]
  const first = profile && profileAgentIds(profile)[0]
  return profile && first ? { profile, agentId: first } : null
}

/** The library picks, as the arrays a draft carries — every key present, so
    a caller can spread it over a `SessionMeta` without a fallback each. */
export function defaultToolPicks(
  defaults: ThreadDefaults
): Required<Pick<ThreadDefaults, "mcpServerIds" | "skillIds" | "commandIds">> {
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []
  return {
    mcpServerIds: ids(defaults.mcpServerIds),
    skillIds: ids(defaults.skillIds),
    commandIds: ids(defaults.commandIds),
  }
}

/** Merges over what is remembered: a caller that knows about the agent should
    not have to know about the tool picks to keep them, and vice versa. */
export function saveThreadDefaults(next: ThreadDefaults): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadThreadDefaults(), ...next }))
  } catch {
    // A convenience, not a setting: losing it costs one extra pick.
  }
}
