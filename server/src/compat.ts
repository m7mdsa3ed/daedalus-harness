/**
 * The wire contract between a client build and a server build.
 *
 * Both halves compile this file in — the client through the `@daedalus/compat`
 * alias, like `delivery.ts` — so each build freezes the values it was cut
 * with, and a client and a server from different commits can compare them at
 * runtime. One file is what keeps the two sides from disagreeing about the
 * same number.
 *
 * - `API` moves on a **breaking** wire change only (a route or field removed or
 *   reshaped, an event whose meaning changed). Expand, migrate, contract: the
 *   client learns to read both shapes first, then the server bumps `API`, and a
 *   later release drops the old reader and raises `MIN_SERVER_API`.
 * - An **additive** change (a new route, an optional field, a new event kind)
 *   is a `FEATURES` entry, never a bump. The client gates on the name.
 * - Semver (`meta.ts`) is for people and the changelog; nothing compares it.
 *
 * A server older than this file sends no `api` at all, and that reads as 0.
 */

/** The wire contract this build speaks. */
export const API = 1;

/** The oldest server this client build still drives. Raising it is a release
    note: it is the moment an outdated server stops being usable. */
export const MIN_SERVER_API = 0;

/** The oldest client this server build still serves. Clients block
    themselves; the server says the number and refuses nothing. */
export const MIN_CLIENT_API = 0;

/** What this server can do beyond the API baseline. Everything that existed
    when versioning began is the baseline and is not listed. */
export const FEATURES = [
  /** `_daedalus/model_call` updates, `session_config.callsVia`,
      `GET /api/sessions/:id/calls` and `GET /api/usage/calls`. */
  "modelCalls",
  /** `@kind:ref` mentions: `POST /api/mentions/context` expands a message's
      typed references into a `<context>` block (`mentions/expand.ts`). */
  "mentionKinds",
  /** The one `agent` MCP server replaces `ask_agent` and the `workflow` server:
      every way of handing work to another worker is one `agent` tool, and a
      run's kind travels in its answer rather than in which tool was called.
      The client's subagent reader tells the two families apart by the MCP
      server prefix (`mcp__agents__agent`), which a server from before this
      never sent — its launch tool was `ask_agent` — so an old journal cannot be
      misread either. This name is what a later reader gates on instead of that
      inference. */
  "agentTool",
  /** Logging an agent in from the app: `AgentStatus.login`/`authenticated`,
      `POST /api/agents/:id/login` (a setup terminal) and
      `POST /api/agents/:id/authenticate` (NDJSON, device code). */
  "agentLogin",
  /** Warming a draft's agent: `POST /api/prewarm` and
      `DELETE /api/prewarm/:id` (`routes/prewarm.ts`, `prewarm.ts`). With this
      name the client may ask for a draft's agent to be started early, behind
      the keystrokes, so its first message resumes at `session/new` instead of
      paying the whole cold start. **The draft still creates no row and sends no
      prompt** — nothing is journaled and no token is spent — and both routes
      answer `{ ok }` whatever happens, so a client that cannot warm (a hosted
      sandbox answers `false`) sends exactly as it always did. */
  "draftPrewarm",
  /** A new thread's first message may pick its persona (`persona-classify.ts`,
      in `POST /api/sessions`), said as an ordinary `Persona` config notice, and
      `ProjectDefaults.classifyPersona` turns it off per project. */
  "personaClassify",
  /** `GET /api/decision/persona/prompt`: the body the persona classifier sends
      its decision model, for Settings › AI to show. */
  "personaPrompt",
] as const;

export type Feature = (typeof FEATURES)[number];
