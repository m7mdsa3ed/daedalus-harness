/* ── Recently used thread setups ──
   The (agent, profile, model, effort) combinations this person has actually
   switched between, newest first, so the config menu can offer them back as
   one click. Device-local like the palette's recents (`palette-recents.ts`):
   a habit is a fact about the reader, not about the thread or the project.

   Only catalog models are remembered — a profile that lists its own. An
   agent-owned model is the agent's selector, which a started thread moves
   through a different door (`setConfigOption`), and a recent row that only
   worked on drafts would be a row that lies on every other menu.

   Entries are never pruned on write: a profile deleted or a model dropped
   simply fails `recentChoices`' check and is drawn nowhere. */
import { createLocalStore } from "./local-store.ts"

export interface RecentConfig {
  agentId: string
  profileId: string
  /** "" is the profile's default model. */
  model: string
  /** "" is the model's default effort. */
  effort: string
}

const LIMIT = 8

/** How many the config menu offers — a quick switch, not a history. */
export const RECENT_SHOWN = 3

const isRecent = (raw: unknown): raw is RecentConfig =>
  !!raw &&
  typeof raw === "object" &&
  ["agentId", "profileId", "model", "effort"].every(
    (key) => typeof (raw as Record<string, unknown>)[key] === "string"
  )

const store = createLocalStore<RecentConfig[]>(
  "ui.configRecents",
  (raw) => (Array.isArray(raw) ? raw.filter(isRecent).slice(0, LIMIT) : []),
  []
)

export const sameConfig = (a: RecentConfig, b: RecentConfig) =>
  a.agentId === b.agentId && a.profileId === b.profileId && a.model === b.model && a.effort === b.effort

/** Newest first. */
export const useConfigRecents = store.use

export function recordConfig(config: RecentConfig): void {
  const { agentId, profileId, model, effort } = config
  const entry = { agentId, profileId, model, effort }
  store.set([entry, ...store.get().filter((other) => !sameConfig(other, entry))].slice(0, LIMIT))
}

/**
 * The next setup `cycleSetup` moves to: a fixed walk over the current setup
 * and the ones the menu offers, so repeated presses go A → B → C → A rather
 * than flipping between the newest two. A walk records nothing, which is what
 * keeps the order still under the key. The one exception is a current setup
 * that is not in the list yet: it is recorded first, or the walk could never
 * come back to it.
 */
export function nextRecentSetup(
  setups: { config: RecentConfig }[],
  current: RecentConfig
): RecentConfig | null {
  const walk = setups.map((s) => s.config)
  let at = walk.findIndex((c) => sameConfig(c, current))
  if (at < 0) {
    recordConfig(current)
    walk.unshift(current)
    at = 0
  }
  const ring = walk.slice(0, RECENT_SHOWN + 1)
  return ring.length > 1 ? ring[(at + 1) % ring.length] : null
}
