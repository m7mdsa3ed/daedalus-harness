/* Thread settings: profile, model, effort, persona, follow-ups, the staged
   change, the agent's own mode and config options — and the coalescing buffer
   that turns a menu's worth of picks into one request.

   Split out of the one 1500-line `useActions` memo; see `lib/actions.ts`. */

import type * as acp from "@daedalus/acp"
import { toast } from "../toast"
import { saveProjectDefaults } from "../project-defaults"
import { api, type Profile, type ProjectDefaults, type SessionMeta } from "../settings"
import type { ActionsCore } from "./core"

/* ── Thread settings: what one pick is, and how several become one request ──
   The menu writes into a per-thread buffer instead of POSTing; the buffer is
   sent when the menu closes, or when the user stops picking for this long.
   Module-level, like the thread registry and for the same reason: `useActions`
   re-memoizes, and a buffer that went with it would drop the picks made just
   before it did. */
const CONFIG_COALESCE_MS = 450

/* …and longer for a batch that moves the **profile**, because that pick is
   never the whole change: moving profile clears the model (the id names a model
   the new provider does not serve), so the model row underneath it has to be
   picked again — and at 450ms the two landed as two requests and two respawns,
   the second one seconds behind the first. The flush that matters is still the
   menu closing, which every surface that picks does explicitly; this is only
   the fallback for a menu left open, so it is set by how long it takes to read
   a model list rather than by how long a pause means "done". */
const CONFIG_PROFILE_COALESCE_MS = 3000

/** The fields `POST /api/sessions/:id/config` moves. Absent means unchanged;
    `""` is a real value everywhere it appears (no persona, the profile's
    default model, no effort). */
export type ConfigPatch = {
  profileId?: string
  model?: string
  effort?: string
  personaId?: string
  suggestFollowups?: boolean
  uiBlocks?: boolean
}

interface ConfigReply {
  live: boolean
  staged?: ConfigPatch
  restarting?: boolean
}

/** What became of a pick: taken on the running process, held for the turn's
    boundary, or paid for with a restart (following the server's events, or
    driven from here for a client with no socket to follow them on). */
type ConfigOutcome = "live" | "staged" | "restarting" | "restarted"

interface BufferedConfig {
  meta: SessionMeta
  patch: ConfigPatch
  context: string
  /** What to go back to — the row as it was before the first pick in this
      batch. See `changeThreadConfig`. */
  before: ConfigPatch
  timer: ReturnType<typeof setTimeout> | null
}

const configBuffer = new Map<string, BufferedConfig>()

/** The current value of every field a patch names — the Undo for it. Only the
    named fields: a patch that moved the model must not put back a persona
    nobody touched. */
function previousConfig(meta: SessionMeta, patch: ConfigPatch): ConfigPatch {
  return {
    ...(patch.profileId !== undefined ? { profileId: meta.profileId } : {}),
    ...(patch.model !== undefined ? { model: meta.model ?? "" } : {}),
    ...(patch.effort !== undefined ? { effort: meta.effort ?? "" } : {}),
    ...(patch.personaId !== undefined ? { personaId: meta.personaId ?? "" } : {}),
    ...(patch.suggestFollowups !== undefined
      ? { suggestFollowups: meta.suggestFollowups === true }
      : {}),
    ...(patch.uiBlocks !== undefined ? { uiBlocks: meta.uiBlocks !== false } : {}),
  }
}

/** One line naming what a pick changed — used by the composer footer's
    `ConfigIndicator` and by the restart toast's description. Ids are resolved
    against the profile catalog where they have a name there; a persona is named
    by the fact it moved, because the catalog that holds its name is not one
    this module reads. */
export function describeConfig(patch: ConfigPatch, profiles: Profile[]): string {
  const parts: string[] = []
  if (patch.profileId !== undefined) {
    parts.push(`Profile: ${profiles.find((p) => p.id === patch.profileId)?.name ?? patch.profileId}`)
  }
  if (patch.model !== undefined) {
    const label = profiles
      .flatMap((p) => p.models)
      .find((m) => m.id === patch.model)?.label
    parts.push(`Model: ${label ?? (patch.model || "profile default")}`)
  }
  if (patch.effort !== undefined) parts.push(`Effort: ${patch.effort || "default"}`)
  if (patch.personaId !== undefined) {
    parts.push(patch.personaId ? "Persona changed" : "Persona cleared")
  }
  if (patch.suggestFollowups !== undefined) {
    parts.push(patch.suggestFollowups ? "Follow-ups on" : "Follow-ups off")
  }
  if (patch.uiBlocks !== undefined) {
    parts.push(patch.uiBlocks ? "Drawn UI on" : "Drawn UI off")
  }
  return parts.join(" · ")
}

