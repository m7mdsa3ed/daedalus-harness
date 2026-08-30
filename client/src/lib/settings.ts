// Server connections live in localStorage — the web build ships with no
// baked-in server; the user enters URL + token on the connect screen. Several
// servers can be stored at once; one of them is active (switched in the
// sidebar), and the active one is what every request in the app talks to.

import { uuid } from "./uuid"
import { clearLayout } from "./workspace/layout"

export interface ServerSettings {
  id: string
  name: string
  url: string
  token: string
}

interface ServerStore {
  servers: ServerSettings[]
  activeId: string | null
}

const KEY = "daedalus.servers"
const LEGACY_KEY = "daedalus.server"

const EMPTY: ServerStore = { servers: [], activeId: null }

/** Human label for a connection when the user does not name it. */
export function serverName(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function read(): ServerStore {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as ServerStore
      if (Array.isArray(parsed?.servers)) {
        return { servers: parsed.servers, activeId: parsed.activeId ?? parsed.servers[0]?.id ?? null }
      }
    }
    // Single-server format written by older builds — migrate it in place.
    const legacy = localStorage.getItem(LEGACY_KEY)
    if (legacy) {
      const { url, token } = JSON.parse(legacy) as { url: string; token: string }
      const store: ServerStore = {
        servers: [{ id: newId(), name: serverName(url), url, token }],
        activeId: null,
      }
      store.activeId = store.servers[0].id
      write(store)
      localStorage.removeItem(LEGACY_KEY)
      return store
    }
  } catch {
    /* corrupt storage reads as "no servers" — the connect screen takes over */
  }
  return EMPTY
}

function write(store: ServerStore): void {
  localStorage.setItem(KEY, JSON.stringify(store))
}

function newId(): string {
  return uuid()
}

export function loadServers(): ServerSettings[] {
  return read().servers
}

/** The connection every request in the app uses, or null when there is none. */
export function loadSettings(): ServerSettings | null {
  const { servers, activeId } = read()
  return servers.find((s) => s.id === activeId) ?? servers[0] ?? null
}

/** Adds a connection (or updates the one with the same URL) and activates it. */
export function saveSettings(settings: Omit<ServerSettings, "id"> & { id?: string }): ServerSettings {
  const store = read()
  const existing = store.servers.find((s) => s.id === settings.id || s.url === settings.url)
  const entry: ServerSettings = { ...settings, id: existing?.id ?? settings.id ?? newId() }
  store.servers = existing
    ? store.servers.map((s) => (s.id === entry.id ? entry : s))
    : [...store.servers, entry]
  store.activeId = entry.id
  write(store)
  return entry
}

export function setActiveServer(id: string): void {
  const store = read()
  if (!store.servers.some((s) => s.id === id)) return
  write({ ...store, activeId: id })
}

/** Forgets one connection; the next one in the list becomes active.
    Its saved workspace layout goes with it — the key is per server, and a
    layout nothing can reach again is a key that never gets collected. */
export function removeServer(id: string): void {
  const store = read()
  const servers = store.servers.filter((s) => s.id !== id)
  write({ servers, activeId: store.activeId === id ? (servers[0]?.id ?? null) : store.activeId })
  clearLayout(id)
}

/** Disconnect: forget the active connection. */
export function clearSettings(): void {
  const active = loadSettings()
  if (active) removeServer(active.id)
}

/**
 * A failed call to the server, with everything worth reading kept separate
 * instead of flattened into one string: the status, the endpoint, and whatever
 * the server put in the body (a `{ error }` message, or a zod issue list).
 * `status === 0` means the request never reached the server at all.
 * lib/errors turns this into the text the user sees.
 */
export class ApiError extends Error {
  readonly status: number
  readonly path: string
  /** Parsed response body, when it was JSON. */
  readonly body: unknown
  /** The server's own message, if it sent one. */
  readonly serverMessage?: string

  constructor(args: { status: number; path: string; body?: unknown; serverMessage?: string }) {
    super(`${args.path}: ${args.status}${args.serverMessage ? ` ${args.serverMessage}` : ""}`)
    this.name = "ApiError"
    this.status = args.status
    this.path = args.path
    this.body = args.body
    this.serverMessage = args.serverMessage
  }

  /** Headline for the status — the server rarely explains these itself. */
  get title(): string {
    if (this.status === 401 || this.status === 403) return "The server rejected this token"
    if (this.status === 404) return "The server doesn't have that any more"
    if (this.status === 400) return "The server rejected the request"
    if (this.status >= 500) return "The server hit an error"
    return "The request failed"
  }
}

export async function api<T>(
  settings: ServerSettings,
  path: string,
  init?: RequestInit
): Promise<T> {
  let res: Response
  try {
    res = await fetch(new URL(path, settings.url), {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.token}`,
        ...init?.headers,
      },
    })
  } catch (cause) {
    // Offline, wrong host, TLS refusal, CORS — fetch rejects the same way for
    // all of them, and none of them ever reached a status.
    throw new ApiError({
      status: 0,
      path,
      serverMessage: cause instanceof Error ? cause.message : String(cause),
    })
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let body: unknown = text
    let serverMessage = text.trim() || undefined
    try {
      body = JSON.parse(text)
      // The server answers errors as { error: string | zodIssue[] }.
      const error = (body as { error?: unknown } | null)?.error
      if (typeof error === "string") serverMessage = error
      else if (error !== undefined) body = error
    } catch {
      /* not JSON — the raw text is the message */
    }
    throw new ApiError({ status: res.status, path, body, serverMessage })
  }

  // A 200 with a body we can't parse is still a failure, and "Unexpected token
  // < in JSON" (a proxy's HTML error page) needs to say where it came from.
  try {
    return (await res.json()) as T
  } catch (cause) {
    throw new ApiError({
      status: res.status,
      path,
      serverMessage: `The server's response was not JSON (${cause instanceof Error ? cause.message : String(cause)})`,
    })
  }
}

