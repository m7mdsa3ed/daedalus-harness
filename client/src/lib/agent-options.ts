import type * as acp from "@daedalus/acp"

import { createLocalStore, createStore } from "./local-store"

/* ── What an agent can be configured with ──
   ACP config options come from a *running* agent, and a thread that has not
   been sent yet has no process — so a new thread would offer nothing to
   configure until it started, which is after the point where configuring it was
   any use.

   This holds the option set for each (profile, agent) pair — a profile may
   serve several agents, and what codex offers on a gateway is not what Claude
   Code offers on it — from two sources: whatever a live session last
   advertised, and — when nothing has been seen yet — a one-shot spawn asking
   the question directly (`POST /api/profiles/:id/options`). Picks
   made against it are replayed with `session/set_config_option` once the
   session really exists (see `createSession` in lib/actions).

   Device-local and reactive, like pins: it is a cache of something the server
   can always re-derive, not state anyone else needs. It is also a snapshot — an
   agent may offer different options for a different cwd, and some options only
   appear once a particular model is selected (opencode reveals `effort` only
   for reasoning models). So it is a *starting* point; the real set replaces it
   the moment a session answers. */

const STORAGE_KEY = "ui.agentOptions.v3"

/** The store's key for one (profile, agent) pair. Every reader and writer
    below takes this rather than a bare profile id. */
export const optionKey = (profileId: string, agentId: string): string => `${profileId}:${agentId}`

/** A pick made on a draft, waiting for a session to apply it to. */
export type ConfigChoices = Record<string, string | boolean>

/** What is known about one agent on one profile. */
export interface AgentOptionSet {
  /** The set advertised with whatever model was selected when we looked. */
  base: acp.SessionConfigOption[]
  /** Model value -> the set advertised while it is selected. Some options only
      exist for some models, so the menu picks the entry for the chosen one. */
  byModel: Record<string, acp.SessionConfigOption[]>
  /** What the runtime can carry in a prompt — the agent's half of the
      attachment decision (`resolveDelivery`). It rides this store for the
      reason everything else here does: a draft has no process to ask, and the
      composer has to say whether the screenshot it is holding will reach the
      model as an image or as a path *before* the first send. Filled by the
      option probe and re-filled by any live session's `session_config`. */
  promptCapabilities?: acp.PromptCapabilities
  /** The agent's permission modes, when it advertises them on the `modes`
      channel rather than as a config option — daedalus does exactly that, and
      an agent that does is invisible in the mode menu this store feeds. Same
      story as every option here: the live `session_config` replaces the
      probed set the moment a session answers. */
  modes?: acp.SessionModeState
}

const EMPTY: AgentOptionSet = { base: [], byModel: {} }

const isSet = (value: unknown): value is AgentOptionSet =>
  !!value && typeof value === "object" && Array.isArray((value as AgentOptionSet).base)

/** The model this option set is sitting on, if it names one. */
function selectedModel(options: acp.SessionConfigOption[]): string | undefined {
  const model = options.find((o) => o.category === "model" && o.type === "select")
  return model?.type === "select" ? model.currentValue : undefined
}

const store = createLocalStore<Record<string, AgentOptionSet>>(
  STORAGE_KEY,
  (raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, AgentOptionSet>)
      : {},
  {}
)

/** How the one-shot probe is going for each pair, this page-load — so a
    re-render cannot start a second spawn while the first is still in flight, or
    retry a hopeless one forever. Reactive and *not* persisted: a probe in
    flight is a fact about this tab, and a failure should be re-askable by
    reloading. It exists because "we are asking", "we asked and it broke" and
    "it genuinely has nothing" are three different things to say, and a menu
    that says the last one for all three is a menu that looks broken while it
    is merely working. */
export type ProbeStatus = "asking" | "done" | "failed"
const probes = createStore<Record<string, ProbeStatus>>({})
const setProbe = (key: string, status: ProbeStatus) =>
  probes.set({ ...probes.get(), [key]: status })

/** Drop the recorded outcomes for the pairs a `drop*` below is forgetting, so
    the next render asks again rather than reading a status about a profile that
    no longer exists. */
const forgetProbes = (match: (key: string) => boolean) =>
  probes.set(Object.fromEntries(Object.entries(probes.get()).filter(([key]) => !match(key))))

/** Live read for the menus that draw the difference. */
export const useProbeStatus = (key: string): ProbeStatus | undefined => probes.use()[key]

