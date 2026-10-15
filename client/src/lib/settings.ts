// Server connections live in localStorage — the web build ships with no
// baked-in server; the user enters URL + token on the connect screen. Several
// servers can be stored at once; one of them is active (switched in the
// sidebar), and the active one is what every request in the app talks to.

import { uuid } from "./uuid"
import { clearPersistedCache } from "./queries/persist"
import { clearDraftSessions } from "./draft-sessions"
import { clearActiveSpace } from "./spaces"
import { clearRightPanelState } from "./right-panel"

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

/** Told when the active connection changes, so the app can re-bootstrap
    against it in place rather than reloading the page. */
const activeListeners = new Set<() => void>()

export function subscribeActiveServer(fn: () => void): () => void {
  activeListeners.add(fn)
  return () => {
    activeListeners.delete(fn)
  }
}

export function setActiveServer(id: string): void {
  const store = read()
  if (!store.servers.some((s) => s.id === id)) return
  if (store.activeId === id) return
  write({ ...store, activeId: id })
  for (const fn of activeListeners) fn()
}

/** Relabels a connection without touching which one is active — unlike
    `saveSettings`, which always activates the entry it writes. */
export function renameServer(id: string, name: string): void {
  const store = read()
  write({ ...store, servers: store.servers.map((s) => (s.id === id ? { ...s, name } : s)) })
}

/** Forgets one connection; the next one in the list becomes active.
    Its persisted query cache goes with it — the key is per server, and state nothing can reach again is a key that never
    gets collected. */
