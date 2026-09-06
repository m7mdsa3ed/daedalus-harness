/* The terminal API and its socket URL.

   The socket carries the token in the query string, unlike the file routes,
   which carry it in a header. That is not a preference — the browser's
   WebSocket constructor has no way to set request headers, which is exactly
   why `/ws` (the thread socket) already does the same thing. It is the one
   place in this client where the token appears in a URL, and it is the reason
   `dev:tunnel` insists on `wss` rather than letting the page fall back. */
import { api, loadSettings, ApiError, type ServerSettings } from "@/lib/settings"

export interface TerminalInfo {
  id: string
  projectId: string
  title: string
  cols: number
  rows: number
  /** Non-null once the shell has exited; the row survives so the panel can say so. */
  exitCode: number | null
  attached: boolean
}

function server(): ServerSettings {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

export function createTerminal(
  projectId: string,
  options: { title?: string; cols?: number; rows?: number } = {}
): Promise<TerminalInfo> {
  return api<TerminalInfo>(server(), `/api/projects/${encodeURIComponent(projectId)}/terminals`, {
    method: "POST",
    body: JSON.stringify(options),
  })
}

/** Start a terminal running one of the project's helper commands.
    Here rather than in `project-helpers.ts` because what it answers with is a
    terminal, not a result: running a helper *is* opening one. The command, the
    working directory and the environment are read from the stored row on the
    server and are deliberately not sendable — a helper the browser could
    define on the way out would be an arbitrary-exec route wearing its name. */
export function startHelperTerminal(projectId: string, helperId: string): Promise<TerminalInfo> {
  return api<TerminalInfo>(
    server(),
    `/api/projects/${encodeURIComponent(projectId)}/helpers/${encodeURIComponent(helperId)}/terminal`,
    { method: "POST" }
  )
}

/** Ends the process. Closing a panel does not come through here. */
export function killTerminal(projectId: string, terminalId: string): Promise<{ ok: true }> {
  return api<{ ok: true }>(
    server(),
    `/api/projects/${encodeURIComponent(projectId)}/terminals/${encodeURIComponent(terminalId)}`,
    { method: "DELETE" }
  )
}

export function terminalSocketUrl(
  settings: ServerSettings,
  projectId: string,
  terminalId: string
): string {
  const url = new URL("/terminal", settings.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", settings.token)
  url.searchParams.set("projectId", projectId)
  url.searchParams.set("terminalId", terminalId)
  return url.toString()
}
