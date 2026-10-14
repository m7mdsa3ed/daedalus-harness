/* ── How a new thread opens ──
   The values a draft starts on. Since the start defaults moved onto the
   project (`projects.default_*`, `PATCH /api/projects/:id/defaults`) the
   *scoped* half of this is the server's: "the model I use for this codebase"
   is a fact about the codebase, so it follows the person to every device and
   changing the project changes the model. That is the one thing this module
   is still for — everything else is a fallback for the questions the project
   cannot answer.

   Two of those are real and this file exists for them:

   - **A project nobody has configured has nothing to say**, and a value the
     reader invents (the first profile, the profile's default model) is worse
     than no answer: the menu should say "Profile default" because nobody has
     chosen, not because the harness chose one. So the empty fields stay
     empty, and `resolveThreadStart` leaves them for the profile to resolve at
     spawn.
   - **There is a keyboard habit the project row cannot express.** ⌘N with a
     session open starts in *that* project (`actions.startThreadIn`), while
     on the console there is no session at all and the project itself is
     remembered here. That is the only field this store still holds, and it is
     genuinely device-local: which project *you* open a front-door thread in
     is not a property of any project's row.

   Nothing prunes `projectId`. The id goes stale when a project is deleted and
   every reader resolves with a fallback — a dangling id costs a default,
   never a crash. */
import { profileAgentIds, profileSupports, type ProjectDefaults, type Profile } from "@/lib/settings"

const KEY = "ui.newThread"

export interface ThreadDefaults {
  /** Which project a front-door thread opens in. The one field the server's
      project rows cannot hold — see the module note. */
  projectId?: string
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

/** Merges over what is remembered. A pick made from a project's own controls
    does *not* come through here — it is published to that project's row
    (`rememberThreadDefaults`) — so this only ever moves `projectId`. */
export function saveThreadDefaults(next: ThreadDefaults): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadThreadDefaults(), ...next }))
  } catch {
    // A convenience, not a setting: losing it costs one extra pick.
  }
}

/** A project's defaults, or the all-empty set for a project nobody has
    configured — and for the local store, which no longer holds one. */
export const emptyDefaults = (): ProjectDefaults => ({
  profileId: "",
  agentId: "",
  model: "",
  effort: "",
  modeId: "",
  configChoices: {},
  helperModels: [],
  mcpServerIds: [],
  skillIds: [],
  commandIds: [],
  suggestFollowups: true,
  uiBlocks: true,
})

/** What a project row says, with an absent object read as the empty set —
    a server that predates the columns, or a stub. */
export const projectDefaults = (project?: { defaults?: ProjectDefaults }): ProjectDefaults =>
  project?.defaults ?? emptyDefaults()

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
 * A project's defaults degrade one half at a time, and for the reason the
 * whole store used to: the profile a project names may be gone, or may no
 * longer be configured for the agent it names. The agent is the stickier
 * habit — when the named profile cannot serve it, the first profile that can
 * (the agent's virtual Default sorts first) is picked over switching agents.
 * With nothing named or nothing usable, the first profile and its first agent,
 * which is the "set up a project" empty state.
 *
 * Model and effort ride along only when the profile that was *named* is the
 * one actually resolved. `profileId`/`agentId` degrade to a fallback on their
 * own; these two cannot — they name ids in the named *profile's* catalog, and
 * once the fallback picks a different profile they name something it has never
 * heard of, passed straight through to the agent's env at spawn (a codex model
 * id filling claude-code's ANTHROPIC_MODEL). The same rule the
 * `configure-draft` reducer applies to `configChoices`, and the reason the
 * caller fills these from the project row the profile was read off.
 */
export function resolveThreadStart(
  defaults: ProjectDefaults,
  profiles: readonly Profile[]
): ThreadStart | null {
  const pair = resolvePair(defaults, profiles)
  if (!pair) return null
  if (pair.profile.id !== defaults.profileId) return pair
  return { ...pair, model: defaults.model || undefined, effort: defaults.effort || undefined }
}

function resolvePair(
  defaults: ProjectDefaults,
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

/** The library picks a project's threads open with — every key present, so a
    caller can spread it over a `SessionMeta` without a fallback each. */
export function defaultToolPicks(
  defaults: ProjectDefaults
): Required<Pick<ProjectDefaults, "mcpServerIds" | "skillIds" | "commandIds">> {
  return {
    mcpServerIds: defaults.mcpServerIds,
    skillIds: defaults.skillIds,
    commandIds: defaults.commandIds,
  }
}