export function wsUrl(settings: ServerSettings, sessionId: string, cursor: number): string {
  const url = new URL("/ws", settings.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", settings.token)
  url.searchParams.set("sessionId", sessionId)
  url.searchParams.set("cursor", String(cursor))
  // Ask for the replay in bulk. Older servers ignore the parameter and stream
  // it one event at a time, which this client still handles.
  url.searchParams.set("batch", "1")
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

/** A reusable slash command: materialized into <cwd>/.claude/commands at spawn,
    so the agent advertises it over ACP like any of its own. */
export interface CommandDef {
  id: string
  /** Invocation name — `/name` in the composer, `<name>.md` on disk. */
  name: string
  description: string
  /** Placeholder shown while the arguments are still untyped. */
  argumentHint: string | null
  /** Markdown prompt body; `$ARGUMENTS` receives the typed arguments. */
  content: string
}

/** Entries discovered in the agents' own configs, offered for import. */
export interface ImportCandidates {
  mcpServers: (Omit<McpServerDef, "id"> & { source: string })[]
  skills: (Omit<SkillDef, "id"> & { source: string })[]
  commands: (Omit<CommandDef, "id"> & { source: string })[]
}

/** Agent configuration used in a session (credentials, models). */
export interface Profile {
  id: string
  name: string
  agentId: string
  baseUrl: string
  hasApiKey: boolean
  /** Synthesized by the server for an agent with no profile of its own: the
      agent exactly as it ships, owning its own models and settings. Not stored,
      so it cannot be edited or deleted — make a real profile to override it. */
  virtual?: boolean
  models: ModelOption[]
  defaultModel: string
  /** Model for the agent's cheap side-jobs (Claude Code's Bash permission
      classifier above all). Empty means "the session model". Not one of
      `models`: nothing may pick it for a thread. */
  smallModel?: string
  /** Replace the agent's built-in web tools with the harness's web-search MCP
      server. A profile opts in; null means off. The rest override the server
      default, and the token is redacted (never sent back). */
  webSearch?: {
    enabled: boolean
    searchApiBaseUrl?: string
    searchApiToken?: undefined
    searchModel?: string
    fetchModel?: string
    hasWebSearchToken?: boolean
  }
  /** Opt the agent into the harness's `knowledge` MCP server. Off by default. */
  knowledge?: { enabled: boolean }
}

export interface ModelOption {
  id: string
  label: string
  contextWindow?: number
  maxOutputTokens?: number
  /** Effort levels the model accepts; empty = no effort control. */
  reasoningEfforts: string[]
  /** One-line capability blurb, when known (models.dev or the agent). */
  description?: string
  /** USD per million tokens. */
  pricing?: { input: number; output: number }
  /** Input modalities, e.g. ["text", "image"]. */
  modalities?: string[]
  /** Provenance when enriched: "providerId/modelId" in models.dev. */
  devRef?: string
}

/** A model the agent itself advertised (POST /api/profiles/:id/fetch-models),
    or a models.dev search hit — a candidate for a profile's `models[]`. */
export interface ModelCandidate extends ModelOption {
  providerId?: string
  providerName?: string
}

/** A provider in models.dev's catalog (GET /api/models-dev/providers). */
export interface ModelsDevProvider {
  id: string
  name: string
}

/** Workspace a session runs in. */
export interface Project {
  id: string
  name: string
  cwd: string
  /** Optional free-text notes; null on rows created before the field existed. */
  description: string | null
  mcpServerIds: string[]
  skillIds: string[]
  commandIds: string[]
}

/** One directory on the server, as `GET /api/fs/list` reports it. */
export interface FsListing {
  cwd: string
  parent: string | null
  entries: { name: string; type: "dir" | "file" }[]
  truncated: boolean
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
  /** Epoch ms this thread was deleted; null = live. Deleted threads still come
      down the wire — they live in Trash until they are purged or restored. */
  deletedAt: number | null
  attached: boolean
  /** How many clients are attached — several devices may share one thread. */
  peerCount?: number
  exited: boolean
  promptActive: boolean
  cursor: number
  /** Client-only: this thread has been opened but never sent a message, so the
      server has never heard of it and no agent process exists. It holds a real
      id (the client mints it) and becomes an ordinary session the moment the
      first prompt creates it. Everything that treats the server's list as the
      authority — the dock, the tab strip, the pruning in `refreshSessions` —
      has to let these through; see `lib/drafts.ts` for the sibling problem. */
  draft?: boolean
  /** Client-only, draft-only: settings picked against the option set the agent
      last advertised (`lib/agent-options`), replayed once session/new answers. */
  configChoices?: Record<string, string | boolean>
}

/** A scheduled prompt: the server sends `text` to `sessionId`'s agent at
    `nextAt`, and again every `everyMs` until cancelled. The server owns
    delivery — a browser tab closing must not stop a scheduled turn. */
export interface ScheduledMessage {
  id: string
  sessionId: string
  text: string
  /** Epoch ms of the next scheduled fire. */
  nextAt: number
  /** Recurrence interval in ms; null = one-shot. */
  everyMs: number | null
  createdAt: number
}

