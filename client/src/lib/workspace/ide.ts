/* The embedded-editor API, and the one URL in this client that is not fetched.

   `ideFrameUrl` builds an absolute address on the *server's* origin, because
   that is where the proxy is — the app itself is served from Vite, or from a
   tunnel, or from Electron's file origin, and none of those has an `/ide`
   route. It carries no token: the key inside `status.path` was minted by the
   authenticated POST below and is that frame's credential, since an iframe has
   no way to send a header and every asset code-server asks for afterwards is a
   relative URL the browser resolves on its own. */
import { api, loadSettings, ApiError, type ServerSettings } from "@/lib/settings"
import type { IdeTheme } from "@/lib/workspace/ide-theme"

export type IdeState = "off" | "starting" | "ready" | "failed" | "unavailable"

export interface IdeStatus {
  projectId: string
  state: IdeState
  /** `/ide/<key>/` while ready, and null otherwise. */
  path: string | null
  /** The spawn error, the stderr tail, or why there is no binary. */
  message: string | null
  /** The binary the server would run, or null when it has none. */
  binary: string | null
  /** What to run to get one. Only when `unavailable`. */
  install: string | null
}

function server(): ServerSettings {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

const route = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/ide`

/** What the editor is doing right now. Never starts one. */
export function getIdeStatus(projectId: string): Promise<IdeStatus> {
  return api<IdeStatus>(server(), route(projectId))
}

/** Start it, or hand back the one already running. Idempotent, and slow the
    first time — the server does not answer until code-server does. */
export function startIde(projectId: string, theme?: IdeTheme): Promise<IdeStatus> {
  return api<IdeStatus>(server(), route(projectId), {
    method: "POST",
    body: JSON.stringify(theme ? { theme } : {}),
  })
}

/** Paint the editor in the app's palette. Lands live — VS Code watches the
    settings file the server writes it into. */
export function setIdeTheme(projectId: string, theme: IdeTheme): Promise<{ ok: true }> {
  return api<{ ok: true }>(server(), `${route(projectId)}/theme`, {
    method: "PUT",
    body: JSON.stringify(theme),
  })
}

/** Ends the process, and with it every unsaved buffer's live state. Closing the
    panel does not come through here — that is the whole distinction. */
export function stopIde(projectId: string): Promise<IdeStatus> {
  return api<IdeStatus>(server(), route(projectId), { method: "DELETE" })
}

export function ideFrameUrl(status: IdeStatus): string | null {
  if (!status.path) return null
  return new URL(status.path, server().url).toString()
}
