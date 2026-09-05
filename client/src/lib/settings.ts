// Server connections live in localStorage — the web build ships with no
// baked-in server; the user enters URL + token on the connect screen. Several
// servers can be stored at once; one of them is active (switched in the
// sidebar), and the active one is what every request in the app talks to.

import { uuid } from "./uuid"
import { clearPersistedCache } from "./queries/persist"
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
    Its saved workspace layout and its persisted query cache go with it — both
    keys are per server, and state nothing can reach again is a key that never
    gets collected. */
export function removeServer(id: string): void {
  const store = read()
  const servers = store.servers.filter((s) => s.id !== id)
  write({ servers, activeId: store.activeId === id ? (servers[0]?.id ?? null) : store.activeId })
  clearLayout(id)
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

/**
 * How a thread wants to be worked on: a block of instructions appended to the
 * agent's own system prompt, plus the two dials that go with it.
 *
 * The client never assembles the prompt or sends it anywhere — a persona is an
 * id on the thread, and the server hands it to the runtime through whichever
 * door that runtime opens (`server/src/personas.ts`). Which is why picking one
 * costs a respawn: every agent we ship reads it only as a session is created or
 * loaded, so there is nothing to change on a running process. The conversation
 * survives, because the respawn ends in `session/load`.
 */
export interface Persona {
  id: string
  name: string
  description: string
  prompt: string
  /** null = leave the runtime's own default alone; 0 = thinking off; >0 = a
      token budget. Only runtimes with thinking as their own axis honour it. */
  thinking: number | null
  /** Applied to the thread when the persona is *picked*, and never again — the
      effort row underneath stays the user's. Null = the persona has no opinion. */
  effort: string | null
  /** 0 for a persona the user made; the seed release for a built-in. */
  seededVersion: number
  sortOrder: number
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
  /** Library entries every thread on this profile gets, on top of its
      project's. The same three a project and a thread carry; the agent sees
      the union. */
  mcpServerIds: string[]
  skillIds: string[]
  commandIds: string[]
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
  /** USD per million tokens. */
  pricing?: { input: number; output: number }
  /** Input modalities, e.g. ["text", "image"]. */
  modalities?: string[]
  /** Provenance when enriched: "providerId/modelId" in models.dev. */
  devRef?: string
  /** Optional URL for a model-specific icon. When set, the composer trigger
      shows this icon instead of the profile's logo. */
  iconUrl?: string
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
  /** The command the harness runs as this project's dev server (`pnpm dev`).
      Null on rows that were never scaffolded and never given one — such a
      project has no preview to open. */
  devCommand?: string | null
  /** The starter it was scaffolded from, if any. A record, not a link: the
      template is copied, and nothing about the project depends on it after. */
  templateId?: string | null
  /** The helper commands a person runs against this workspace by hand, from
      the project page's header ("Restart server", "Run migrations"). Absent
      on stubs, like the other optional fields. */
  helpers?: HelperCommand[]
}

/** One of a project's helper commands: a name and a shell line run in the
    project's cwd. `server/src/project-helpers.ts` owns the rows and the run. */
export interface HelperCommand {
  id: string
  projectId: string
  name: string
  command: string
  createdAt: number
}

/** The answer to a helper run — a non-zero exit is `ok: false` with the
    output, not an HTTP error, because the browser's dialog shows it either
    way. Mirrors `HelperRunResult` in `server/src/project-helpers.ts`. */
export interface HelperRunResult {
  ok: boolean
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  output: string
}

/* ── App builder ──
   A starter template and the dev server the harness runs for a project. The
   shapes mirror `server/src/protocol.ts` (`DevStatus`) and the manifest in
   `templates/<id>/template.json`; declared here rather than imported so the
   client compiles against the contract, not against a server checkout. */

/** One entry of `GET /api/templates` — the manifest, minus nothing. */
export interface Template {
  id: string
  name: string
  description: string
  tags: string[]
  /** Run once after scaffolding; null when the starter needs no install. */
  install: string | null
  /** The managed dev server command. Becomes the project's `devCommand`. */
  dev: string
  /** Typecheck/lint the agent runs before finishing; null when there is none. */
  check: string | null
  /** The production build, runnable from the preview panel; null when none. */
  build: string | null
  /** Prompt words that point at this starter — what `lib/stack-sense.ts`
      scores. Empty means "picked by hand or as the fallback only". */
  signals: string[]
  sortOrder: number
}

/** The `templateId` of a project built from scratch: no starter was copied,
    the agent chose the stack, and the dev command was sensed off the
    directory after its first turn. Mirrors `server/src/templates.ts`. */
export const SCRATCH_TEMPLATE_ID = "scratch"

export type DevState = "off" | "installing" | "starting" | "ready" | "failed" | "exited"

/** One error the server parsed out of a process's output — the dev server's
    or a build/check task's. */
export interface DevError {
  id: string
  at: number
  source: "terminal" | "build" | "check"
  text: string
}

export type DevTaskKind = "build" | "check"

/** The last build or check run this boot: the project's own script in a
    terminal of its own, one at a time. */
export interface DevTask {
  kind: DevTaskKind
  state: "running" | "passed" | "failed"
  command: string
  terminalId: string
  message: string | null
  startedAt: number
  endedAt: number | null
}

/** The dev server as the harness sees it. Absolute — every line of the
    events stream is the whole thing again, never a delta. */
export interface DevStatus {
  projectId: string
  state: DevState
  /** Server-relative preview root, e.g. "/preview/<key>/<projectId>/"; set
      while starting/ready, else null. The key in it is minted per boot, which
      is why this is never written anywhere that outlives the page. */
  url: string | null
  port: number | null
  /** The dev process's terminal (attachable through the terminal socket);
      null when off. */
  terminalId: string | null
  installTerminalId: string | null
  command: string | null
  /** Why it failed/exited: exit code, last stderr line, "no dev command". */
  message: string | null
  /** Recent errors parsed from process output, newest last, max 20, cleared
      on (re)start. */
  errors: DevError[]
  /** ms timestamp of the last state change. */
  since: number
  /** When the server last answered on its base path; null unless `ready`. */
  readyAt: number | null
  /** The last build/check run this boot, if any. */
  task: DevTask | null
}

export type DevAction = "start" | "stop" | "restart" | "build" | "check"

/** One commit of the project's repository, as `GET /api/projects/:id/history`
    lists them — a restore point in Build mode. */
export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  /** Unix seconds. */
  at: number
  filesChanged: number
  insertions: number
  deletions: number
}

