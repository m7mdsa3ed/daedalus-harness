/* ── Prompt enhancer, client half ──
   The composer sends its draft to the server, which rewrites it through the
   AI SDK against a profile's own endpoint (`server/src/enhance.ts`). The key
   never leaves the server, so there is deliberately no client-side provider
   call here — just the two routes, through the one `api` wrapper.

   Which profile does the rewrite is the user's pick, remembered device-locally
   like the thread defaults: enhancing is instructions work, and the profile
   you trust with it is a habit, not a property of the thread. */
import { createLocalStore } from "./local-store"
import { api, type Profile, type ServerSettings } from "./settings"

/** The stored profiles that can actually do a rewrite: a real endpoint behind
    them. Virtual Defaults carry no baseUrl and 409 on the server, and a hidden
    or disabled profile is out of the pickers — a rewrite is new work. */
export const enhanceCapable = (profiles: readonly Profile[]): Profile[] =>
  profiles.filter((p) => !p.virtual && !p.hidden && !p.disabled && p.baseUrl.trim().length > 0)

/** The same gate, for one row — so the composer and anything drawing the
    picker agree on what "capable" means. */
export const canEnhance = (
  profile: Pick<Profile, "virtual" | "baseUrl" | "hidden" | "disabled"> | null | undefined
): boolean =>
  Boolean(profile && !profile.virtual && !profile.hidden && !profile.disabled && profile.baseUrl.trim().length > 0)

const store = createLocalStore<string | null>(
  "ui.enhanceProfile",
  (raw) => (typeof raw === "string" && raw ? raw : null),
  null
)

export const useEnhanceProfileId = store.use

export function setEnhanceProfileId(id: string | null): void {
  store.set(id)
}

/** Explicit model pick for the rewrite, device-local like the profile pick:
    "" means "no pick — fall back to the thread's model, then the profile's
    own default". A model id that the picked profile no longer serves reads as
    no pick rather than as a stale id. */
const modelStore = createLocalStore<string>(
  "ui.enhanceModel",
  (raw) => (typeof raw === "string" ? raw : ""),
  ""
)

export const useEnhanceModelId = modelStore.use

export function setEnhanceModelId(id: string): void {
  modelStore.set(id)
}

/** The remembered model when the profile still serves it, else "" (no pick). */
export function resolveEnhanceModelId(profile: Profile | null | undefined): string {
  if (!profile) return ""
  const id = modelStore.get()
  if (!id) return ""
  return profile.models.some((m) => m.id === id) ? id : ""
}

/** Display label for the enhance model pick: the model's own label, else
    "Profile default". */
export function enhanceModelLabel(profile: Profile | null | undefined, modelId: string): string {
  if (!modelId) return "Profile default"
  return profile?.models.find((m) => m.id === modelId)?.label ?? "Profile default"
}

/** The remembered profile when it still exists and still can, else the
    thread's own when that can, else the first capable one. */
export function resolveEnhanceProfile(
  profiles: readonly Profile[],
  threadProfileId?: string
): Profile | null {
  const capable = enhanceCapable(profiles)
  if (capable.length === 0) return null
  const remembered = store.get()
  const byId = (id: string | null | undefined) =>
    (id && capable.find((p) => p.id === id)) || null
  return byId(remembered) ?? byId(threadProfileId) ?? capable[0]
}

export async function enhanceThread(
  settings: ServerSettings,
  sessionId: string,
  text: string,
  opts: { profileId?: string; model?: string } = {},
  signal?: AbortSignal
): Promise<string> {
  const { enhanced } = await api<{ enhanced: string }>(settings, `/api/sessions/${sessionId}/enhance`, {
    method: "POST",
    body: JSON.stringify({ text, ...opts }),
    signal,
  })
  return enhanced
}

/** Drafts have no server row yet, so the provider travels in the body. */
export async function enhanceDraft(
  settings: ServerSettings,
  text: string,
  opts: { profileId: string; agentId?: string; model?: string },
  signal?: AbortSignal
): Promise<string> {
  const { enhanced } = await api<{ enhanced: string }>(settings, "/api/enhance", {
    method: "POST",
    body: JSON.stringify({ text, ...opts }),
    signal,
  })
  return enhanced
}