/** `key` is always an `optionKey(profileId, agentId)`. */
export const loadAgentOptions = (key: string): AgentOptionSet => {
  const entry = store.get()[key]
  return isSet(entry) ? entry : EMPTY
}

/** Learned from a live session: authoritative for the model it is sitting on.
    `modes` rides along when the session advertised them — it outranks a
    probe's, being the process a prompt would actually go to. */
export function saveAgentOptions(
  key: string,
  options: acp.SessionConfigOption[],
  modes?: acp.SessionModeState
): void {
  if (options.length === 0 && !modes) return
  const known = loadAgentOptions(key)
  /* An empty list keeps what was known — the old early-return's semantic, kept
     now that a modes-only statement can also land here. */
  const base = options.length > 0 ? options : known.base
  const model = selectedModel(base)
  store.set({
    ...store.get(),
    [key]: {
      base,
      byModel: model ? { ...known.byModel, [model]: base } : known.byModel,
      ...(modes ? { modes } : {}),
      ...(known.promptCapabilities ? { promptCapabilities: known.promptCapabilities } : {}),
    },
  })
}

/** Learned from a probe: the whole map in one go (see server/src/probe.ts). */
export function saveProbedOptions(key: string, probed: AgentOptionSet): void {
  if (probed.base.length === 0 && !probed.modes) return
  const known = loadAgentOptions(key)
  store.set({
    ...store.get(),
    [key]: {
      ...known,
      base: probed.base,
      byModel: { ...known.byModel, ...probed.byModel },
      ...(probed.modes ? { modes: probed.modes } : {}),
      ...(probed.promptCapabilities ? { promptCapabilities: probed.promptCapabilities } : {}),
    },
  })
}

/** Learned from a live session, which outranks a probe: the process answering
    is the one a prompt would actually go to. Written on its own rather than
    through `saveAgentOptions`, because `session_config` carries the two fields
    independently — an agent may restate its options with no capabilities and
    vice versa. */
export function savePromptCapabilities(key: string, caps: acp.PromptCapabilities): void {
  const known = loadAgentOptions(key)
  store.set({ ...store.get(), [key]: { ...known, promptCapabilities: caps } })
}

/** The set to show while `model` is selected, falling back to the base one. */
export const optionsForModel = (
  known: AgentOptionSet,
  model: string | undefined
): acp.SessionConfigOption[] => (model && known.byModel[model]) || known.base

/** Reactive read — the menu re-renders when a probe or a live session fills it.

    `fallbackKeys` are the *same agent* on sibling profiles, tried in order when
    this pair has not answered yet. A profile owns only the model list and
    effort — every other option belongs to the agent — so a sibling's answer
    (typically the virtual Default profile's) is the agent's answer, and a
    freshly created provider profile shows the agent's options immediately
    instead of a blank menu. Display-only: the pair's own probe still runs and
    its entry replaces the borrowed one the moment it lands. */
export function useAgentOptions(
  key: string,
  fallbackKeys: readonly string[] = []
): AgentOptionSet {
  return resolveAgentOptions(store.use(), key, fallbackKeys)
}

/** The same read outside React — what `createSession` sends has to be what
    the draft menu showed, so both resolve through this one function. */
export const knownAgentOptions = (key: string, fallbackKeys: readonly string[] = []) =>
  resolveAgentOptions(store.get(), key, fallbackKeys)

function resolveAgentOptions(
  known: Record<string, AgentOptionSet>,
  key: string,
  fallbackKeys: readonly string[]
): AgentOptionSet {
  const own = known[key]
  if (isSet(own) && (own.base.length > 0 || own.modes)) return own
  for (const fallback of fallbackKeys) {
    const sibling = known[fallback]
    if (isSet(sibling) && (sibling.base.length > 0 || sibling.modes)) return sibling
  }
  return EMPTY
}

/** What the runtime can carry, live — the composer's fallback when the thread
    itself has not said (a draft, or a thread with no process). A sibling
    profile's answer is as good as this pair's: the capability is the *binary's*
    and a profile only ever overrides the model and the effort. */
export function usePromptCapabilities(
  key: string,
  fallbackKeys: readonly string[] = []
): acp.PromptCapabilities | undefined {
  const known = store.use()
  for (const candidate of [key, ...fallbackKeys]) {
    const entry = known[candidate]
    if (isSet(entry) && entry.promptCapabilities) return entry.promptCapabilities
  }
  return undefined
}

