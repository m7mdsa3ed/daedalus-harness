/* A thread before it exists: minting the draft, retuning it, and the one-shot
   probe that tells a draft's menus what the agent can be configured with.

   Split out of the one 1500-line `useActions` memo; see `lib/actions.ts`. */

import type * as acp from "@daedalus/acp"
import { uuid } from "../uuid"
import {
  alreadyAsked,
  freshAgentOptions,
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
import { api, inSpace, profileAgentIds, type Profile, type Project, type SessionMeta } from "../settings"
import { emptyThread } from "../store"
import { loadActiveSpace } from "../spaces"
import { patchDraft, rememberDraft } from "../draft-sessions"
import { saveDraft, loadDraft } from "../drafts"
import { appMetaQuery } from "../queries/surfaces"
import { cancelPrewarm as cancelWarm, schedulePrewarm } from "../prewarm"
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
   * - `modeId`, `configChoices` and `helperModels` are written only for the
   *   project the draft was **already** on. Re-pointing a draft at another
   *   project moves the provider state but not the agent's own selectors: those
   *   name the option set of the agent that was in front of the menu (and the
   *   helper models name ids in the old profile's catalog), and handing them to
   *   a project whose agent may differ is the same rescope the
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
    const copy = <K extends "profileId" | "agentId" | "model" | "effort">(key: K) => {
      const value = next[key]
      if (value !== undefined) patch[key] = value
    }
    copy("profileId")
    copy("agentId")
    copy("model")
    copy("effort")
    if (next.suggestKinds !== undefined) patch.suggestKinds = next.suggestKinds
    if (next.uiGroups !== undefined) patch.uiGroups = next.uiGroups
    if (next.personaId !== undefined) patch.personaId = next.personaId ?? ""
    if (next.askProfiles !== undefined) patch.askProfiles = next.askProfiles
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
        patch.helperModels = []
      } else {
        if (next.modeId !== undefined) patch.modeId = next.modeId
        if (next.configChoices !== undefined) patch.configChoices = next.configChoices
        if (next.helperModels !== undefined) patch.helperModels = next.helperModels
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
    /** Start it on a board task (`sessions.taskId`). */
    taskId?: string
  }): string => {
    const { project, profile, model, effort } = opts
    const id = opts.id ?? uuid()
    /* The project's start defaults, which `resolveThreadStart` has already
       resolved the (profile, agent) pair against — the caller passes the
       model/effort that survived that resolution. The other fields are the
       row's, read here so a reload that re-adopts an unsent draft gets its
       tools and its mode back along with its profile. */
    const defaults = project.defaults ?? emptyDefaults()
    const tools = defaultToolPicks(defaults)
    const session: SessionMeta = {
      id,
      profileId: profile.id,
      projectId: project.id,
      agentId: opts.agentId ?? profileAgentIds(profile)[0] ?? "",
      model: model ?? "",
      effort: effort ?? "",
      suggestKinds: defaults.suggestKinds,
      uiGroups: defaults.uiGroups,
      personaId: defaults.personaId || null,
      askProfiles: defaults.askProfiles,
      /* The picks against the agent's advertised selectors, and the permission
         mode, are the project's too — they are what the menu there showed. An
         empty set is what a project nobody has configured holds, and
         `createSession` replays exactly what the menu drew. */
      configChoices: defaults.configChoices,
      helperModels: defaults.helperModels,
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
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
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
    startThreadIn(opts: { projectId?: string; id?: string; taskId?: string; text?: string } = {}): string | null {
      /* A caller that names a project gets it; the fallbacks stay inside the
         space in front of you, then anywhere rather than nowhere. */
      const space = loadActiveSpace(settings.id)
      const all = catalog.projects()
      const inActive = space ? all.filter((p) => inSpace(p, space)) : all
      const project =
        (opts.projectId ? all.find((p) => p.id === opts.projectId) : undefined) ??
        inActive.find((p) => p.id === loadThreadDefaults().projectId) ??
        inActive[0] ??
        all[0]
      if (!project) return null
      const start = resolveThreadStart(project.defaults ?? emptyDefaults(), catalog.profiles())
      if (!start) return null
      const id = newDraftThread({ project, ...start, id: opts.id, taskId: opts.taskId })
      // Words the person can send as they are, or change first.
      if (opts.text) saveDraft(id, opts.text)
      return id
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
      if (!force && (alreadyAsked(key) || freshAgentOptions(key))) return
      // Re-asking over a stale set answers for the whole set, like a refresh.
      const replace = force || loadAgentOptions(key).base.length > 0
      markAsked(key)
      try {
        const probed = await api<{
          configOptions: acp.SessionConfigOption[]
          byModel: AgentOptionSet["byModel"]
          modes?: acp.SessionModeState | null
          commands?: acp.AvailableCommand[]
          expiresAt?: number | null
        }>(settings, `/api/profiles/${profileId}/options${force ? "?refresh=1" : ""}`, {
          method: "POST",
          body: JSON.stringify({ projectId, agentId }),
        })
        saveProbedOptions(key, {
          base: probed.configOptions ?? [],
          byModel: probed.byModel ?? {},
          ...(probed.modes ? { modes: probed.modes } : {}),
          ...(probed.commands ? { commands: probed.commands } : {}),
          expiresAt: probed.expiresAt ?? null,
        }, replace)
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
          | "suggestKinds"
          | "uiGroups"
          | "personaId"
          | "askProfiles"
          | "helperModels"
          | "configChoices"
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
      /* Moving a draft to another project takes that project's saved config
         with it — pair, model, effort, mode, the agent's selectors, tools and
         toggles — because the project is the scope those were picked in.
         Nothing is written back: this is a read of the target row, so the
         publish below is skipped for the move itself. */
      const before = core.getState().sessions.find((s) => s.id === id)
      const moved = next.projectId !== undefined && next.projectId !== before?.projectId
      if (moved) {
        saveThreadDefaults({ projectId: next.projectId })
        const target = catalog.projects().find((p) => p.id === next.projectId)
        const d = target?.defaults ?? emptyDefaults()
        const start = target && resolveThreadStart(d, catalog.profiles())
        if (start) {
          /* The selectors name the option set of the pair the project named; a
             fallback pair has never heard of them (see `resolveThreadStart`). */
          const named = start.profile.id === d.profileId && start.agentId === d.agentId
          next = {
            ...next,
            profileId: start.profile.id,
            agentId: start.agentId,
            model: start.model ?? "",
            effort: start.effort ?? "",
            modeId: named ? d.modeId || undefined : undefined,
            configChoices: named ? d.configChoices : {},
            helperModels: named ? d.helperModels : [],
            suggestKinds: d.suggestKinds,
            uiGroups: d.uiGroups,
            personaId: d.personaId || null,
            askProfiles: d.askProfiles,
            ...defaultToolPicks(d),
          }
          remember = false
        }
      }
      dispatch({ type: "configure-draft", id, next })
      /* The same rescope the reducer applies: a different agent or profile is a
         different set of settings, so the picks made against the old one must
         not come back with the row on the next reload. */
      const rescoped = next.agentId !== undefined || next.profileId !== undefined
      patchDraft(settings.id, id, {
        ...(rescoped ? { configChoices: undefined, modeId: undefined, helperModels: undefined } : null),
        ...next,
      })
      const current = core.getState().sessions.find((s) => s.id === id)
      if (current && remember) publish(next, current)
      /* A pick here can make the warm process a different one — so it stops
         answering for this draft, and the next keystroke asks again. See
         `dropsSpawn` for which picks and why. An agent or profile change
         always is one; model and effort only where the profile owns a
         catalog, which is the only case the server puts them in the spawn.
         Read off the patch and the row as it stood, never off `getState`: the
         store is written in a layout effect, so a read here is the row from
         *before* this dispatch. */
      const profileId = next.profileId ?? before?.profileId
      const ownsCatalog = (catalog.profiles().find((p) => p.id === profileId)?.models.length ?? 0) > 0
      if (dropsSpawn(next, ownsCatalog)) cancelWarm(settings, id)
    },

    /** Ask for this draft's agent process early, so its first message resumes
        at `session/new` instead of paying the whole cold start with the words
        already written (`docs/plans/prewarm.md`). Called from a debounced
        keystroke, never from a render and never from page load: an untyped
        draft must spawn nothing, and a New tab page is opened and abandoned far
        more often than it is typed in.
     *
     * **The draft still creates nothing.** No row, no journal, no prompt, not
     * one token: the server spawns a process, waits for `initialize` and holds
     * it for this id (`server/src/prewarm.ts`). `send` is untouched by any of
     * it — `createSession` claims the process if its spawn still matches and
     * spawns cold if it does not, so a send works identically whether the
     * prewarm happened, is still in flight, or failed.
     *
     * Every refusal below is silent, and so is every failure: the only
     * observable of a prewarm that did not happen is a send as slow as it
     * always was. */
    prewarmDraft(id: string) {
      const draft = core.getState().sessions.find((s) => s.id === id)
      /* Sent is not warmable: `create` has the id, and a second process for it
         would be work the claim refuses. */
      if (!draft?.draft) return
      if (!draft.profileId || !draft.projectId) return
      /* An older server has the route or it does not, and it says so by name
         (`FEATURES`, `server/src/compat.ts`). `ensureQueryData` rather than a
         plain cache read: nothing else on a fresh page fetches `/api/meta`
         before the first keystroke, so a cache-only test would answer "no" to
         every server on the one screen a draft is typed into. It is one request
         and then cached for five minutes, and the decision is made inside the
         debounced fire so a keystroke never waits on it. Absent from the answer
         reads as "no", which costs a warm process and never a wrong one — the
         send is unaffected either way. */
      schedulePrewarm(id, () => {
        /* Everything is re-read at the moment it fires, the words included: the
           box hands its text to `saveDraft` from an effect, so a read on the
           keystroke that scheduled this would be a character behind — typing
           one letter and stopping would ask for nothing. 400ms is long enough
           for the draft to have been sent, emptied or retuned too, and the picks
           travel *now*, because the process is spawned on them. */
        const now = core.getState().sessions.find((s) => s.id === id)
        if (!now?.draft || !loadDraft(id).trim()) return
        void queryClient
          .ensureQueryData(appMetaQuery(settings))
          .then((meta) => {
            if (!meta.features?.includes("draftPrewarm")) return
            /* Asked again, after the await: a draft sent or deleted while the
               meta was in flight has an id `create` already owns. */
            const latest = core.getState().sessions.find((s) => s.id === id)
            if (!latest?.draft || !loadDraft(id).trim()) return
            return api<{ ok: boolean }>(settings, "/api/prewarm", {
              method: "POST",
              body: JSON.stringify({
                id,
                profileId: latest.profileId,
                agentId: latest.agentId,
                projectId: latest.projectId,
                model: latest.model,
                effort: latest.effort,
                helperModels: latest.helperModels ?? [],
              }),
            })
          })
          .catch((error) => {
            /* A failed prewarm is not a failed keystroke: the send that follows
               spawns cold, exactly as it does on a server that cannot warm. */
            console.warn("Couldn't prewarm this draft", error)
          })
      })
    },

    /** Forget a draft's warm process: the box was emptied, the tab closed, or
        the draft was deleted. Best effort and never awaited — the server's TTL
        and cap are the guarantee, and this is promptness. A no-op for a thread
        the server knows, whose process belongs to a row and is its own. */
    cancelPrewarm(id: string) {
      const draft = core.getState().sessions.find((s) => s.id === id)
      if (!draft?.draft) return
      cancelWarm(settings, id)
    },
  }
}

/**
 * Whether this pick makes the process a different one — the kill rule
 * (`docs/plans/prewarm.md`, "What kills a warm process").
 *
 * A warm process is only ever handed to a thread whose spawn it still matches,
 * so this is never a correctness fix: it is what stops a process nobody will
 * claim from sitting under the cap until the TTL. The list is therefore the
 * picks that are **env at spawn**, and nothing else.
 *
 * - Profile, agent, project: a different base URL, binary and cwd.
 * - Model and effort: only where the profile owns a catalog, because that is
 *   the only case `resolveAgentSpawn` puts them in the env (`prewarm.ts` makes
 *   the same call). Otherwise they are placed at `session/new`.
 * - Persona, mode, config options, the tool picks and the text are *not* here:
 *   they are read at `session/new` or applied after it, so the process the
 *   draft already has is the one it needs.
 */
function dropsSpawn(next: Partial<SessionMeta>, ownsCatalog: boolean): boolean {
  if (next.profileId !== undefined || next.agentId !== undefined || next.projectId !== undefined) {
    return true
  }
  return ownsCatalog && (next.model !== undefined || next.effort !== undefined)
}
