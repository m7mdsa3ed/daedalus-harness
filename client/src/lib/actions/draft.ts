/* A thread before it exists: minting the draft, retuning it, and the one-shot
   probe that tells a draft's menus what the agent can be configured with.

   Split out of the one 1500-line `useActions` memo; see `lib/actions.ts`. */

import type * as acp from "@daedalus/acp"
import { uuid } from "../uuid"
import {
  alreadyAsked,
  loadAgentOptions,
  markAsked,
  markProbed,
  optionKey,
  saveProbedOptions,
  type AgentOptionSet,
} from "../agent-options"
import { defaultToolPicks, loadThreadDefaults, resolveThreadStart } from "../thread-defaults"
import { api, profileAgentIds, type Profile, type Project, type SessionMeta } from "../settings"
import { emptyThread } from "../store"
import { patchDraft, rememberDraft } from "../draft-sessions"
import type { ActionsCore } from "./core"

export function draftActions(core: ActionsCore) {
  const { settings, dispatch, catalog } = core

  /**
   * Open a new thread without creating one. The id is minted here so the
   * route, the tab and the transcript all exist before anything touches the
   * network; the server is not told, and no agent process is spawned, until
   * the first message (see `send`). Synchronous on purpose — a new thread
   * should never be something you wait for. The row is also written to this
   * device's draft store, so a reload brings the tab back (see
   * `lib/draft-sessions.ts`).
   */
  const newDraftThread = (opts: {
    project: Project
    profile: Profile
    /** One of `profile.agents`; the profile's first when left out. */
    agentId?: string
    model?: string
    effort?: string
    /** Adopt this exact id instead of minting one — a reload that landed on
        a thread the server never heard of, which is what an unsent draft
        looks like from a fresh page. */
    id?: string
  }): string => {
    const { project, profile, model, effort } = opts
    const id = opts.id ?? uuid()
    /* The library picks come from the same remembered defaults the agent
       does — read here rather than by each caller, so a reload that
       re-adopts an unsent draft gets its MCP servers, skills and commands
       back along with its profile. */
    const defaults = loadThreadDefaults()
    const tools = defaultToolPicks(defaults)
    const session: SessionMeta = {
      id,
      profileId: profile.id,
      projectId: project.id,
      agentId: opts.agentId ?? profileAgentIds(profile)[0] ?? "",
      model: model ?? "",
      effort: effort ?? "",
      /* Remembered like the tool picks, and read here for the same
         reason: a reload that re-adopts an unsent draft has to get back
         the way it was going to be worked on, not just its profile. */
      personaId: defaults.personaId ?? "",
      suggestFollowups: defaults.suggestFollowups ?? true,
      uiBlocks: defaults.uiBlocks ?? true,
      title: "New thread",
      createdAt: Date.now(),
      deletedAt: null,
      attached: false,
      exited: false,
      promptActive: false,
      cursor: 0,
      draft: true,
      ...tools,
    }
    dispatch({ type: "draft-session", session })
    dispatch({ type: "thread-reset", id, thread: { ...emptyThread } })
    rememberDraft(settings.id, session)
    return id
  }

  return {
    /**
     * The one front door every "new thread" gesture takes: mint a draft in a
     * project — the caller's, else the remembered default, else the first —
     * resolving profile/agent/model from the same remembered defaults the
     * draft menu shows. Null when there is nothing to start on, which is the
     * "set up a project" case. `id` adopts an exact id: a reload that landed
     * on a thread the server never heard of, which is what an unsent draft
     * looks like from a fresh page.
     */
    startThreadIn(opts: { projectId?: string; id?: string } = {}): string | null {
      const defaults = loadThreadDefaults()
      const project =
        (opts.projectId ? catalog.projects().find((p) => p.id === opts.projectId) : undefined) ??
        catalog.projects().find((p) => p.id === defaults.projectId) ??
        catalog.projects()[0]
      const start = resolveThreadStart(defaults, catalog.profiles())
      if (!project || !start) return null
      return newDraftThread({ project, ...start, id: opts.id })
    },

    newDraftThread,

    /**
     * Find out what an agent can be configured with on a profile, once.
     *
     * The server answers by spawning one and killing it (see probe.ts), which
     * is the only way to ask — so this runs at most once per (profile, agent)
     * per page-load, and never when a live session has already told us. A
     * failure is still silent in the console sense, but it is no longer silent
     * on screen: the outcome is recorded (`markProbed`) so the menu can say
     * "asking", "that didn't work, try again" and "this agent offers nothing"
     * as the three different things they are. `force` is the try-again — the
     * one caller that may step over the once-per-page-load guard.
     */
    async learnAgentOptions(
      profileId: string,
      agentId: string,
      projectId: string,
      force = false
    ) {
      if (!agentId) return
      const key = optionKey(profileId, agentId)
      if (!force && (alreadyAsked(key) || loadAgentOptions(key).base.length > 0)) return
      markAsked(key)
      try {
        const probed = await api<{
          configOptions: acp.SessionConfigOption[]
          byModel: AgentOptionSet["byModel"]
          modes?: acp.SessionModeState | null
        }>(settings, `/api/profiles/${profileId}/options`, {
          method: "POST",
          body: JSON.stringify({ projectId, agentId }),
        })
        saveProbedOptions(key, {
          base: probed.configOptions ?? [],
          byModel: probed.byModel ?? {},
          ...(probed.modes ? { modes: probed.modes } : {}),
        })
        markProbed(key, true)
      } catch (error) {
        console.warn(`Couldn't ask ${agentId} on ${profileId} what it supports`, error)
        markProbed(key, false)
      }
    },

    /** Pick an agent setting on a thread that does not exist yet, against the
        option set that agent last advertised. Held until session/new can
        apply it — see `createSession`. */
    chooseDraftConfigOption(id: string, configId: string, value: string | boolean) {
      dispatch({ type: "draft-config-option", id, configId, value })
      patchDraft(settings.id, id, (row) => ({
        configChoices: { ...row.configChoices, [configId]: value },
      }))
    },

    /** Retune a thread that does not exist yet. Model and effort are env at
        spawn, so until the process starts they are ours to change freely. */
    configureDraft(
      id: string,
      next: Partial<
        Pick<
          SessionMeta,
          | "projectId"
          | "profileId"
          | "agentId"
          | "model"
          | "effort"
          | "modeId"
          | "personaId"
          | "suggestFollowups"
          | "uiBlocks"
          | "mcpServerIds"
          | "skillIds"
          | "commandIds"
        >
      >
    ) {
      dispatch({ type: "configure-draft", id, next })
      /* The same rescope the reducer applies: a different agent or profile is a
         different set of settings, so the picks made against the old one must
         not come back with the row on the next reload. */
      const rescoped = next.agentId !== undefined || next.profileId !== undefined
      patchDraft(settings.id, id, {
        ...next,
        ...(rescoped ? { configChoices: undefined, modeId: undefined } : null),
      })
    },
  }
}