/** Has this pair already been asked (or is being asked) this page-load? */
export const alreadyAsked = (key: string): boolean => probes.get()[key] !== undefined
export const markAsked = (key: string): void => setProbe(key, "asking")
export const markProbed = (key: string, ok: boolean): void =>
  setProbe(key, ok ? "done" : "failed")

/** Apply a draft's picks to a remembered set, so the menu shows what was chosen
    rather than what the agent last happened to be on. */
export function withChoices(
  options: acp.SessionConfigOption[],
  choices: ConfigChoices | undefined
): acp.SessionConfigOption[] {
  if (!choices) return options
  return options.map((option) => {
    const chosen = choices[option.id]
    if (chosen === undefined) return option
    if (option.type === "boolean" && typeof chosen === "boolean") {
      return { ...option, currentValue: chosen }
    }
    if (option.type === "select" && typeof chosen === "string") {
      return { ...option, currentValue: chosen }
    }
    return option
  })
}

/** The option set a thread *shows*: the remembered set for the model the row
    records, with its own picks laid over it. One derivation for the new-thread
    menu, the started-thread menu and `createSession`, so what is drawn is what
    is sent and the two menus cannot state different things — a remembered
    value the user never clicked used to be displayed and then left out of the
    create call, and the agent came up on its default.

    The model and the effort are read off the row (`SessionMeta.model` /
    `.effort`) and forced back onto the set by *category*: every thread records
    them there whatever its profile — a catalog id for a profile that owns one,
    the agent's own selector id for a profile that does not — and the server
    applies the second kind through `agentOwned`, which is why they no longer
    travel as config choices. A pick still sitting in `choices` is an older
    draft's (the model used to live there) and is read only when the row itself
    names nothing. */
export function shownOptions(
  known: AgentOptionSet,
  choices: ConfigChoices | undefined,
  model?: string,
  effort?: string
): acp.SessionConfigOption[] {
  const modelOption = known.base.find((o) => o.category === "model" && o.type === "select")
  const chosen = model || (modelOption ? choices?.[modelOption.id] : undefined)
  const shown = withChoices(
    optionsForModel(known, typeof chosen === "string" && chosen ? chosen : undefined),
    choices
  )
  /* Absolute for the two settings the row names: the remembered set may have
     been recorded on a different model (a sibling profile's, or this one's
     last), and what it is sitting on is not what this thread is on. */
  return shown.map((option) => {
    if (option.type !== "select") return option
    if (option.category === "model" && model) return { ...option, currentValue: model }
    if (option.category === "thought_level" && effort) return { ...option, currentValue: effort }
    return option
  })
}

/** Forget everything remembered about one profile, *and* let it be asked
    again this page-load.

    A profile's credentials, endpoint and catalog are exactly what decide the
    answer, so an edited profile's remembered set describes a profile that no
    longer exists — and `learnAgentOptions` refuses to re-ask a pair it already
    has a set for, so without this the stale set outlives the edit for as long
    as the tab is open. The server evicts its own probe cache on the same event
    (`updateProfile`); this is the device-local half of it. */
export function dropAgentOptions(profileId: string): void {
  const prefix = `${profileId}:`
  forgetProbes((key) => key.startsWith(prefix))
  const kept = Object.fromEntries(
    Object.entries(store.get()).filter(([key]) => !key.startsWith(prefix))
  )
  if (Object.keys(kept).length !== Object.keys(store.get()).length) store.set(kept)
}

/** The same argument, the other way round: an agent whose command or env was
    edited answers differently on *every* profile, so its entries are dropped
    across all of them. Keys are `<profileId>:<agentId>`, and an agent id may
    not contain a colon, so the suffix identifies it. */
export function dropAgentOptionsFor(agentId: string): void {
  const suffix = `:${agentId}`
  forgetProbes((key) => key.endsWith(suffix))
  const kept = Object.fromEntries(
    Object.entries(store.get()).filter(([key]) => !key.endsWith(suffix))
  )
  if (Object.keys(kept).length !== Object.keys(store.get()).length) store.set(kept)
}

/** Drop the cache for profiles that no longer exist. Keys are
    `<profileId>:<agentId>`, so a profile's entries are the ones under its id. */
export function pruneAgentOptions(profileIds: Iterable<string>): void {
  const live = new Set(profileIds)
  const kept = Object.fromEntries(
    Object.entries(store.get()).filter(([key]) => live.has(key.slice(0, key.lastIndexOf(":"))))
  )
  if (Object.keys(kept).length !== Object.keys(store.get()).length) store.set(kept)
}