export function configActions(core: ActionsCore) {
  const { settings, dispatch, getState, catalog, queryClient, threads, recordError, known, refreshSessions } =
    core

  /**
   * Publish a spawn-setting pick onto the project the thread runs in, so the
   * next thread started there opens the same way.
   *
   * The project's start defaults are what a *draft* in it opens on, and a
   * change made to a running thread is the same statement one message later:
   * "this is how I work in this codebase". It used to be remembered on the
   * device (`thread-defaults`), which is no scope for a fact about a workspace
   * — another machine started the next thread in the working directory on the
   * agent's defaults.
   *
   * Only `next`'s own keys are published, and a profile move carries the model
   * and effort it clears: `changeProfile` sends all three together, and a
   * project left holding a model its profile does not serve would hand the
   * next draft a value the menu cannot draw. A *live* pick that the server
   * takes on the running process is published all the same — the row is what
   * the draft reads, and where the change landed (live, staged, restarted) is
   * the server's answer about the process, not about the project.
   */
  const publishToProject = (meta: SessionMeta, next: ConfigPatch) => {
    if (!meta.projectId) return
    const patch: Partial<ProjectDefaults> = {}
    if (next.profileId !== undefined) patch.profileId = next.profileId
    if (next.model !== undefined) patch.model = next.model
    if (next.effort !== undefined) patch.effort = next.effort
    if (next.personaId !== undefined) patch.personaId = next.personaId
    if (next.suggestFollowups !== undefined) patch.suggestFollowups = next.suggestFollowups
    if (next.uiBlocks !== undefined) patch.uiBlocks = next.uiBlocks
    if (Object.keys(patch).length > 0) {
      saveProjectDefaults(settings, queryClient, meta.projectId, patch)
    }
  }

  /**
   * Change a thread's profile, model or effort — and let the server say what
   * that costs.
   *
   * All three are placed by the agent's env at spawn, and all three used to
   * mean the same thing here: kill the process, spawn another, put the
   * conversation back. They do not any more. The endpoint and the credential
   * live behind the harness's own gateway URL, which names the *thread*, and
   * the model is either the agent's own selector or another rewrite on the
   * same wire — so the common case is one request that changes nothing
   * anybody can see. See CLAUDE.md.
   *
   * Which case it is cannot be known from here: it depends on the agent, on
   * whether the thread is behind the shim at all, and on whether the running
   * process will take the model. So the route decides, and it has three
   * answers rather than two — taken live, **held for the running turn's
   * boundary** (`staged`), or paid for with a restart. Only the third needs
   * anything of this device, and usually not even that: the restart runs
   * server-side and reports itself through the `restart` event, which is what
   * rebuilds the transcript. The one case this call still drives itself is a
   * client with no attached socket, which has no way to hear those events and
   * says so with `follow: false`.
   *
   * The buffering, the optimism and the undo are `changeThreadConfig`'s, one
   * layer up. This is the request.
   */
  const sendThreadConfig = async (
    meta: SessionMeta,
    next: ConfigPatch,
    context: string,
    opts: { defer?: false } = {}
  ): Promise<ConfigOutcome> => {
    const conn = threads.for(meta.id)
    let reply: ConfigReply
    try {
      reply = await api<ConfigReply>(settings, `/api/sessions/${meta.id}/config`, {
        method: "POST",
        body: JSON.stringify({
          profileId: next.profileId ?? meta.profileId,
          agentId: meta.agentId,
          model: next.model ?? meta.model ?? undefined,
          effort: next.effort ?? meta.effort ?? undefined,
          /* Deliberately not `?? meta.personaId`: sending the current value
             back would be indistinguishable from asking for it, and the
             server reads a *changed* persona as "apply its effort too". Only
             a real pick travels. */
          personaId: next.personaId,
          /* Unlike the persona, a boolean has no "unchanged" sentinel of its
             own — so only a real flip travels, and the server's respawn
             answers for every peer. */
          suggestFollowups: next.suggestFollowups,
          // Same as the trailer above: a boolean has no "unchanged" sentinel,
          // so only a real flip travels.
          uiBlocks: next.uiBlocks,
          /* "Now, and never mind the running turn" — the only thing that
             stops the server holding a process-costing change for the turn's
             own boundary. Sent by the menu's Apply now and by nothing else. */
          ...(opts.defer === false ? { defer: false } : {}),
          /* Whether this device is in a position to hear the `restart` events
             and rebuild off them. A client with no attached socket is not, so
             it asks the server to finish the restart before answering and
             drives the reattach itself below — one honest question, instead
             of a race between a backgrounded respawn and a client reading the
             journal it is clearing. */
          follow: conn.live?.connected === true,
        }),
      })
    } catch (error) {
      // The pick did not land, so the menu must stop claiming it did.
      dispatch({ type: "pending-config", id: meta.id, patch: null })
      recordError(meta.id, error, context)
      throw error
    }
    if (reply.staged) {
      /* Held for the next spawn — which for an idle thread is the next send,
         and is now the ordinary answer rather than the mid-turn exception.
         The `staged_config` event says the same to every peer including this
         one, but only over a socket — so it is applied from the answer as
         well, and the overlay that was standing in for it goes at the same
         time. */
      dispatch({ type: "staged-config", id: meta.id, config: reply.staged })
      dispatch({ type: "pending-config", id: meta.id, patch: null })
      return "staged"
    }
    /* Answered before the restart has happened, so there is nothing new for a
       list refresh to read — and the row it *would* read is the one being
       left. Return before paying for it. */
    if (reply.restarting) return "restarting"
    const listed = await refreshSessions()
    if (reply.live) {
      /* `spawn_config` clears the overlay for every peer; this covers the one
         case it cannot — a change made from a device with no socket on the
         thread, which will never see the event. */
      dispatch({ type: "pending-config", id: meta.id, patch: null })
      return "live"
    }
    /* The restart has already happened: this device had no socket to report
       it on, so the server finished before answering, and the reattach is
       this call's job — the event log was cleared, so the saved cursor is
       past its end and the thread has to be attached again from 0. `forgetJournal` drops the socket and the cursor
       with it, which is what makes the open below a clean rebuild. */
    conn.forgetJournal()
    /* …and the rebuild is a restart, so say that before the open says the
       read: without this the phase falls to `idle` and the whole respawn
       reads as a plain "Reading this conversation…". */
    conn.markReviving()
    try {
      /* Through the connection's own open chain, for the reason
         `createSession` is: the refresh above re-fires the panel's open, and
         two of them on one session are two peers folding the same events into
         the store. The row comes from what the refresh fetched because the
         respawn changed it — and for the reason `createSession` says: a
         `getState()` here would answer with the row as it was before the
         refresh landed. */
      const respawned = listed.find((session) => session.id === meta.id) ?? meta
      /* …and as a revive, not a read: the new process is already up, so the
         open attaches a socket rather than stopping at the document. Without
         this the thread ended in `read` — no live connection, and the
         `reviving` phase above never resolved into the replay/connecting
         lines that say what is happening. Seamless, because there is a
         transcript on screen and it is a correct one. */
      await conn.open(respawned, { revive: true, seamless: true })
    } catch (error) {
      // The old process is gone by now, so a failure here leaves a thread
      // that needs reviving — say that, in the thread.
      recordError(meta.id, error, context)
      throw error
    } finally {
      dispatch({ type: "pending-config", id: meta.id, patch: null })
    }
    return "restarted"
  }

  /**
   * A pick from the settings menu: shown at once, sent once.
   *
   * Two things happen before the network is touched. The patch is **overlaid
   * on the thread** (`pending-config`), so the row and the composer chip read
   * the new value from the instant it is picked rather than when the server
   * gets round to saying so — which for a change that costs the process is
   * after a spawn and a `session/load`. And it is **buffered**: picking a
   * model and then its effort is two picks a second apart, and each one used
   * to be its own POST and its own respawn, the second queued behind the
   * first. They are one request now, sent when the menu closes
   * (`flushThreadConfig`) or when the user stops picking.
   *
   * What it does NOT do is ask first. Every one of these is reversible — the
   * conversation comes back through `session/load`, and the toast that
   * follows a restart carries an Undo — and the one genuinely destructive
   * case, a change that would kill a running turn, is not destructive any
   * more: the server holds it for the turn's own boundary.
   */
  const changeThreadConfig = (meta: SessionMeta, next: ConfigPatch, context: string): void => {
    dispatch({ type: "pending-config", id: meta.id, patch: next })
    /* Remembered for the project, not only for the thread — see
       `publishToProject`. Done at the pick rather than once the server has
       answered: a pick the server stages is still the way this workspace is
       worked, and waiting for a spawn that may never come (nobody sends again)
       would leave the project holding the old value. */
    publishToProject(meta, next)
    const held = configBuffer.get(meta.id)
    if (held?.timer) clearTimeout(held.timer)
    const patch: ConfigPatch = { ...(held?.patch ?? {}), ...next }
    /* What the thread was on before the *first* pick in this batch — the
       Undo, and it must not be re-read per pick or a second pick would record
       the first one's result as the thing to go back to. */
    const before = held?.before ?? previousConfig(meta, patch)
    const timer = setTimeout(
      () => void flushThreadConfig(meta.id),
      patch.profileId !== undefined ? CONFIG_PROFILE_COALESCE_MS : CONFIG_COALESCE_MS
    )
    configBuffer.set(meta.id, { meta, patch, context, before, timer })
  }

  /**
   * Send whatever is buffered for a thread, now.
   *
   * Called when the settings menu closes — the moment the user is done
   * picking — and by the debounce above for the menu that stays open. Safe to
   * call with nothing buffered, which is most of the times a menu closes.
   *
   * `silent` is the send path's: a pick made a moment before Enter is flushed
   * by the send itself (`send`, below), and a toast saying when the change
   * will apply is noise on top of the message that is applying it.
   */
  const flushThreadConfig = async (
    sessionId: string,
    opts: { silent?: boolean } = {}
  ): Promise<void> => {
    const held = configBuffer.get(sessionId)
    if (!held) return
    if (held.timer) clearTimeout(held.timer)
    configBuffer.delete(sessionId)
    /* Swallowed, not propagated: this is called from a timer and from a menu
       closing, neither of which has anywhere to put a rejection — and the
       failure is already in the thread, which is where a failure belonging to
       a thread goes (lib/errors.ts). */
    let outcome: ConfigOutcome
    try {
      outcome = await sendThreadConfig(held.meta, held.patch, held.context)
    } catch {
      return
    }
    if (outcome === "staged") {
      if (opts.silent) return
      /* The composer footer's `ConfigIndicator` carries the same sentence —
         `composer-status.tsx`, which calls `describeConfig` too — and the
         cancel in its popover is the only affordance. A change that costs the
         process is spent by the next spawn, and for a thread nobody is
         sending to that is no spawn at all, so nothing to offer, and the
         toast that used to live here was the one extra path that would force
         one. */
      return
    }
    /* An Undo, and only where one is worth offering: a change that cost the
       process. A live change is instant and already drawn in the menu that
       made it, and a toast per model pick would be noise on the one path that
       never surprised anyone. */
    if (outcome === "restarting" || outcome === "restarted") {
      toast("Restarting the agent", {
        description: describeConfig(held.patch, catalog.profiles()),
        action: {
          label: "Undo",
          onClick: () => changeThreadConfig(held.meta, held.before, held.context),
        },
      })
    }
  }

  return {
    /**
     * Change a thread's profile, model or effort — and let the server say
     * what that costs.
     *
     * All three are placed by the agent's env at spawn, and all three used to
     * mean the same thing here: kill the process, spawn another, put the
     * conversation back. They do not any more. The endpoint and the
     * credential live behind the harness's own gateway URL, which names the
     * *thread*, and the model is either the agent's own selector or another
     * rewrite on the same wire — so the common case is now one request that
     * changes nothing anybody can see. See CLAUDE.md.
     *
     * Which case it is, is not knowable from here: it depends on the agent,
     * on whether the thread is behind the shim, and on whether the running
     * process will take the model. So the route decides and answers `live`,
     * and only the falsy answer does the reconnect dance — a live change
     * arrives back as a `spawn_config` event on the socket that is already
     * open, on this device and every other.
     *
     * Nothing here is awaited any more: the pick is drawn immediately, the
     * request goes out when the picking stops, and everything after that is
     * the server's events. A caller that needs to know when it landed is
     * asking the wrong question — the thread says.
     */
    changeThreadConfig,

    /** Send what is buffered for a thread now — what the settings menu calls
        as it closes. See `changeThreadConfig`. */
    flushThreadConfig,

    /**
     * Move a thread onto a different profile: different credentials, base URL
     * and model catalog.
     *
     * Model and effort are deliberately NOT carried over. They name a model in
     * the profile being left, which the profile being joined may not serve at
     * all, so the new profile's own default is the honest starting point —
     * and the server is what resolves "none" into it.
     */
    changeProfile(meta: SessionMeta, profileId: string): void {
      // Same agent, new provider: the menu only offers profiles that serve
      // this thread's agent, and the server refuses one that does not.
      changeThreadConfig(
        meta,
        { profileId, model: "", effort: "" },
        "Couldn't move this thread to that profile"
      )
    },

    /** Change the model or reasoning effort of a thread whose profile carries
        its own model catalog. */
    changeSpawnConfig(meta: SessionMeta, next: { model?: string; effort?: string }): void {
      changeThreadConfig(meta, next, "Couldn't change this thread's model")
    },

    /**
     * Change how this thread is worked on.
     *
     * Always costs the process — no runtime we ship will take a persona on a
     * running one — so this always comes back `staged`, whether or not a turn
     * is running: the next spawn is the next moment any runtime would read
     * it. `""` is a real value and means no persona; model and profile are
     * left alone, because a persona says nothing about either.
     */
    changeThreadPersona(meta: SessionMeta, personaId: string): void {
      changeThreadConfig(meta, { personaId }, "Couldn't change how this thread works")
    },

    /**
     * Flip whether answers close with follow-up prompt suggestions.
     *
     * Same spawn-text bargain as the persona, and the same staging: the
     * trailer is read at `session/new`/`session/load` and nowhere else.
     */
    changeThreadSuggestions(meta: SessionMeta, suggestFollowups: boolean): void {
      changeThreadConfig(
        meta,
        { suggestFollowups },
        "Couldn't change this thread's suggestions"
      )
    },

    /**
     * Flip whether answers may carry a drawn view (`openui-lang`).
     *
     * The identical bargain to the suggestions trailer above: the lane is
     * system-prompt text, read at `session/new`/`session/load` and nowhere
     * else, so this costs a respawn and the server stages it like a persona.
     */
    changeThreadUiBlocks(meta: SessionMeta, uiBlocks: boolean): void {
      changeThreadConfig(meta, { uiBlocks }, "Couldn't change this thread's drawn UI")
    },

    /** Drop the staged change. The server answers every peer with
        `staged_config`, so nothing here has to guess what the menus should
        now draw. */
    async cancelStagedConfig(sessionId: string) {
      try {
        await api(settings, `/api/sessions/${sessionId}/config`, {
          method: "POST",
          body: JSON.stringify({ cancelStaged: true }),
        })
        dispatch({ type: "staged-config", id: sessionId, config: null })
      } catch (error) {
        recordError(sessionId, error, "Couldn't cancel that settings change")
        throw error
      }
    },

    /**
     * A mode or an agent option, on the running process.
     *
     * Optimistic, and *actually* optimistic: the control moves on the pick
     * and the round trip happens behind it. It used to dispatch after the
     * await, which for a menu row a person has just clicked is a control that
     * sits on the old value for as long as the agent takes to answer. A
     * rejection has to be loud for the same reason — the value snaps back,
     * and nothing else would say why.
     */
    async setMode(sessionId: string, modeId: string) {
      const previous = getState().threads[sessionId]?.modes?.currentModeId
      dispatch({ type: "mode", id: sessionId, modeId })
      try {
        await known(sessionId)?.live?.setMode(modeId)
      } catch (error) {
        if (previous) dispatch({ type: "mode", id: sessionId, modeId: previous })
        recordError(sessionId, error, "The agent rejected that mode")
        throw error
      }
    },

    async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
      // Read the category first: the response replaces the whole option set,
      // and the category is what says whether this pick is also spawn state.
      const options = getState().threads[sessionId]?.configOptions ?? []
      const category = options.find((option) => option.id === configId)?.category
      /* Moved first and put back on a refusal. The agent answers with the
         whole option set — which is what finally lands — but that answer is a
         round trip away, and the row the user clicked has to move now. */
      dispatch({
        type: "config-options",
        id: sessionId,
        configOptions: options.map((option) =>
          option.id === configId
            ? ({ ...option, currentValue: value } as acp.SessionConfigOption)
            : option
        ),
      })
      try {
        const configOptions = await known(sessionId)?.live?.setConfigOption(configId, value)
        if (configOptions) dispatch({ type: "config-options", id: sessionId, configOptions })
      } catch (error) {
        dispatch({ type: "config-options", id: sessionId, configOptions: options })
        recordError(sessionId, error, `The agent rejected that ${configId} setting`)
        throw error
      }
      /* Model and effort are also process env: the server rebuilds them from
         the session record every time it revives a retired thread. It records
         the change itself now (it knows the option's category), so all that is
         left here is to re-read the list this thread's row appears in. */
      if (category === "model" || category === "thought_level") await refreshSessions()
    },
  }
}
