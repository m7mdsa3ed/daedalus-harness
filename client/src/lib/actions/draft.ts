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
import { saveProjectDefaults, type ProjectDefaultsPatch } from "../project-defaults"
import {
  defaultToolPicks,
  emptyDefaults,
  loadThreadDefaults,
  resolveThreadStart,
  saveThreadDefaults,
} from "../thread-defaults"
import { api, profileAgentIds, type Profile, type Project, type SessionMeta } from "../settings"
import { emptyThread } from "../store"
import { patchDraft, rememberDraft } from "../draft-sessions"
import { saveDraft } from "../drafts"
import type { ActionsCore } from "./core"

export function draftActions(core: ActionsCore) {
  const { settings, dispatch, catalog, queryClient } = core

  /**
   * Publish picks onto the project the thread is about to run in, so they are
   * what the *next* draft there opens on — and what the same project opens on
   * from another device.
   *
   * **Only the keys the pick names** travel, and that is the whole rule: the
   * write is coalesced and another device may have moved a field this one did
   * not, so a publisher that sent the draft's whole row back would clobber a
   * concurrent pick with a stale copy of it. Each field therefore has to be
   * written by its own door — the profile by the profile row, the tools by the
   * tools menu — and `startThreadIn` is what seeds the pair a new project has
   * never been given.
   *
   * Two exclusions, both deliberate:
   *
   * - `modeId` and `configChoices` are written only for the project the draft
   *   was **already** on. Re-pointing a draft at another project moves the
   *   provider state but not the agent's own selectors: those name the option
   *   set of the agent that was in front of the menu, and handing them to a
   *   project whose agent may differ is the same rescope the
   *   `configure-draft` reducer refuses on a reload, one step further out.
   * - Moving to another project is also a **message about this device**, not
   *   about either row: which project ⌘N's front door opens in is nobody's
   *   project property, so that half goes to the device-local store.
   */
  const publish = (next: Partial<SessionMeta>, current: SessionMeta) => {
    if (next.projectId) saveThreadDefaults({ projectId: next.projectId })
    const projectId = next.projectId ?? current.projectId
    if (!projectId) return
    const sameProject = projectId === current.projectId
    const rescoped = next.profileId !== undefined || next.agentId !== undefined
    const patch: ProjectDefaultsPatch = {}
    const copy = <K extends "profileId" | "agentId" | "model" | "effort" | "personaId">(key: K) => {
      const value = next[key]
      if (value !== undefined) patch[key] = value
    }
    copy("profileId")
    copy("agentId")
    copy("model")
    copy("effort")
    copy("personaId")
    if (next.suggestFollowups !== undefined) patch.suggestFollowups = next.suggestFollowups
    if (next.uiBlocks !== undefined) patch.uiBlocks = next.uiBlocks
    if (next.mcpServerIds !== undefined) patch.mcpServerIds = next.mcpServerIds
    if (next.skillIds !== undefined) patch.skillIds = next.skillIds
    if (next.commandIds !== undefined) patch.commandIds = next.commandIds
    /* The agent's own selectors, for the project the draft was already on.
       A rescope clears them, exactly as the reducer and the server-side reload
       read it — a project whose agent has moved must not hand the next draft
       the previous agent's mode. */
    if (sameProject) {
      if (rescoped) {
        patch.modeId = ""
        patch.configChoices = {}
      } else {
        if (next.modeId !== undefined) patch.modeId = next.modeId
        if (next.configChoices !== undefined) patch.configChoices = next.configChoices
      }
    }
    if (Object.keys(patch).length === 0) return
    saveProjectDefaults(settings, queryClient, projectId, patch)
  }

  /**
   * Give a project a pair the first time it is worked in.
   *
   * `resolveThreadStart` answers with a fallback when a project has named
   * nothing — the first profile and its first agent — and a fallback is the
   * right answer for the menu to *draw*, but it is not something the project
   * has been told. Without this the first thread in a new project would run on
   * p1/a1 and the second would resolve the fallback again, so a project could
   * never hold the pair the user is actually working in, and a pick of another
   * agent would be forgotten the moment the draft was sent.
   *
   * Written only when it disagrees with what the row holds, which is once, at
   * the start of a project's life — the incremental case is the picks above.
   * Model and effort are deliberately absent: they are only meaningful against
   * the profile they were picked on (`resolveThreadStart` declines to carry
   * them across a fallback), and a project that has named no profile has named
   * no model either.
   */
  const seedProjectPair = (project: Project, profileId: string, agentId: string) => {
    if (!profileId || !agentId) return
    const held = project.defaults ?? emptyDefaults()
    if (held.profileId === profileId && held.agentId === agentId) return
    saveProjectDefaults(settings, queryClient, project.id, { profileId, agentId })
  }

  /**
   * Write one agent-selector pick onto the project the draft is about. Its own
   * path rather than a branch of `publish`, because it is addressed by *config
   * id* and merges into the set the row already holds.
   *
   * The set is merged from **the draft row in the store**, which the reducer
   * has just written, and not from the project's cached row: `configChoices`
   * is one whole object on the wire, so a second pick read off a cache the
   * first request has not answered yet would send a set without the first
   * pick in it and drop it. The draft's own row is the accumulation, and it is
   * the value `createSession` will replay.
   */
  const publishConfigOption = (id: string, configId: string, value: string | boolean) => {
    const draft = core.getState().sessions.find((s) => s.id === id)
    if (!draft?.projectId) return
    saveProjectDefaults(settings, queryClient, draft.projectId, {
      configChoices: { ...draft.configChoices, [configId]: value },
    })
  }

  /**
   * Open a new thread without creating one. The id is minted here so the
   * route, the tab and the transcript all exist before anything touches the
   * network; the server is not told, and no agent process is spawned, until
   * the first message (see `send`). Synchronous on purpose — a new thread
   * should never be something you wait for. The row is also written to this
   * device's draft store, so a reload brings the tab back (see
   * `lib/draft-sessions.ts`).
   *
   * Everything it opens on comes from the project's own defaults
   * (`projects.default_*`, `lib/project-defaults.ts`) — that is the whole
   * point: changing the project changes the model. A draft that cannot read
   * them yet (the projects query has not answered) opens on nothing, and the
   * menus fill in when the row lands; nothing here invents a value, because a
   * menu that says "Profile default" is saying the truth.
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
    /** Start it as an aside of that thread, on that passage. */
    aside?: { of: string; quote: string }
  }): string => {
    const { project, profile, model, effort } = opts
    const id = opts.id ?? uuid()
    /* The project's start defaults, which `resolveThreadStart` has already
       resolved the (profile, agent) pair against — the caller passes the
       model/effort that survived that resolution. The other fields are the
       row's, read here so a reload that re-adopts an unsent draft gets its
       persona, its tools and its mode back along with its profile. */
    const defaults = project.defaults ?? emptyDefaults()
    const tools = defaultToolPicks(defaults)
    const session: SessionMeta = {
      id,
      profileId: profile.id,
      projectId: project.id,
      agentId: opts.agentId ?? profileAgentIds(profile)[0] ?? "",
      model: model ?? "",
      effort: effort ?? "",
      personaId: defaults.personaId,
      suggestFollowups: defaults.suggestFollowups,
      uiBlocks: defaults.uiBlocks,
      /* The picks against the agent's advertised selectors, and the permission
         mode, are the project's too — they are what the menu there showed. An
         empty set is what a project nobody has configured holds, and
         `createSession` replays exactly what the menu drew. */
      configChoices: defaults.configChoices,
      ...(defaults.modeId ? { modeId: defaults.modeId } : {}),
      title: "New thread",
      createdAt: Date.now(),
      deletedAt: null,
      attached: false,
      exited: false,
      promptActive: false,
      cursor: 0,
      draft: true,
      ...tools,
      ...(opts.aside ? { forkedFromSessionId: opts.aside.of, asideQuote: opts.aside.quote } : {}),
    }
    dispatch({ type: "draft-session", session })
    dispatch({ type: "thread-reset", id, thread: { ...emptyThread } })
    rememberDraft(settings.id, session)
    /* The one place a draft is minted, so the one place this has to happen: a
       project that had named no pair has just had one resolved *for* it, and
       without keeping it every thread here would resolve the same fallback
       again and a pick of another agent would be forgotten the moment the
       draft was sent. See `seedProjectPair`. */
    seedProjectPair(project, session.profileId, session.agentId)
    return id
  }

  return {
    /**
     * The one front door every "new thread" gesture takes: mint a draft in a
     * project — the caller's, else the one this device last opened on, else
     * the first — resolving the profile/agent/model from *that project's* own
     * defaults. Null when there is nothing to start on, which is the "set up a
     * project" case. `id` adopts an exact id: a reload that landed on a
     * thread the server never heard of, which is what an unsent draft looks
     * like from a fresh page.
     */
    startThreadIn(opts: { projectId?: string; id?: string } = {}): string | null {
      const project =
        (opts.projectId ? catalog.projects().find((p) => p.id === opts.projectId) : undefined) ??
        catalog.projects().find((p) => p.id === loadThreadDefaults().projectId) ??
        catalog.projects()[0]
      if (!project) return null
      const start = resolveThreadStart(project.defaults ?? emptyDefaults(), catalog.profiles())
      if (!start) return null
      return newDraftThread({ project, ...start, id: opts.id })
    },

    newDraftThread,

    /**
     * An aside: a new thread started from a passage selected in `parentId`,
     * on the parent's own (profile, agent, model, effort). A draft like any
     * other — nothing exists until the first send — with the passage already
     * quoted in its composer. The link and the flag ride the create.
     */
    startAside(parentId: string, quote: string): string | null {
      const parent = core.getState().sessions.find((s) => s.id === parentId)
      const project = catalog.projects().find((p) => p.id === parent?.projectId)
      const profile = catalog.profiles().find((p) => p.id === parent?.profileId)
      if (!parent || !project || !profile) return null
      const id = newDraftThread({
        project,
        profile,
        agentId: parent.agentId,
        model: parent.model,
        effort: parent.effort,
        aside: { of: parentId, quote },
      })
      saveDraft(id, quote.split("\n").map((line) => `> ${line}`).join("\n") + "\n\n")
      return id
    },

    /**
     * Find out what an agent can be configured with on a profile, once.
     *
     * The server answers by spawning one and killing it (see probe.ts), which
     * is the only way to ask — so this runs at most once per (profile, agent)
     * per page-load, and never when a live session has already told us. A
     * failure is still silent in the console sense, but it is no longer silent
     * on screen: the outcome is recorded (`markProbed`) so the menu can say
     * "asking", "that didn't work, try again" and "this agent offers nothing"
     * as the three different things they are. `force` is the try-again and the
     * menu's Refresh — it steps over the once-per-page-load guard *and* the
     * server's probe cache (`?refresh=1`), which otherwise answers the same
     * stale set for an upgraded binary or a changed login it cannot key on.
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
        }>(settings, `/api/profiles/${profileId}/options${force ? "?refresh=1" : ""}`, {
          method: "POST",
          body: JSON.stringify({ projectId, agentId }),
        })
        saveProbedOptions(key, {
          base: probed.configOptions ?? [],
          byModel: probed.byModel ?? {},
          ...(probed.modes ? { modes: probed.modes } : {}),
        }, force)
        markProbed(key, true)
      } catch (error) {
        console.warn(`Couldn't ask ${agentId} on ${profileId} what it supports`, error)
        markProbed(key, false)
      }
    },

    /** Pick an agent setting on a thread that does not exist yet, against the
        option set that agent last advertised. Held until session/new can
        apply it — see `createSession` — and remembered on the project, so the
        next thread in it opens the same way. */
    chooseDraftConfigOption(id: string, configId: string, value: string | boolean) {
      dispatch({ type: "draft-config-option", id, configId, value })
      publishConfigOption(id, configId, value)
    },

    /** Retune a thread that does not exist yet. Model and effort are env at
        spawn, so until the process starts they are ours to change freely.
        Every pick is also published to the thread's project — see `publish` —
        which is what makes the model a property of the workspace rather than
        of this device. */
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
          | "isolate"
        >
      >,
      /** Whether the pick is also published onto the project (`publish`).
          False for a caller whose controls are configuring something that is
          not the thread you are about to start — a routine's saved
          thread-start — where "the model this routine runs on" is a statement
          about the routine and must not rewrite what the next thread in that
          project opens on. Default on, which is the composer. */
      remember = true
    ) {
      /* Isolation is a question about one repository: a different project
         asks it again rather than inheriting a yes it may not be able to keep. */
      if (next.projectId !== undefined && next.isolate === undefined) next = { ...next, isolate: false }
      dispatch({ type: "configure-draft", id, next })
      /* The same rescope the reducer applies: a different agent or profile is a
         different set of settings, so the picks made against the old one must
         not come back with the row on the next reload. */
      const rescoped = next.agentId !== undefined || next.profileId !== undefined
      patchDraft(settings.id, id, {
        ...next,
        ...(rescoped ? { configChoices: undefined, modeId: undefined } : null),
      })
      const current = core.getState().sessions.find((s) => s.id === id)
      if (current && remember) publish(next, current)
    },
  }
}
