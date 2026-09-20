/* ── Which provider does the harness's own thinking ──
 *
 * The harness asks a model a few things on the user's behalf that are not a
 * turn on a thread: it rewrites a draft prompt, it drafts a commit message, it
 * names a branch. Each of those is a *habit of the hand typing* rather than a
 * property of a thread — the provider you trust with a rewrite is not
 * necessarily the one you want reading your diff, and neither is necessarily
 * the one the thread runs on. So each is its own device-local pick, and this is
 * the one shape they share: a profile, an optional model, and the resolution
 * rules for a remembered id that no longer exists.
 *
 * The server half is the mirror image (`server/src/ai.ts` makes the call,
 * `server/src/enhance.ts` holds the house styles); this side never talks to a
 * provider, because the API key never leaves the server.
 */
import { createLocalStore } from "./local-store"
import type { Profile } from "./settings"

/** The stored profiles that can actually make one of these calls: a real
    endpoint behind them. Virtual Defaults carry no baseUrl and 409 on the
    server, and a hidden or disabled profile is out of the pickers. */
export const aiCapable = (profiles: readonly Profile[]): Profile[] =>
  profiles.filter((p) => !p.virtual && !p.hidden && !p.disabled && p.baseUrl.trim().length > 0)

/** The same gate, for one row — so every picker and every button that hides
    itself agree on what "capable" means. */
export const canUseAi = (
  profile: Pick<Profile, "virtual" | "baseUrl" | "hidden" | "disabled"> | null | undefined
): boolean =>
  Boolean(profile && !profile.virtual && !profile.hidden && !profile.disabled && profile.baseUrl.trim().length > 0)

export interface AiPick {
  /** Subscribe to the profile pick (for the re-render), and read it. */
  useProfileId: () => string | null
  setProfileId: (id: string | null) => void
  /** Subscribe to the model pick. `""` means "no pick". */
  useModelId: () => string
  setModelId: (id: string) => void
  /** The remembered profile when it still exists and still can, else the
      thread's own when that can, else the first capable one. */
  resolveProfile: (profiles: readonly Profile[], threadProfileId?: string) => Profile | null
  /** The remembered model when the profile still serves it, else `""` — a
      stale id reads as no pick rather than as a model the endpoint would
      reject. */
  resolveModelId: (profile: Profile | null | undefined) => string
}

/** One pick, stored under `ui.<name>Profile` / `ui.<name>Model`. The key is the
    migration surface: it is what a device that already made this pick has on
    disk, so it is passed in rather than derived. */
export function createAiPick(name: string): AiPick {
  const profileStore = createLocalStore<string | null>(
    `ui.${name}Profile`,
    (raw) => (typeof raw === "string" && raw ? raw : null),
    null
  )
  const modelStore = createLocalStore<string>(
    `ui.${name}Model`,
    (raw) => (typeof raw === "string" ? raw : ""),
    ""
  )

  return {
    useProfileId: profileStore.use,
    setProfileId: (id) => profileStore.set(id),
    useModelId: modelStore.use,
    setModelId: (id) => modelStore.set(id),
    resolveProfile(profiles, threadProfileId) {
      const capable = aiCapable(profiles)
      if (capable.length === 0) return null
      const byId = (id: string | null | undefined) => (id && capable.find((p) => p.id === id)) || null
      return byId(profileStore.get()) ?? byId(threadProfileId) ?? capable[0]
    },
    resolveModelId(profile) {
      if (!profile) return ""
      const id = modelStore.get()
      if (!id) return ""
      return profile.models.some((m) => m.id === id) ? id : ""
    },
  }
}

/** Display label for a model pick: the model's own, else "Profile default". */
export function modelPickLabel(profile: Profile | null | undefined, modelId: string): string {
  if (!modelId) return "Profile default"
  return profile?.models.find((m) => m.id === modelId)?.label ?? "Profile default"
}

/** The composer's Enhance button. `ui.enhanceProfile`/`ui.enhanceModel` — the
    keys this pick has always used, kept so nobody's pick is forgotten. */
export const enhancePick = createAiPick("enhance")

/** Source control's two drafts — the commit message and the branch name. One
    pick for both: they are the same question asked of the same diff, and a
    device that wants a cheap local model reading its patches wants it for
    both. */
export const gitPick = createAiPick("gitAi")
