import { api, ApiError, type ServerSettings } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { useApiMutation, useApiQuery } from "./helpers"
import { scope } from "./keys"

export interface VideoScene { id: string; title: string; narration: string; durationSeconds: number; background: string; audioFile?: string }
export interface VideoDocument { title: string; width: 1280 | 1920 | 1080; height: 720 | 1080 | 1920; scenes: VideoScene[]; audioFile?: string }
export interface VideoRender { id: string; revision: number; status: "queued" | "rendering" | "completed" | "failed"; progress: number; error: string | null; createdAt: number }
export interface VideoState { document: VideoDocument | null; revision: number; renders: VideoRender[] }
export interface TtsProvider { id: string; label: string; model: string; voice: string; hasKey: boolean }
export const videoKey = (settings: ServerSettings, sessionId: string) => scope(settings).concat(["video", sessionId])
export const videoProvidersKey = (settings: ServerSettings) => scope(settings).concat(["video-tts-providers"])

export function useVideo(sessionId: string) {
  const settings = useServer()
  return useApiQuery<VideoState>(videoKey(settings, sessionId), `/api/sessions/${encodeURIComponent(sessionId)}/video`, { refetchInterval: (query) => query.state.data?.renders.some((r) => r.status === "queued" || r.status === "rendering") ? 1500 : false })
}
export function useTtsProviders() {
  const settings = useServer()
  return useApiQuery<{ available: { id: string; label: string }[]; configured: TtsProvider[] }>(videoProvidersKey(settings), "/api/video/providers")
}
export function useSaveVideo() {
  const settings = useServer()
  return useApiMutation<{ sessionId: string; document: VideoDocument }, unknown>(
    (_data, input) => [videoKey(settings, input.sessionId)],
    (conn, { sessionId, document }) => api(conn, `/api/sessions/${encodeURIComponent(sessionId)}/video`, { method: "PUT", body: JSON.stringify(document) })
  )
}
export function useGenerateVideoSpeech() {
  const settings = useServer()
  return useApiMutation<{ sessionId: string; sceneId: string; text: string }, unknown>(
    (_data, input) => [videoKey(settings, input.sessionId)],
    (conn, input) => api(conn, `/api/sessions/${encodeURIComponent(input.sessionId)}/video/speech`, { method: "POST", body: JSON.stringify({ sceneId: input.sceneId, text: input.text }) })
  )
}
export function useQueueVideoRender() {
  const settings = useServer()
  return useApiMutation<{ sessionId: string }, { id: string }>(
    (_data, input) => [videoKey(settings, input.sessionId)],
    (conn, { sessionId }) => api(conn, `/api/sessions/${encodeURIComponent(sessionId)}/video/renders`, { method: "POST", body: "{}" })
  )
}
export const saveTtsProvider = (settings: ServerSettings, input: { provider: string; apiKey: string; model: string; voice: string }) =>
  api<TtsProvider>(settings, `/api/video/providers/${encodeURIComponent(input.provider)}`, { method: "PUT", body: JSON.stringify(input) })
export async function fetchVideo(settings: ServerSettings, sessionId: string, renderId: string, preview = false): Promise<Blob> {
  const suffix = preview ? "/preview" : ""
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/video/renders/${encodeURIComponent(renderId)}${suffix}`
  const response = await fetch(new URL(path, settings.url), { headers: { authorization: `Bearer ${settings.token}` } })
  if (!response.ok) throw new ApiError({ status: response.status, path, serverMessage: "Couldn't download rendered video" })
  return response.blob()
}
