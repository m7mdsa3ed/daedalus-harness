/* Thread settings: profile, model, effort, follow-ups, the staged
   change, the agent's own mode and config options — and the coalescing buffer
   that turns a menu's worth of picks into one request.

   Split out of the one 1500-line `useActions` memo; see `lib/actions.ts`. */

import type * as acp from "@daedalus/acp"
import { toast } from "../toast"
import { saveProjectDefaults } from "../project-defaults"
import { api, type Persona, type Profile, type ProjectDefaults, type SessionMeta } from "../settings"
import { currentChoiceLabel } from "../session-options"
import type { ThreadState } from "../store"
import type { ActionsCore } from "./core"
import { DEFAULT_SUGGEST_KINDS, SUGGEST_KINDS } from "../suggestions"
import { DEFAULT_UI_GROUPS, UI_GROUPS } from "../openui/groups"

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
    `""` is a real value everywhere it appears (the profile's
    default model, no effort). */
export type ConfigPatch = {
  profileId?: string
  model?: string
  effort?: string
  suggestKinds?: string[]
  /** Which component groups the drawn-view lane teaches; a set travels whole,
      and empty is drawn answers off. */
  uiGroups?: string[]
  /** The thread's persona; null = none. Spawn text, so a change costs a respawn. */
  personaId?: string | null
  /** The thread's role→model helper map (docs/model-roles.md) — a spawn input
      like `model`/`effort`, so a change costs a respawn and the server stages
      it against the running turn's boundary. */
  helperModels?: { role: string; model: string }[]
  /** The agent's own selectors — a staged pick is the only place these travel
      as a patch; they are never a field of the session row. */
  modeId?: string
  options?: Record<string, string | boolean>
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
    named fields: a patch that moved the model must not put back a setting
    nobody touched. */
function previousConfig(meta: SessionMeta, patch: ConfigPatch): ConfigPatch {
  return {
    ...(patch.profileId !== undefined ? { profileId: meta.profileId } : {}),
    ...(patch.model !== undefined ? { model: meta.model ?? "" } : {}),
    ...(patch.effort !== undefined ? { effort: meta.effort ?? "" } : {}),
    ...(patch.suggestKinds !== undefined
      ? { suggestKinds: meta.suggestKinds ?? [...DEFAULT_SUGGEST_KINDS] }
      : {}),
    ...(patch.uiGroups !== undefined ? { uiGroups: meta.uiGroups ?? [...DEFAULT_UI_GROUPS] } : {}),
    ...(patch.personaId !== undefined ? { personaId: meta.personaId ?? null } : {}),
    ...(patch.helperModels !== undefined ? { helperModels: meta.helperModels ?? [] } : {}),
  }
}

/** Which setting a row of a staged change is about — what its glyph is drawn
    from. The reader never matches on a label: labels are the agent's words for
    its own options and change with the runtime. */
export type ConfigChangeKind =
  | "profile"
  | "model"
  | "effort"
  | "suggestions"
  | "ui"
  | "persona"
  | "helpers"
  | "mode"
  | "option"

/** One setting a pick moved, as a row worth drawing: the setting's name, the
    value it is being moved to, and which household it belongs to. */
export type ConfigChange = {
  kind: ConfigChangeKind
  label: string
  value: string
  /** How it reads in a sentence, when that is not `label: value` — "Suggestions
      off" and "Suggestions: a, b" are both things nobody writes as a pair. */
  sentence?: string
}

/** What a pick changed, one row per setting. The transcript draws these as
    tiles and `describeConfig` renders them as a line, so the two can never say
    different things. Ids are resolved against the profile catalog where they
    have a name there. */
export function configChanges(
  patch: ConfigPatch,
  profiles: Profile[],
  /** What names a mode or an option — the agent's own list, which this module
      does not otherwise read. Without it an id stands in for its name. */
  thread?: ThreadState,
  /** What names a persona id; without it the id stands in. */
  personas?: Persona[]
): ConfigChange[] {
  const rows: ConfigChange[] = []
  if (patch.profileId !== undefined) {
    const name = profiles.find((p) => p.id === patch.profileId)?.name ?? patch.profileId
    rows.push({ kind: "profile", label: "Profile", value: name })
  }
  if (patch.model !== undefined) {
    const label = profiles.flatMap((p) => p.models).find((m) => m.id === patch.model)?.label
    rows.push({ kind: "model", label: "Model", value: label ?? (patch.model || "profile default") })
  }
  if (patch.effort !== undefined) {
    rows.push({ kind: "effort", label: "Effort", value: patch.effort || "default" })
  }
  if (patch.suggestKinds !== undefined) {
    const labels = SUGGEST_KINDS.filter((kind) => patch.suggestKinds?.includes(kind.id)).map((kind) => kind.label)
    rows.push({
      kind: "suggestions",
      label: "Suggestions",
      value: labels.length > 0 ? "on" : "off",
      sentence: labels.length > 0 ? `Suggestions: ${labels.join(", ")}` : "Suggestions off",
    })
  }
  if (patch.uiGroups !== undefined) {
    rows.push({
      kind: "ui",
      label: "Drawn UI",
      value: patch.uiGroups.length === 0 ? "off" : `${patch.uiGroups.length} of ${UI_GROUPS.length} groups`,
      sentence:
        patch.uiGroups.length === 0
          ? "Drawn UI off"
          : `Drawn UI: ${patch.uiGroups.length} of ${UI_GROUPS.length} groups`,
    })
  }
  if (patch.personaId !== undefined) {
    const name = patch.personaId ? (personas?.find((p) => p.id === patch.personaId)?.name ?? patch.personaId) : "none"
    rows.push({ kind: "persona", label: "Persona", value: name })
  }
  if (patch.helperModels !== undefined) {
    const named = patch.helperModels.map((h) => h.role).join(", ")
    rows.push({ kind: "helpers", label: "Helper models", value: named || "none" })
  }
  if (patch.modeId !== undefined) {
    const mode = thread?.modes?.availableModes.find((m) => m.id === patch.modeId)
    rows.push({ kind: "mode", label: "Mode", value: mode?.name ?? patch.modeId })
  }
  for (const [id, value] of Object.entries(patch.options ?? {})) {
    const option = thread?.configOptions.find((o) => o.id === id)
    const named = option ? currentChoiceLabel({ ...option, currentValue: value } as acp.SessionConfigOption) : String(value)
    rows.push({ kind: "option", label: option?.name ?? id, value: named })
  }
  return rows
}

/** One line naming what a pick changed — used by the transcript's
    `PendingSettings` and by the restart toast's description. */
export function describeConfig(
  patch: ConfigPatch,
  profiles: Profile[],
  thread?: ThreadState,
  personas?: Persona[]
): string {
  return configChanges(patch, profiles, thread, personas)
    .map((change) => change.sentence ?? `${change.label}: ${change.value}`)
    .join(" · ")
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
    if (next.suggestKinds !== undefined) patch.suggestKinds = next.suggestKinds
    if (next.uiGroups !== undefined) patch.uiGroups = next.uiGroups
    if (next.personaId !== undefined) patch.personaId = next.personaId ?? ""
    if (next.helperModels !== undefined) patch.helperModels = next.helperModels
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
          /* Absent is "unchanged"; a set travels whole, and the server's
             respawn answers for every peer. */
          suggestKinds: next.suggestKinds,
          // A set travels whole, like the suggestions: absent is unchanged.
          uiGroups: next.uiGroups,
          // The persona: absent is unchanged, null is none.
          personaId: next.personaId,
          /* The role→model helper map (docs/model-roles.md). A spawn input:
             only a real pick travels (`undefined` is dropped by
             `JSON.stringify`), and the server stages it like the rest. */
          helperModels: next.helperModels,
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
      /* The transcript's `PendingSettings` card carries the same sentence —
         `thread-view/pending-settings.tsx`, which calls `describeConfig` too —
         and the cancel on it is the only affordance. A change that costs the
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
        description: describeConfig(held.patch, catalog.profiles(), undefined, catalog.personas()),
        action: {
          label: "Undo",
          onClick: () => changeThreadConfig(held.meta, held.before, held.context),
        },
      })
    }
  }

  const stagePick = async (
    sessionId: string,
    pick: { modeId?: string; options?: Record<string, string | boolean> },
    context: string
  ): Promise<void> => {
    try {
      const reply = await api<{ staged: ConfigPatch }>(settings, `/api/sessions/${sessionId}/config`, {
        method: "POST",
        body: JSON.stringify({ pick }),
      })
      dispatch({ type: "staged-config", id: sessionId, config: reply.staged })
    } catch (error) {
      recordError(sessionId, error, context)
      throw error
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

    /** Replace the thread's role→model helper map (docs/model-roles.md). A
        spawn input like the model, so the server stages it against the running
        turn's boundary — the same door as every other pick. */
    changeHelperModels(meta: SessionMeta, helperModels: { role: string; model: string }[]): void {
      changeThreadConfig(meta, { helperModels }, "Couldn't change this thread's helper models")
    },

    /**
     * Set which closing blocks answers carry (follow-ups, commands, replies,
     * files, agents — an empty set is off).
     *
     * Spawn-text bargain, and staging: the
     * trailer is read at `session/new`/`session/load` and nowhere else.
     */
    changeThreadSuggestions(meta: SessionMeta, suggestKinds: string[]): void {
      changeThreadConfig(
        meta,
        { suggestKinds },
        "Couldn't change this thread's suggestions"
      )
    },

    /**
     * Set which component groups the drawn-view lane teaches; empty turns drawn
     * answers off. The lane is system-prompt text, read at `session/new`/
     * `session/load` and nowhere else, so this costs a respawn and the server
     * stages it; the set travels whole and the server ignores one that is the
     * same.
     */
    changeThreadUiGroups(meta: SessionMeta, uiGroups: string[]): void {
      changeThreadConfig(meta, { uiGroups }, "Couldn't change this thread's drawn UI")
    },

    /** Set the persona a thread runs under; null is none. Spawn text like the
        drawn-view lane, so the server stages it and it costs a respawn. */
    changeThreadPersona(meta: SessionMeta, personaId: string | null): void {
      changeThreadConfig(meta, { personaId }, "Couldn't change this thread's persona")
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
     * The reader's approval of what is staged, now: "Apply now".
     *
     * A running turn is steered with whatever the process can take as it is
     * (the agent's selectors, a live model/effort move) and the rest stays
     * staged for the next turn; an idle thread takes the whole patch, spawn
     * included. The server answers what is left, and `staged_config` says the
     * same to every other peer.
     */
    async applyStagedConfig(sessionId: string) {
      try {
        const reply = await api<{ staged: ConfigPatch | null }>(settings, `/api/sessions/${sessionId}/config`, {
          method: "POST",
          body: JSON.stringify({ applyStaged: true }),
        })
        dispatch({ type: "staged-config", id: sessionId, config: reply.staged ?? null })
        await refreshSessions()
      } catch (error) {
        recordError(sessionId, error, "Couldn't apply that settings change")
        throw error
      }
    },

    /**
     * A mode or an agent option — **staged**, like every other setting.
     *
     * It used to go straight to the running agent, mid-turn included, which
     * moved the permission mode under an answer already being written. Now it
     * waits for the next turn (or the reader's "Apply now"), and the menus
     * draw it through `stagedPicks`. A rejection is the server's to say, at
     * the moment it is taken — there is nothing optimistic left to put back.
     */
    setMode: (sessionId: string, modeId: string) =>
      stagePick(sessionId, { modeId }, "Couldn't stage that mode"),

    setConfigOption: (sessionId: string, configId: string, value: string | boolean) =>
      stagePick(sessionId, { options: { [configId]: value } }, `Couldn't stage that ${configId} setting`),
  }
}