export function removeServer(id: string): void {
  const store = read()
  const servers = store.servers.filter((s) => s.id !== id)
  write({ servers, activeId: store.activeId === id ? (servers[0]?.id ?? null) : store.activeId })
  clearRightPanelState()
  // The space this device was looking at: an id that names a row on a server
  // nothing can reach again.
  clearActiveSpace(id)
  // Its unsent threads too: their ids were minted against that server.
  clearDraftSessions(id)
  // Its cached description goes with its credentials: the rows are no use
  // without a token to refresh them. See lib/queries/persist.
  clearPersistedCache(id)
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
    // A cancelled request (the caller's own AbortController) is not a network
    // failure — rethrow it so a query library sees its own cancellation and
    // does not count it as retryable.
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause
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

/** One agent's install state and what it reports over ACP
    (`GET /api/agents/status`, server/src/agent-status.ts). A reading about
    this machine, never stored: `installed` is whether the row's command is on
    the server's PATH (and every absolute path in its args exists), `install`
    is the line that puts it there, and `agent`/`protocolVersion` are the
    `initialize` answer. `error` is a binary that is present but did not
    complete a handshake. */
export interface AgentStatus {
  agentId: string
  command: string
  installed: boolean
  path: string | null
  missing: string | null
  install: string | null
  protocolVersion: number | null
  agent: { name: string; title: string | null; version: string | null } | null
  error: string | null
  /** The newest published version, when the row's install line names an npm
      package. Null means "not askable", never "up to date". */
  latest: string | null
  checkedAt: number
}

export interface AgentsStatus {
  /** The harness's own half: the ACP SDK it is built on and the protocol
      version it opens every handshake with. */
  acp: { sdkVersion: string; protocolVersion: number }
  agents: AgentStatus[]
}

export interface AgentDef {
  id: string
  name: string
  /** The editable half (Settings › Agents). Optional so a payload from a
      server that predates the editor still parses. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Whether this release still defines a default for the row — i.e. whether
      there is anything to reset to. Computed server-side, never stored. */
  builtIn?: boolean
  /** Whether this runtime can be moved to another profile, model or effort
      without being restarted, and how (server/src/registry.ts). The client
      reads it for one thing only: whether a pick is worth warning about first.
      The server still decides what each change actually costs. */
  liveConfig?: "acp" | "gateway" | null
  /** How this runtime is asked what is left of its plan (server/src/quota.ts),
      or null/absent for one that cannot be asked. The client reads it for one
      thing only: whether a thread on this agent's Default profile — the
      machine's own login — has a plan reading to draw at all. */
  quotaProbe?: { kind: string; command: string; args: string[] } | null
  /** Which door this runtime opens for a rewind's conversation half
      (server/src/registry.ts). `"acp-fork-point"` = the agent honors the
      fork point `session/fork` needs; null/absent = the conversation half is
      not offered (files can still be restored). The server still refuses what
      it cannot do — this only decides what the client offers. */
  rewindVia?: "acp-fork-point" | null
  /** Where this runtime reads the skills and commands the harness projects
      into a project's cwd (server/src/registry.ts). The client reads it for
      one thing: whether to say, where they are picked, that this runtime does
      not read them — a link that lands somewhere nothing looks used to be
      indistinguishable from one that works. */
  workspaceLayout?: { dir: string; skills?: string | null; commands?: string | null } | null
  /** Whether this runtime's subagents take helper models (docs/model-roles.md):
      `"acp-env"` is ours, and the only one. The client reads it for one thing —
      whether the menus offer Helper models at all. */
  subagentModelsVia?: "acp-env" | null
  /** The shell line that installs this agent's binary, shown beside a row
      measured as missing. Editable, like `icon`. */
  install?: string | null
  /** The row's mark: a URL (the built-ins ship `data:` URIs), or `"app"` for
      the harness's own runtime. Null draws a neutral glyph. */
  icon?: string | null
}

export interface McpServerStdio {
  type: "stdio"
  name: string
  logoUrl?: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}

export interface McpServerHttp {
  type: "http"
  name: string
  logoUrl?: string
  url: string
  headers: { name: string; value: string }[]
  /** How the row authenticates. `"none"` is a plain URL, possibly with static
      headers somebody typed (a PAT). `"oauth"` means the tokens live on the
      server and the agent is handed a loopback shim URL, never this one — see
      `server/src/mcp-shim.ts`. A stored answer, discovered by the probe. */
  auth: "none" | "oauth"
}

/** What the list route says about an `http` row's OAuth connection. Derived
    server-side from the join; the tokens themselves never leave the server,
    exactly as a profile's `apiKey` never does. */
export type McpAuthState =
  | { kind: "none" }
  | {
      kind: "oauth"
      state: "connected" | "expired" | "disconnected"
      /** Unix ms, or null when the authorization server reported no expiry. */
      expiresAt: number | null
      issuer: string
      scope: string | null
      /** Why the last attempt failed — so the row can say so instead of just
          going quiet. */
      error: string | null
    }

/** What `POST /api/mcp-servers/probe` answers: does this URL demand OAuth?
    `unknown` is deliberately not "yes" — a 403 from a corporate proxy must
    not read as "needs authorization". */
export type McpAuthProbe =
  | { kind: "none" }
  | { kind: "oauth"; resource: string; issuer: string; scopesSupported: string[] }
  | { kind: "unknown"; status: number; detail: string }

/** What `POST /api/mcp-servers/:id/check` answers: the server was connected to
    the way a thread's agent would, and this is what it advertises. `ok: false`
    carries the reason in `error` — a refusal is an answer, not a request that
    failed, so it is a 200. */
export interface McpCheckEntry {
  name: string
  description?: string
  /** A tool's JSON Schema, as the server declared it. */
  inputSchema?: unknown
  /** A tool's declared output schema, where it declares one. */
  outputSchema?: unknown
  /** A prompt's declared arguments. */
  arguments?: { name: string; description?: string; required?: boolean }[]
  /** A resource's URI and type; `name` is the URI, which is what identifies
      one, so the human name (where there is one) is the description. */
  uri?: string
  mimeType?: string
}

/** One MCP call: what the server answered, whole. `error` is the call that
    never happened — a tool that ran and failed comes back as a result carrying
    `isError`, which is an answer. */
export interface McpCallResult {
  ok: boolean
  ms: number
  result?: unknown
  error?: string
}
export interface McpCheckResult {
  ok: boolean
  ms: number
  serverInfo?: { name: string; version: string; icon?: string }
  tools: McpCheckEntry[]
  prompts: McpCheckEntry[]
  resources: McpCheckEntry[]
  /** URI templates (RFC 6570); `uri` holds the template. */
  resourceTemplates?: McpCheckEntry[]
  /** The server's own word on how it wants to be used. */
  instructions?: string
  /** The capability keys the server declared, with their sub-flags. */
  capabilities?: Record<string, unknown>
  error?: string
  /** Unix ms of the connection this listing came from — absent on the two
      answers the server gives without connecting at all. */
  checkedAt?: number
  /** This server deliberately defers its first connection until explicit Check. */
  deferred?: boolean
}

/** One of a thread's MCP servers as the composer reads it
    (`GET /api/sessions/:id/mcp`): what it offers a person, not the agent. */
export interface ThreadMcpServer {
  id: string
  name: string
  ok: boolean
  prompts: McpCheckEntry[]
  resources: McpCheckEntry[]
  resourceTemplates: McpCheckEntry[]
  completions: boolean
}

/** One row of the marketplace (`GET /api/mcp-registry`): a server published to
    an MCP Registry, already mapped to what this library stores. `server` is
    what the form is prefilled with — installing is the ordinary save, so
    nothing here is a second way to write a row. */
export interface RegistryEntry {
  id: string
  qualifiedName: string
  description: string
  version: string
  repositoryUrl: string | null
  logoUrl: string | null
  via: string
  server: McpServerStdio | McpServerHttp
  /** Placeholders and required variables the publisher left for the user. */
  needs: string[]
}

/** One of the harness's own servers, in the library as a row that holds
    nothing but which one it is — command, env and credentials are synthesized
    at spawn from the server's config and the thread's project. Injected from
    the MCP page rather than typed in. */
export interface McpServerBuiltin {
  type: "builtin"
  name: string
  builtin: "web-search" | "knowledge" | "workflow" | "agents" | "harness" | "browser"
  /** Only ever present on the rows whose server is synthesized from a *thread*
      (`workflow`, `agents`, `harness`, `browser`): its connection is the
      calling thread's own, so no session means nothing to connect to — the
      settings list explains that rather than reading a server that is not
      there. Absent on `web-search` and `knowledge`, which resolve without one. */
  threadScoped?: boolean
}

/** Library entries projects, profiles and threads link to by id. */
export type McpServerDef = (McpServerStdio | McpServerHttp | McpServerBuiltin) & {
  id: string
  /** Only ever present on an `http` row the list route answered for; absent
      on a row this client wrote optimistically. */
  authState?: McpAuthState
}

/** Does this row resolve to nothing at spawn? An OAuth server nobody has
    connected is not advertised to the agent at all — the rule the built-in
    web-search row already sets, that a tool which cannot answer is worse than
    an absent one — so the thread's tools read-out marks it rather than
    listing a server that is not there. */
export function mcpNeedsAuth(s: McpServerDef): boolean {
  return s.type === "http" && s.auth === "oauth" && s.authState?.kind === "oauth" && s.authState.state !== "connected"
}

/** The one-line description a picker shows under an MCP server's name. */
export function mcpSubtitle(s: McpServerDef): string {
  if (s.type === "builtin") {
    if (s.builtin === "web-search") return "built-in · web search + fetch"
    if (s.builtin === "workflow") return "built-in · workflows"
    if (s.builtin === "agents") return "built-in · ask other agents"
    if (s.builtin === "harness") return "built-in · manage the harness"
    if (s.builtin === "browser") return "built-in · drive the thread's preview"
    return "built-in · project knowledge base"
  }
  if (s.type !== "http") return [s.command, ...s.args].join(" ")
  return s.auth === "oauth" ? `${s.url} · ${authSummary(s.authState)}` : s.url
}

/** The OAuth half of an `http` row's subtitle, in words. */
export function authSummary(state: McpAuthState | undefined): string {
  if (!state || state.kind !== "oauth") return "OAuth"
  if (state.state === "disconnected") return "needs authorization"
  if (state.state === "expired") return "authorization expired"
  return state.expiresAt ? `connected · ${expiresIn(state.expiresAt)}` : "connected"
}

/** "expires in 42m" / "expired", coarse on purpose: the exact second is not a
    thing anybody acts on, and the shim renews it without being asked. */
export function expiresIn(at: number): string {
  const ms = at - Date.now()
  if (ms <= 0) return "expired"
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `expires in ${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `expires in ${hours}h` : `expires in ${Math.round(hours / 24)}d`
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

/** A saved prompt: reusable text, mentioned as `@handle` in the composer. The
    client sends the literal handle; the server expands it at send time. */
export interface SavedPrompt {
  id: string
  /** The handle, without the `@`. */
  name: string
  /** Display name, e.g. `QuickFix`; empty falls back to the handle. */
  title: string
  description: string
  prompt: string
  /** 0 for a prompt the user made; the seed release for a built-in. */
  seededVersion: number
  sortOrder: number
}

/** A model prompt: instruction text assigned to a model by id or glob pattern,
    so a thread running Gemini is told it is Gemini and Qwen is told what Qwen
    needs. The auto-detect half lives in the runtime as built-in family
    calibrations; these rows are the assignment half — "this text, for every
    model whose id matches" — and win over the built-ins. */
export interface ModelPrompt {
  id: string
  name: string
  /** Glob over the model id, matched case-insensitively. No `*` = exact id. */
  match: string
  /** The instruction block, appended as a layer of the agent's system prompt. */
  prompt: string
  enabled: boolean
  sortOrder: number
  /** 0 for a row the user made; the seed release for a built-in. */
  seededVersion: number
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
export type ProfileUsageKind =
  | "none"
  | "zai"
  | "minimax"
  | "kimi"
  | "synthetic"
  | "deepseek"
  | "openrouter"
  | "command-code"
  | "9router"

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
  /** Opt out of Codex's "Model metadata … not found. Defaulting to fallback
      metadata" notice for threads on this profile. Absent = false (servers
      from before the flag existed, and the virtual Default). */
  suppressModelMetadataWarning?: boolean
  /** Seconds the server waits for this provider's response headers before
      aborting. Null/absent = the server's default (10 minutes). */
  upstreamTimeoutSeconds?: number | null
  /** Two selection flags. `hidden`: kept and still resolvable for the threads
      already on it, but not offered when starting a new thread — while the
      usage plan keeps tracking it, which is the point of hiding. `disabled`:
      closed everywhere — the pickers and the usage plan both. Absent = shown
      and enabled (servers from before the flags existed, and the virtual
      Default, which can never be either). */
  hidden?: boolean
  disabled?: boolean
}

/** A coding plan a new profile can start from (`server/src/profile-presets.ts`):
    the endpoints per runtime, the plan's catalog (read from models.dev by the
    server), and which usage reader reports it. Filling the form is a copy of
    these fields; nothing about the preset is stored on the saved profile. */
export interface ProfilePreset {
  id: string
  name: string
  description: string
  keyUrl: string
  logoUrl: string
  baseUrl: string
  agents: Record<string, ProfileAgentLink>
  modelsDevProvider: string
  defaultModel: string
  smallModel?: string
  usage: ProfileUsageKind
  models: ModelCandidate[]
  /** models.dev could not be read: an empty `models` is not "no models". */
  modelsUnavailable: boolean
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
  /** USD per million tokens, at full price. */
  pricing?: { input: number; output: number }
  /** Input modalities, e.g. ["text", "image"]. */
  modalities?: string[]
  /** Provenance when enriched: "providerId/modelId" in models.dev. */
  devRef?: string
  /** Optional URL for a model-specific icon. When set, the composer trigger
      shows this icon instead of the profile's logo. */
  iconUrl?: string
  /** User-defined group label for organising models in the picker. */
  group?: string
  /** Model-role ids (`ModelRole.id`) this model serves — a subagent spawned on
      a role runs on the first model carrying it. Absent/empty = none. */
  roles?: string[]
}

/** A model-role row (`model_roles`): the free-form, ordered vocabulary a
    profile's models tag themselves with, so a subagent is spawned on a role
    rather than on a hardcoded "small" model. `id` is what an assignment points
    at and is stable; `label` is what a person reads. See docs/model-roles.md. */
export interface ModelRole {
  id: string
  label: string
  description: string
  sortOrder?: number
}

/** A model the agent itself advertised (POST /api/profiles/:id/fetch-models),
    or a models.dev search hit — a candidate for a profile's `models[]`. */
export interface ModelCandidate extends ModelOption {
  providerId?: string
  providerName?: string
}

/** A named scope *above* projects — "Personal", "Work". The spaces are the
    server's (`GET /api/spaces`); which one this device is looking at is
    device-local (`lib/spaces`), because how you are looking at the work is the
    reader's property. A profile is a provider and a project is a directory; a
    space is deliberately neither. */
export interface Space {
  id: string
  name: string
  sortOrder: number
  createdAt: number
}

/** Workspace a session runs in. */
export interface Project {
  id: string
  name: string
  cwd: string
  /** The space this project is filed under (a `Space.id`). Absent only on a
      stub; every row the server answers names one, so the sidebar's filter is a
      plain equality. */
  spaceId?: string
  /** Optional free-text notes; null on rows created before the field existed. */
  description: string | null
  /** Logo shown wherever the project is named — a URL. Empty means "no logo",
      and `ProjectIcon` draws the project's initial instead. */
  logoUrl?: string
  /** The project's dev server, as the Browser panel should open it. Empty
      means none. What it is reachable *at* is the person's own call —
      `localhost` for the machine the server runs on, a LAN or tunnel address
      for a phone. */
  previewUrl?: string
  /** Standing rules every thread spawned here starts with — the project layer
      of `server/src/rules.ts`, beneath the global block. Null = none. */
  rules?: string | null
  /** The helper commands a person runs against this workspace by hand, from
      the project page's header ("Run migrations"). Absent on stubs, like the
      other optional fields. */
  helpers?: HelperCommand[]
  /** How a thread started in this project opens — the profile/agent pair, the
      model and effort, the permission mode, the agent's other selectors, the
      tool picks and the two instruction toggles. Written by the
      composer as you pick (`rememberThreadDefaults`), so changing the project
      changes what a new thread in it is configured with.

      Absent on stubs, like the other optional fields; a project the server
      answers always carries it, with every field present and `""` as the
      empty pick. */
  defaults?: ProjectDefaults
}

/**
 * What a thread started in a project opens on (`projects.default_*`).
 *
 * The client's shape, not the row's: every field is present and `""` is the
 * empty pick everywhere it appears — no model (the agent's own), no effort,
 * no mode. A project nobody has configured reads as all of this
 * empty, which is exactly what a draft with nothing remembered holds.
 */
export interface ProjectDefaults {
  profileId: string
  agentId: string
  model: string
  effort: string
  modeId: string
  configChoices: Record<string, string | boolean>
  /** The role→model helper map a thread here opens on (docs/model-roles.md):
      one entry per role, `model: ""` for the session model. */
  helperModels: { role: string; model: string }[]
  mcpServerIds: string[]
  skillIds: string[]
  commandIds: string[]
  suggestFollowups: boolean
  uiBlocks: boolean
}

/** One of a project's helper commands: a shell line run on the project's
    behalf, with where and how it runs. `server/src/project-helpers.ts` owns
    the rows and the run. */
export interface HelperCommand {
  id: string
  projectId: string
  name: string
  command: string
  /** Project-relative directory to run in; null = the project's cwd. */
  cwd: string | null
  /** Extra environment variables layered over the server's own. */
  env: Record<string, string> | null
  description: string | null
  /** Ask before running — the dialog shows a confirm step first. */
  confirm: boolean
  /** This helper starts the project's dev server — the Browser panel offers
      it when a preview URL is set but nothing answers on it. */
  preview: boolean
  createdAt: number
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
  /** Whether the agent closes answers with follow-up prompt suggestions.
      Absent from a server that predates the toggle, which reads as off. */
  suggestFollowups?: boolean
  /** Whether answers may carry a drawn view (a fenced `openui-lang` block the
      client renders). Absent from a server that predates the switch, which
      reads as on — the default the row carries. */
  uiBlocks?: boolean
  title: string
  acpSessionId?: string
  createdAt: number
  /** Epoch ms of the newest turn on this thread — what every "recent" list
      orders by. Creation is not activity: a thread from last month picked up
      this morning is the most recent one there is, and ordering by `createdAt`
      buried it. Absent from a server that predates it, which is what
      `activityAt` falls back for. */
  lastActivityAt?: number
  /** How this thread's newest turn failed, or null/absent when it did not.
      The server's, written on the same turn boundary that moves
      `lastActivityAt` and cleared by the next turn — which is what lets a list
      say "this one ended badly" about a thread no tab has open. The live
      transcript records the same failure as a row of its own; this is the one
      line a row can show. */
  lastTurnError?: string | null
  /** Epoch ms this thread was deleted; null = live. Deleted threads still come
      down the wire — they live in Trash until they are purged or restored. */
  deletedAt: number | null
  /** Epoch ms this thread was pinned; null/absent = not pinned. The server's,
      so a pin follows the thread to every device — and the timestamp is also
      the order the pinned group is drawn in (oldest pin first). */
  pinnedAt?: number | null
  attached: boolean
  /** How many clients are attached — several devices may share one thread. */
  peerCount?: number
  exited: boolean
  promptActive: boolean
  /** Live state off the server's bridge, for a list that has no socket to the
      thread (the agents dashboard): the agent is blocked on a permission or a
      question, or its turn is held at a failure. A snapshot — the live thread
      outranks it wherever a tab has one. Absent from an older server. */
  waiting?: boolean
  held?: boolean
  /** The newest context reading the server holds (`sessions.context`). */
  context?: { used: number; size: number } | null
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
  /** Client-only, draft-only: the permission mode picked before the thread
      exists, from the agent's remembered `modes` (`lib/agent-options`). Applied
      by the server right after session/new; once the thread runs, its own
      `modes` state is the only truth and this is dead weight the merge drops. */
  modeId?: string
  /** The thread's helper models (docs/model-roles.md): one entry per role in
      the thread's own order, `role` a `ModelRole.id` and `model` a profile
      model id (`""` = the session model). A spawn input like `model`/`effort`,
      so a change costs a respawn — chosen on the draft menu and edited on a
      started thread through the config route. Absent from a server that
      predates it, which reads as none. */
  helperModels?: { role: string; model: string }[]
  /** This thread's library picks. Staged changes are overlaid from live thread
      state until the next spawn applies them. */
  mcpServerIds?: string[]
  skillIds?: string[]
  commandIds?: string[]
  /** The thread this one is a workflow step of; such threads are hidden from
      the lists and reached from the parent's subagent row or by URL. */
  parentSessionId?: string | null
  /** Where this thread was forked from: the parent thread and the turn the
      branch carries through. Provenance only — drawn as a chip in the header,
      never a query. A fork is its own thread in every other respect (unlike
      `parentSessionId`, it hides nothing). */
  forkedFromSessionId?: string | null
  forkedFromTurnId?: string | null
  /** An aside: the passage it was started on, selected in the thread
      `forkedFromSessionId` names. Set = flagged as an aside everywhere. */
  asideQuote?: string | null
  /** The board task this thread was started on. The server briefs the agent
      with it and moves the card; the client only draws the link both ways. */
  taskId?: string | null
  /** The git worktree this thread runs in (server-side `git.createWorktree`):
      its project-relative path — which is also its `repo` for source control
      — the branch it was made on, and whether it is still on disk (absent
      when the server has not looked since boot, which reads as there). */
  worktree?: { path: string; branch: string; exists?: boolean } | null
  /** Client-only, draft-only: "Isolate in a git worktree", sent with the
      create. */
  isolate?: boolean
}

/**
 * One page of the sidebar's thread list (`GET /api/sessions/page`).
 *
 * The sidebar loads threads on demand rather than pulling every thread the
 * server holds, so the list it draws is a *window*: `sessions` is the page,
 * `total` is how many live threads sit behind it (what "load more" counts
 * against), and `trashed` and `pinned` are the two sets a recent window can
 * never carry — deleted rows, which are too old to fall in a page, and pinned
 * rows, which are drawn wherever their age puts them.
 */
export interface SessionPage {
  sessions: SessionMeta[]
  total: number
  trashed: SessionMeta[]
  pinned: SessionMeta[]
}

/** A thread that is nobody's workflow step. Half of `isListed`, which is what
    every list actually asks for. */
const isTopLevel = (s: SessionMeta): boolean => !s.parentSessionId

/**
 * A thread a *list* may show: not a subagent's step, and not a draft the server
 * has never been told about. A draft is a thread the user has opened and not
 * yet started, and it used to appear in Recents, the sidebar and the project's
 * own list as a "New thread" row that nothing had happened in — an entry only
 * this browser tab could see, which vanished on reload.
 *
 * Trash is deliberately not part of this. Some of these lists exclude deleted
 * threads and one of them *is* the deleted ones, so `deletedAt` stays the
 * caller's question.
 */
export const isListed = (s: SessionMeta): boolean => isTopLevel(s) && !s.draft

const sameIds = (a?: string[], b?: string[]): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((id, i) => id === b[i]))

/** Two readings of the thread's helper map, entry for entry (order is the
    assignment, so a reorder counts as a change). */
const sameHelperModels = (
  a?: { role: string; model: string }[],
  b?: { role: string; model: string }[]
): boolean =>
  a === b ||
  (!!a && !!b && a.length === b.length && a.every((e, i) => e.role === b[i].role && e.model === b[i].model))

/**
 * Whether two readings of one thread say the same thing.
 *
 * Row *identity* is load-bearing in this client, which is why this exists at
 * all. `useSessionMeta` is a subscription, and `GET /api/sessions` answers with
 * freshly parsed objects every time — so replacing the list wholesale on every
 * refresh handed a new object to every consumer of every row, whether or not
 * anything about it had moved. That woke the sidebar, `AppShell`'s route effect
 * and *every mounted `ChatPanel`* on each poll, and the last of those is not
 * merely wasted work: the panel's job on a new row is to open the thread, so a
 * list refresh became an open, which is how a second connection came to be the
 * ordinary case rather than a race.
 *
 * Compared field by field rather than by a JSON round trip: the key order of a
 * parsed body is the server's and a stringify would compare it too, and the
 * client-only fields below must be excluded deliberately rather than by
 * accident.
 *
 * A draft is never "the same row" as anything, however identical the server's
 * account of it looks: the whole point of the row that replaces it is that it
 * is no longer a draft (see the `sessions` reducer), and keeping the old object
 * would keep `draft: true` on a thread the server has just confirmed.
 */
export function sameRow(a: SessionMeta, b: SessionMeta): boolean {
  if (a === b) return true
  if (a.draft || b.draft) return false
  return (
    a.id === b.id &&
    a.profileId === b.profileId &&
    a.projectId === b.projectId &&
    a.agentId === b.agentId &&
    a.model === b.model &&
    a.effort === b.effort &&
    (a.suggestFollowups ?? false) === (b.suggestFollowups ?? false) &&
    (a.uiBlocks ?? true) === (b.uiBlocks ?? true) &&
    a.title === b.title &&
    a.acpSessionId === b.acpSessionId &&
    a.createdAt === b.createdAt &&
    a.lastActivityAt === b.lastActivityAt &&
    a.lastTurnError === b.lastTurnError &&
    a.deletedAt === b.deletedAt &&
    (a.pinnedAt ?? null) === (b.pinnedAt ?? null) &&
    a.attached === b.attached &&
    a.peerCount === b.peerCount &&
    a.exited === b.exited &&
    a.promptActive === b.promptActive &&
    (a.waiting ?? false) === (b.waiting ?? false) &&
    (a.held ?? false) === (b.held ?? false) &&
    a.context?.used === b.context?.used &&
    a.context?.size === b.context?.size &&
    a.cursor === b.cursor &&
    a.parentSessionId === b.parentSessionId &&
    a.forkedFromSessionId === b.forkedFromSessionId &&
    a.forkedFromTurnId === b.forkedFromTurnId &&
    (a.asideQuote ?? null) === (b.asideQuote ?? null) &&
    (a.taskId ?? null) === (b.taskId ?? null) &&
    a.worktree?.path === b.worktree?.path &&
    a.worktree?.exists === b.worktree?.exists &&
    sameIds(a.mcpServerIds, b.mcpServerIds) &&
    sameIds(a.skillIds, b.skillIds) &&
    sameIds(a.commandIds, b.commandIds) &&
    sameHelperModels(a.helperModels, b.helperModels)
  )
}

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


/* ── routines ──────────────────────────────────────────────────────────────
   A routine is a saved thread-start that fires on its own. The interfaces
   below mirror the server's rows one field per column, the way
   `ScheduledMessage` mirrors `scheduled_messages` — the server sends the row
   itself (`RunView` in `server/src/routines.ts` is an alias of the row, and
   `Routine` is the row plus its links), so anything else here would be a
   projection nobody made.

   One thing reads differently from `ScheduledMessage` and it is worth naming:
   these booleans are real booleans, not SQLite's 0/1. The routine columns are
   declared `mode: "boolean"` where `scheduled_messages.enabled` deliberately
   is not, so drizzle hands the route a `true` and JSON carries it through. */

/** What the harness answers with when the agent asks. `"ask"` is the ordinary
    thread's behaviour exactly: park, tell the peers, wait for a human. */
export type Stance = "allow" | "deny" | "ask"

/**
 * How a routine's runs answer the agent, mirroring `server/src/autonomy.ts` —
 * which is where the design lives and the only place it is explained. Kept as
 * a mirror rather than an import because the server is not a package the client
 * builds against (the ACP SDK is the only type-only exception, and it is a
 * published one).
 *
 * `permissions` is keyed by ACP tool kind — a protocol field, so naming one
 * here hardcodes nothing about any agent. Unknown and absent keys both fall
 * through to `default` server-side, which is why this is a loose record: a form
 * that could only offer the kinds this file happens to list would refuse a kind
 * a later ACP release adds.
 */
export interface AutonomyPolicy {
  permissions: { default: Stance } & Record<string, Stance>
  /** `"decline"` lets the turn carry on and say it was skipped; `"ask"` parks. */
  elicitations: "decline" | "ask"
  /** How long an `ask` waits for a human before `askFallback` answers it.
      Zero or less disables the timer — a park that waits forever. */
  askTimeoutSeconds: number
  askFallback: "deny" | "cancel"
  /** Wall-clock ceiling for the whole run, in seconds. Zero or less = none. */
  maxRunSeconds: number
  maxRunTokens?: number
  /** Refuse to fire when the profile's plan is nearly gone. A provider with no
      windows reports `api-key` and the check is simply not applied — "no quota"
      is an answer, not a failure. */
  minQuotaPercent?: number
}

/** The default a new routine is written with, and the only policy that is
    exactly today's behaviour. Matches `ASK_EVERYTHING` in the server's
    `autonomy.ts`; a form that opened on anything else would be a grant made by
    a default rather than by a person. */
export const ASK_EVERYTHING: AutonomyPolicy = {
  permissions: { default: "ask" },
  elicitations: "ask",
  askTimeoutSeconds: 300,
  askFallback: "deny",
  maxRunSeconds: 30 * 60,
}

/** What a fire actually runs: one prompt, or a whole declarative workflow
    (`server/src/workflow-schema.ts`, verbatim — the definition is opaque here,
    exactly as a workflow tool's payload is). */
export type RoutineBody =
  | { kind: "prompt"; text: string }
  | { kind: "workflow"; definition: Record<string, unknown> }

/** What happens to a run's answer once its turn settles. Optional and plural;
    a failed one is recorded on the run and never fails the run. Named for the
    column it lives in (`Routine.onFinish`); the server calls the same union
    `RoutineAction`. */
export type OnFinishAction =
  | { kind: "push" }
  | { kind: "knowledge"; title?: string }
  | { kind: "task"; boardId?: string; statusId?: string; title?: string }
  | { kind: "routine"; routineId: string }

/** One `onFinish` action's outcome, as the run recorded it. */
export interface OnFinishRecord {
  kind: string
  ok: boolean
  error?: string
  /** The row the action created, when it created one. */
  ref?: string
}

/** What a fire does when the routine's previous run is still going. */
export type RoutineOverlap = "skip" | "queue"

/**
 * A saved thread-start that fires on its own — everything `POST /api/sessions`
 * carries, because a fire is `create(...)` with these values and then one
 * prompt. That is the constraint the shape is built on: a routine must not be
 * able to start a thread the composer could not start.
 */
export interface Routine {
  id: string
  name: string
  /** Free text shown in the list; null = none. */
  description: string | null
  /** False = every trigger on this routine is inert. The row is kept and still
      listed — disabling is how a routine is parked while its prompt is
      reworked, where deleting would take the run history with it. */
  enabled: boolean
  projectId: string
  profileId: string
  agentId: string
  /** Empty string = defer to the profile/agent, exactly as a thread does. */
  model: string
  effort: string
  /** Picks against the agent's advertised selectors, replayed after
      `session/new`. Opaque ACP option ids — never enumerated. */
  configChoices: Record<string, string | boolean>
  /** The role→model helper map a run's thread starts with (docs/model-roles.md). */
  helperModels: { role: string; model: string }[]
  body: RoutineBody
  /** An optional JSON schema for the run's answer, which buys the run one
      repair turn and then a structured `RoutineRun.verdict`. Null means the
      status stays bare — "the turn ended" and nothing more. */
  output: Record<string, unknown> | null
  onFinish: OnFinishAction[]
  overlap: RoutineOverlap
  autonomy: AutonomyPolicy
  /** One run has completed under this routine. The form may not widen
      `autonomy.permissions.default` to `allow` until it has — the difference
      between an informed grant and a dismissed dialog. Set by the engine, and
      deliberately not patchable. */
  dryRunCompleted: boolean
  createdAt: number
  updatedAt: number
  /** Library entries every run gets, on top of its profile's. Nested (not
      flattened the way `Profile` spreads them) because the server sends them
      that way: they are a join table, never columns on the row. */
  links: { mcpServerIds: string[]; skillIds: string[]; commandIds: string[] }
}

/** `POST /api/routines`. The links go in flat, as three id arrays, which is
    what `POST /api/sessions` already takes — `Routine.links` is the shape that
    comes *back*. */
export interface RoutineInput {
  name: string
  description?: string | null
  enabled?: boolean
  projectId: string
  profileId: string
  agentId: string
  model?: string
  effort?: string
  configChoices?: Record<string, string | boolean>
  helperModels?: { role: string; model: string }[]
  body: RoutineBody
  output?: Record<string, unknown> | null
  onFinish?: OnFinishAction[]
  overlap?: RoutineOverlap
  autonomy: AutonomyPolicy
  mcpServerIds?: string[]
  skillIds?: string[]
  commandIds?: string[]
}

/** `PATCH /api/routines/:id`. Every field of the input, optional — except
    `dryRunCompleted`, which is absent on purpose: it is the engine's record
    that a run has completed, and a patch that could set it would make the gate
    it guards decorative. */
export type RoutinePatch = Partial<RoutineInput>

export type RoutineTriggerKind = "schedule" | "api" | "git"

/**
 * One way a routine fires. Several per routine, combinable, each enabled on its
 * own; the three kinds share a row because they share everything after the fire.
 *
 * This is the server's row minus one column: `secretHash` never leaves the
 * server, and `hasToken` is the boolean the UI actually asks for. A hash has no
 * use on a surface whose only questions are "does this have a token" and "how
 * old is it" — `secretCreatedAt` answers the second.
 */
export interface RoutineTrigger {
  id: string
  routineId: string
  kind: RoutineTriggerKind
  enabled: boolean
  /** 5-field cron. Null for a one-off (`atMs`) and for the other two kinds.
      The presets write cron; there is no second representation. */
  cron: string | null
  /** IANA zone the cron is read in; null = the server's own. */
  tz: string | null
  /** Epoch ms of a single fire; null for a recurring one. */
  atMs: number | null
  /** Checked at fire time, never at edit time. A refused fire writes a
      `skipped` run saying why and does not disturb `nextFireAt`. */
  condition: { gitChangedSince?: "lastRun" } | null
  /** Epoch ms of the next fire, stagger included. Null when the trigger has no
      clock (`api`, `git`, or a spent one-off) — and null for a few seconds
      after a schedule trigger is created, because the sweep is what arms it. */
  nextFireAt: number | null
  /** Whether a long-lived token exists. The token itself is returned exactly
      once, by `mintRoutineTriggerToken`, and is never readable again. */
  hasToken: boolean
  /** Epoch ms the current token was minted, so the UI can say how old the
      credential it cannot show is. Null when there is none. */
  secretCreatedAt: number | null
  /** The branch whose HEAD moving fires this, or null for "any branch". */
  branch: string | null
  /** Path globs; a change matching any fires. Empty = any path. */
  paths: string[]
  /** Debounce for the watcher, ms — a rebase is hundreds of events and one
      intent. */
  debounceMs: number
  /** The git oid the last evaluation saw. Null until the first fire, which is
      why the first fire of such a trigger always runs. */
  lastSeen: string | null
  lastFiredAt: number | null
  /** Why the last evaluation could not fire; null once one works. */
  lastError: string | null
  createdAt: number
}

/** `POST /api/routines/:id/triggers`. A new trigger arrives with a null clock
    on purpose: null is inert, and the server's sweep is the one thing that
    knows when the next slot is — it arms `nextFireAt` on its next pass. */
export interface RoutineTriggerInput {
  kind: RoutineTriggerKind
  enabled?: boolean
  cron?: string | null
  tz?: string | null
  atMs?: number | null
  condition?: { gitChangedSince?: "lastRun" } | null
  branch?: string | null
  paths?: string[]
  debounceMs?: number
}

export type RoutineTriggerPatch = Partial<RoutineTriggerInput>

export type RoutineRunStatus = "running" | "completed" | "failed" | "blocked" | "skipped"

/** Which door fired a run. `routine` is the chaining action. */
export type RoutineSource = "schedule" | "api" | "git" | "manual" | "routine"

/**
 * One run of a routine, and one real thread.
 *
 * `sessionId` is an ordinary session id: it opens with `threadPath(sessionId)`
 * like any other thread, because that is exactly what it is — its own
 * transcript, searchable, openable and revivable, retired the moment its turn
 * settles. There is nothing new to route.
 */
export interface RoutineRun {
  id: string
  routineId: string
  /** The trigger that fired it, or null for a manual run (and for a fire that
      came in on the server's own boot key rather than a stored token). */
  triggerId: string | null
  /** Minted per fire and shared by every run that fire produced — one today. */
  fireId: string
  /** The run's thread, or null for a run skipped before one was made. */
  sessionId: string | null
  source: RoutineSource
  /** The caller's own words, if the fire brought any. Never parsed: it reaches
      the agent inside an untrusted wrapper. */
  payload: string | null
  /** A "Run now, forced to ask" — the run that clears `dryRunCompleted`. */
  dryRun: boolean
  status: RoutineRunStatus
  /** Why a `skipped` run was skipped, why a `blocked` one is blocked, or why a
      `failed` one failed. One column because it is one sentence to one reader. */
  error: string | null
  /** The run's final prose. */
  output: string | null
  /** The parsed answer when the routine declared an `output` schema — the only
      field here about the *work* rather than the process, which is why it and
      not `status` is what a run list leads with. */
  verdict: unknown
  actions: OnFinishRecord[]
  /** The git oid this run saw, for the next `gitChangedSince` comparison. */
  headOid: string | null
  /** Summed from the run's settled turns. Null on a run that took none. */
  tokens: number | null
  startedAt: number
  endedAt: number | null
}
