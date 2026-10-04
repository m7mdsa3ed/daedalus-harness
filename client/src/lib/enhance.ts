/* ── Prompt enhancer, client half ──
   The composer sends its draft to the server, which rewrites it through the
   AI SDK against a profile's own endpoint (`server/src/ai.ts` makes the call,
   `server/src/enhance.ts` holds the house style). The key never leaves the
   server, so there is deliberately no client-side provider call here — just
   the two routes, through the one `api` wrapper.

   Which profile does the rewrite is a device-local pick, and it is one of
   several the harness now keeps (source control has its own): the shape they
   share lives in `lib/ai-picks.ts`, and what is left here is the two routes
   plus this file's names for that pick, which its callers already use. */
import { aiCapable, canUseAi, enhancePick, modelPickLabel } from "./ai-picks"
import { api, type ServerSettings } from "./settings"

/** The profiles that can do a rewrite, and the same gate for one row. */
export const enhanceCapable = aiCapable
export const canEnhance = canUseAi

export const useEnhanceProfileId = enhancePick.useProfileId
export const setEnhanceProfileId = enhancePick.setProfileId
export const useEnhanceModelId = enhancePick.useModelId
export const setEnhanceModelId = enhancePick.setModelId
export const resolveEnhanceProfile = enhancePick.resolveProfile
export const resolveEnhanceModelId = enhancePick.resolveModelId
export const enhanceModelLabel = modelPickLabel

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

/** Drafts have no server row yet, so the provider travels in the body. The
    draft's agent does not: the rewrite goes to the profile's shared endpoint,
    so the server neither needs nor reads one. */
export async function enhanceDraft(
  settings: ServerSettings,
  text: string,
  opts: { profileId: string; model?: string; kind?: "prompt" | "task" },
  signal?: AbortSignal
): Promise<string> {
  const { enhanced } = await api<{ enhanced: string }>(settings, "/api/enhance", {
    method: "POST",
    body: JSON.stringify({ text, ...opts }),
    signal,
  })
  return enhanced
}
