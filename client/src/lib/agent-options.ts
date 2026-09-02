import type * as acp from "@daedalus/acp"

import { createLocalStore } from "./local-store"

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

/** Profiles already asked this page-load, so a re-render cannot start a second
    spawn while the first is still in flight — or retry a hopeless one forever. */
const asked = new Set<string>()

/** `key` is always an `optionKey(profileId, agentId)`. */
export const loadAgentOptions = (key: string): AgentOptionSet => {
  const entry = store.get()[key]
  return isSet(entry) ? entry : EMPTY
}

/** Learned from a live session: authoritative for the model it is sitting on. */
export function saveAgentOptions(key: string, options: acp.SessionConfigOption[]): void {
  if (options.length === 0) return
  const known = loadAgentOptions(key)
  const model = selectedModel(options)
  store.set({
    ...store.get(),
    [key]: {
      base: options,
      byModel: model ? { ...known.byModel, [model]: options } : known.byModel,
    },
  })
}

/** Learned from a probe: the whole map in one go (see server/src/probe.ts). */
export function saveProbedOptions(key: string, probed: AgentOptionSet): void {
  if (probed.base.length === 0) return
  const known = loadAgentOptions(key)
  store.set({
    ...store.get(),
    [key]: {
      ...known,
      base: probed.base,
      byModel: { ...known.byModel, ...probed.byModel },
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
  const known = store.use()
  const own = known[key]
  if (isSet(own) && own.base.length > 0) return own
  for (const fallback of fallbackKeys) {
    const sibling = known[fallback]
    if (isSet(sibling) && sibling.base.length > 0) return sibling
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
export const alreadyAsked = (key: string): boolean => asked.has(key)
export const markAsked = (key: string): void => void asked.add(key)

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
  for (const key of asked) if (key.startsWith(prefix)) asked.delete(key)
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
  for (const key of asked) if (key.endsWith(suffix)) asked.delete(key)
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
