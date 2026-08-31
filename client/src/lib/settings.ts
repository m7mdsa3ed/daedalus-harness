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

/** Relabels a connection without touching which one is active — unlike
    `saveSettings`, which always activates the entry it writes. */
export function renameServer(id: string, name: string): void {
  const store = read()
  write({ ...store, servers: store.servers.map((s) => (s.id === id ? { ...s, name } : s)) })
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

export function wsUrl(
  settings: ServerSettings,
  sessionId: string,
  cursor: number,
  window: number
): string {
  const url = new URL("/ws", settings.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("token", settings.token)
  url.searchParams.set("sessionId", sessionId)
  url.searchParams.set("cursor", String(cursor))
  // Ask for the replay in bulk. Older servers ignore the parameter and stream
  // it one event at a time, which this client still handles.
  url.searchParams.set("batch", "1")
  /* Ask for only the tail of a very long thread, and page the rest back on
     demand (`load_earlier`). The window is in **steps** (turns), so the
     replay is always whole turns. Also ignored by an older server, which
     sends the whole log — the same transcript, just paid for up front. */
  if (window > 0) url.searchParams.set("window", String(window))
  return url.toString()
}

// ---- server API types ----

export interface AgentDef {
  id: string
  name: string
  /** Whether this runtime can be moved to another profile, model or effort
      without being restarted, and how (server/src/registry.ts). The client
      reads it for one thing only: whether a pick is worth warning about first.
      The server still decides what each change actually costs. */
  liveConfig?: "acp" | "gateway" | null
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

/** One of the harness's own servers, in the library as a row that holds
    nothing but which one it is — command, env and credentials are synthesized
    at spawn from the server's config and the thread's project. Injected from
    the MCP page rather than typed in. */
export interface McpServerBuiltin {
  type: "builtin"
  name: string
  builtin: "web-search" | "knowledge" | "workflow"
}

/** Library entries projects, profiles and threads link to by id. */
export type McpServerDef = (McpServerStdio | McpServerHttp | McpServerBuiltin) & { id: string }

/** The one-line description a picker shows under an MCP server's name. */
export function mcpSubtitle(s: McpServerDef): string {
  if (s.type === "builtin") {
    if (s.builtin === "web-search") return "built-in · web search + fetch"
    if (s.builtin === "workflow") return "built-in · workflows"
    return "built-in · project knowledge base"
  }
  return s.type === "http" ? s.url : [s.command, ...s.args].join(" ")
}

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

/** What a profile says about one of the agents it can spawn. The key set of
    `Profile.agents` is the contract (which runtimes this provider serves); the
    value is the little that differs per agent on one provider. */
export interface ProfileAgentLink {
  /** Overrides the profile's shared baseUrl for this agent only — a gateway
      often serves Claude Code and Codex at different paths. Empty = shared. */
  baseUrl?: string
}

/** Which provider API answers "how much of this plan is left" — the profile's
    own reader, which outranks the agent's `/usage` CLI probe whenever it is set.
    `kind` picks a server-side adapter (`server/src/usage-api.ts`); everything
    else about the endpoint, the auth shape and the response is that adapter's,
    deliberately, so this stays a choice and not a small URL language. */
export type ProfileUsageKind = "none" | "zai"

export interface ProfileUsage {
  kind: ProfileUsageKind
  /** Override the adapter's default host, or name the full endpoint outright.
      Empty means the adapter decides. */
  baseUrl: string
  /** Like `Profile.hasApiKey`: the separate dashboard token, if one is stored,
      reported as a boolean. Empty on save means "keep the stored one". */
  hasApiKey: boolean
}

/** Provider configuration used in a session (credentials, models). Not bound
    to one agent: `agents` names every runtime it can spawn, and a thread is a
    (profile, agent) pair chosen when it is started. */
export interface Profile {
  id: string
  name: string
  agents: Record<string, ProfileAgentLink>
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
  /** Logo shown next to the profile in pickers — a URL. Empty means "no logo
      of its own": the client falls back to the agent's mark, which is also
      what the virtual Default profile always shows. */
  logoUrl?: string
  /** How this provider's subscription usage is read, when it sells one and
      exposes an API for it. Null/absent means there is none, and the agent's
      own probe (the machine's `claude`/`codex login`) answers instead. */
  usage?: ProfileUsage | null
  /** Library entries every thread on this profile gets, on top of its
      project's. The same three a project and a thread carry; the agent sees
      the union. */
  mcpServerIds: string[]
  skillIds: string[]
  commandIds: string[]
}

/** The agents a profile can spawn, in the order they were saved. */
export const profileAgentIds = (profile: Pick<Profile, "agents">): string[] =>
  Object.keys(profile.agents ?? {})

export const profileSupports = (profile: Pick<Profile, "agents">, agentId: string): boolean =>
  Object.hasOwn(profile.agents ?? {}, agentId)

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

/** Workspace a session runs in. */
export interface Project {
  id: string
  name: string
  cwd: string
  /** Optional free-text notes; null on rows created before the field existed. */
  description: string | null
  /** Logo shown wherever the project is named — a URL. Empty means "no logo",
      and `ProjectIcon` draws the project's initial instead. */
  logoUrl?: string
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
  /** Epoch ms of the newest turn on this thread — what every "recent" list
      orders by. Creation is not activity: a thread from last month picked up
      this morning is the most recent one there is, and ordering by `createdAt`
      buried it. Absent from a server that predates it, which is what
      `activityAt` falls back for. */
  lastActivityAt?: number
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
  /** This thread's own library picks, on top of what its project and profile
      link. Chosen on the draft, sent with `POST /api/sessions`, and reported
      back by the server for the thread's life. */
  mcpServerIds?: string[]
  skillIds?: string[]
  commandIds?: string[]
  /** The thread this one is a workflow step of; such threads are hidden from
      the lists and reached from the parent's subagent row or by URL. */
  parentSessionId?: string | null
}

/** A thread that is nobody's workflow step — the only kind the lists show. */
export const isTopLevel = (s: SessionMeta): boolean => !s.parentSessionId

/** When this thread was last *worked in* — the one clock every list sorts and
    groups by. A draft and a server too old to report activity have only their
    creation to go on, which is the same answer for a thread nothing has
    happened in yet. */
export const activityAt = (s: SessionMeta): number => s.lastActivityAt || s.createdAt

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
  /** 1 = active; 0 = paused (the sweep never selects it). SQLite boolean. */
  enabled: number
  /** Epoch ms of the last sweep that could not deliver, or null. */
  skippedAt: number | null
  /** Why the last sweep skipped it (trashed/vanished thread), or null. */
  lastError: string | null
  /** Consecutive undeliverable sweeps; past the server's cap (20) the row is
      parked — still listed, never selected — until a patch resets it. */
  skipCount: number
  createdAt: number
}

/** `PATCH /api/scheduled/:id` body. Any patch — even a bare pause/resume —
    also resets the row's skip state server-side, so "Resume" on a parked
    schedule is just `{enabled: true}`. `everyMs: null` clears the recurrence. */
export interface ScheduledPatch {
  text?: string
  nextAt?: number
  everyMs?: number | null
  enabled?: boolean
}

export async function updateScheduled(
  settings: ServerSettings,
  id: string,
  patch: ScheduledPatch
): Promise<ScheduledMessage> {
  return api<ScheduledMessage>(settings, `/api/scheduled/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
}

