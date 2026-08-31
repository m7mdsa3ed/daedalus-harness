/* The import client. Mirrors the two routes in `server/src/routes/sessions.ts`,
   in the style of knowledge-api.ts: each call wraps `api()` with the active
   connection, so the dialog never has to know where the server is.

   What travels here is a *pointer*, never a transcript: the conversation stays
   in the agent's own store and an imported thread is a row naming it, loaded
   back through `session/load` the first time it is opened. */
import { api, loadSettings, ApiError, type Project, type ServerSettings } from "@/lib/settings"

export interface ImportableSession {
  acpSessionId: string
  /** The directory it ran in — what decides which project it belongs to. */
  cwd: string
  title: string | null
  updatedAt: string | null
  /** Already a thread here: its id, so the row offers Open instead. */
  existing?: { sessionId: string; deleted: boolean }
}

export interface SessionListing {
  /** False when the runtime cannot enumerate its own sessions. An answer, not
      an error — the dialog says so in words. */
  supported: boolean
  sessions: ImportableSession[]
  truncated: boolean
}

export interface ImportResult {
  created: { id: string; acpSessionId: string }[]
  skipped: { acpSessionId: string; reason: string }[]
}

function server(): ServerSettings {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

/** What this (profile, agent) already has on the server's machine. `projectId`
    only supplies the directory to spawn the agent in; the listing is
    machine-wide and each entry carries its own cwd. */
export function listImportable(
  body: { profileId: string; agentId: string; projectId: string },
  signal?: AbortSignal
): Promise<SessionListing> {
  return api<SessionListing>(server(), "/api/sessions/importable", {
    method: "POST",
    body: JSON.stringify(body),
    signal,
  })
}

/** Adopt them. One round trip however many: no agent is spawned, and opening
    a thread is what loads its history. */
export function importSessions(body: {
  profileId: string
  agentId: string
  sessions: { acpSessionId: string; title: string | null; updatedAt: string | null; projectId: string }[]
  mcpServerIds?: string[]
  skillIds?: string[]
  commandIds?: string[]
}): Promise<ImportResult> {
  return api<ImportResult>(server(), "/api/sessions/import", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

/** A project for a directory the harness has never been pointed at — the one
    thing an unmatched cwd needs before its conversations can be imported. */
export function createProjectAt(cwd: string, name: string): Promise<Project> {
  return api<Project>(server(), "/api/projects", {
    method: "POST",
    body: JSON.stringify({ name, cwd, description: null, logoUrl: "" }),
  })
}

/** Trailing slashes aside, two spellings of the same directory are one place. */
export function normalizeCwd(cwd: string): string {
  return cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd
}

/** The last segment, which is what a project at that path is called by
    default — the name the user would have typed. */
export function baseName(cwd: string): string {
  const parts = normalizeCwd(cwd).split("/").filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}