export type HistoryAction =
  | { action: "checkpoint"; message?: string }
  | { action: "restore"; hash: string }

export interface HistoryResult {
  commits: GitCommit[]
  committed?: boolean
  restored?: boolean
  commit: GitCommit | null
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
  /** The thread's persona (`Persona`), or "" for none. */
  personaId?: string
  /** Whether the agent closes answers with follow-up prompt suggestions.
      Absent from a server that predates the toggle, which reads as off. */
  suggestFollowups?: boolean
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
  /** Client-only, draft-only: the permission mode picked before the thread
      exists, from the agent's remembered `modes` (`lib/agent-options`). Applied
      by the server right after session/new; once the thread runs, its own
      `modes` state is the only truth and this is dead weight the merge drops. */
  modeId?: string
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

const sameIds = (a?: string[], b?: string[]): boolean =>
  a === b || (!!a && !!b && a.length === b.length && a.every((id, i) => id === b[i]))

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
    a.personaId === b.personaId &&
    (a.suggestFollowups ?? false) === (b.suggestFollowups ?? false) &&
    a.title === b.title &&
    a.acpSessionId === b.acpSessionId &&
    a.createdAt === b.createdAt &&
    a.lastActivityAt === b.lastActivityAt &&
    a.lastTurnError === b.lastTurnError &&
    a.deletedAt === b.deletedAt &&
    a.attached === b.attached &&
    a.peerCount === b.peerCount &&
    a.exited === b.exited &&
    a.promptActive === b.promptActive &&
    a.cursor === b.cursor &&
    a.parentSessionId === b.parentSessionId &&
    sameIds(a.mcpServerIds, b.mcpServerIds) &&
    sameIds(a.skillIds, b.skillIds) &&
    sameIds(a.commandIds, b.commandIds)
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
  /** Null for none. Not a foreign key server-side: a deleted persona reads as
      "none" at the next fire. */
  personaId: string | null
  /** Picks against the agent's advertised selectors, replayed after
      `session/new`. Opaque ACP option ids — never enumerated. */
  configChoices: Record<string, string | boolean>
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
  personaId?: string | null
  configChoices?: Record<string, string | boolean>
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
