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
  /** How the last thread you started was worked on. Not scoped to a profile
      the way model and effort are — a persona is instructions, and they mean
      the same thing on any provider — so it is carried whichever profile the
      fallback lands on. A persona since deleted matches nothing and the draft
      opens with none, which is the right answer either way. */
  personaId?: string
  /** Whether new threads ask answers to close with follow-up suggestions.
      Carried like the persona: it is instructions, not provider state. */
  suggestFollowups?: boolean
  /** Whether new threads may be answered with a drawn view. Also instructions
      rather than provider state, so it travels with the persona above. */
  uiBlocks?: boolean
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

export interface ThreadStart {
  profile: Profile
  agentId: string
  model?: string
  effort?: string
}

/**
 * The (profile, agent) pair a new thread opens on, with the model and effort
 * that go with it — the shape `actions.newDraftThread` takes, so a caller
 * spreads it and adds the project.
 *
 * Both halves are remembered, and each degrades on its own: the profile you
 * last used may be gone, or may no longer be configured for the agent you last
 * used. The agent is the stickier habit — when the remembered profile cannot
 * serve it, the first profile that can (the agent's virtual Default sorts
 * first) is picked over switching agents. With nothing usable remembered, the
 * first profile and its first agent. Null only when there are no profiles at
 * all, which is the "set up a project" empty state.
 *
 * Model and effort ride along only when the remembered profile is the one
 * actually resolved. `projectId`/`profileId` degrade to a fallback on their
 * own; these two cannot — they name ids in the remembered *profile's* catalog,
 * and once the fallback picks a different profile they name something it has
 * never heard of, passed straight through to the agent's env at spawn (a codex
 * model id filling claude-code's ANTHROPIC_MODEL). Same rule the
 * `configure-draft` reducer applies to `configChoices`.
 */
export function resolveThreadStart(
  defaults: ThreadDefaults,
  profiles: readonly Profile[]
): ThreadStart | null {
  const pair = resolvePair(defaults, profiles)
  if (!pair) return null
  if (pair.profile.id !== defaults.profileId) return pair
  return { ...pair, model: defaults.model, effort: defaults.effort }
}

function resolvePair(
  defaults: ThreadDefaults,
  profiles: readonly Profile[]
): { profile: Profile; agentId: string } | null {
  /* A hidden or disabled profile is not a candidate for a new thread, and that
     includes the remembered one: opening on it again would reopen exactly the
     selection the flags took out of the pickers. The agents' virtual Defaults
     are neither, so while any agent is registered there is always a fallback. */
  const shown = profiles.filter((p) => !p.hidden && !p.disabled)
  const remembered = shown.find((p) => p.id === defaults.profileId)
  const agentId = defaults.agentId
  if (remembered && agentId && profileSupports(remembered, agentId)) {
    return { profile: remembered, agentId }
  }
  if (agentId) {
    const serving = shown.find((p) => profileSupports(p, agentId))
    if (serving) return { profile: serving, agentId }
  }
  const profile = remembered ?? shown[0]
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
