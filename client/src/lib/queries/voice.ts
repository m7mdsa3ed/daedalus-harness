/* ── Voice backends (Settings › Voice) ──
   The server's rows minus the key. Read by the settings page and by the
   composer, which draws the voice-mode button only when one exists and builds
   the realtime model from the default row's provider and model — the token the
   call connects with is minted per call (`/api/voice/setup`), never cached. */
import { api } from "@/lib/settings"
import { scope } from "./keys"
import { useApiMutation, useApiQuery } from "./helpers"
import { useServer } from "@/lib/server-context"
import type { ServerSettings } from "@/lib/settings"

export type VoiceProviderId = "openai" | "google"

export interface VoiceProvider {
  provider: VoiceProviderId
  model: string
  voice: string
  isDefault: boolean
  hasKey: boolean
}

export interface VoiceProviderInput {
  provider: VoiceProviderId
  apiKey: string
  model: string
  voice: string
  isDefault: boolean
}

export const voiceKey = (s: ServerSettings) => scope(s).concat(["voice"])

export const useVoiceProviders = () => useApiQuery<VoiceProvider[]>(voiceKey(useServer()), "/api/voice")

/** The row the voice button uses: the default, else the only one. */
export const defaultVoice = (rows: readonly VoiceProvider[] | undefined): VoiceProvider | undefined =>
  rows?.find((r) => r.isDefault) ?? rows?.[0]

export const useSaveVoiceProvider = () =>
  useApiMutation<VoiceProviderInput, VoiceProvider>(
    [voiceKey(useServer())],
    (settings, { provider, ...body }) =>
      api(settings, `/api/voice/${provider}`, { method: "PUT", body: JSON.stringify(body) })
  )

export const useDeleteVoiceProvider = () =>
  useApiMutation<VoiceProviderId, unknown>([voiceKey(useServer())], (settings, provider) =>
    api(settings, `/api/voice/${provider}`, { method: "DELETE" })
  )
