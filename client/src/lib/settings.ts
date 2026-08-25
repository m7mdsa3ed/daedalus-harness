// Server connection settings live in localStorage — the web build ships with
// no baked-in server; the user enters URL + token on the connect screen.

export interface ServerSettings {
  url: string
  token: string
}

const KEY = "daedalus.server"

export function loadSettings(): ServerSettings | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as ServerSettings) : null
  } catch {
    return null
  }
}

export function saveSettings(settings: ServerSettings): void {
  localStorage.setItem(KEY, JSON.stringify(settings))
}

export function clearSettings(): void {
  localStorage.removeItem(KEY)
}

export async function api<T>(
  settings: ServerSettings,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(new URL(path, settings.url), {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${settings.token}`,
      ...init?.headers,
    },
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json() as Promise<T>
}

export function wsUrl(settings: ServerSettings, sessionId: string, cursor: number): string {
  const url = new URL("/ws", settings.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", settings.token)
  url.searchParams.set("sessionId", sessionId)
  url.searchParams.set("cursor", String(cursor))
  return url.toString()
}

// ---- server API types ----

export interface AgentDef {
  id: string
  name: string
}

export interface McpServerStdio {
  type: "stdio"
  name: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}

export interface McpServerHttp {
  type: "http"
  name: string
  url: string
  headers: { name: string; value: string }[]
}

/** Library entries projects link to by id. */
export type McpServerDef = (McpServerStdio | McpServerHttp) & { id: string }

export interface SkillDef {
  id: string
  name: string
  /** Directory on the server holding SKILL.md. */
  path: string
}

/** Entries discovered in the agents' own configs, offered for import. */
export interface ImportCandidates {
  mcpServers: (Omit<McpServerDef, "id"> & { source: string })[]
  skills: (Omit<SkillDef, "id"> & { source: string })[]
}

/** Agent configuration used in a session (credentials, models). */
export interface Profile {
  id: string
  name: string
  agentId: string
  baseUrl: string
  hasApiKey: boolean
  models: ModelOption[]
  defaultModel: string
}

export interface ModelOption {
  id: string
  label: string
  contextWindow?: number
  maxOutputTokens?: number
  /** Effort levels the model accepts; empty = no effort control. */
  reasoningEfforts: string[]
}

/** Workspace a session runs in. */
export interface Project {
  id: string
  name: string
  cwd: string
  mcpServerIds: string[]
  skillIds: string[]
}

export interface SessionMeta {
  id: string
  profileId: string
  projectId: string
  agentId: string
  model: string
  effort: string
  title: string
  acpSessionId?: string
  createdAt: number
  attached: boolean
  exited: boolean
  promptActive: boolean
  cursor: number
}

export interface JournalEntry {
  d: "a" | "c"
  line: string
}
