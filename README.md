# Daedalus Harness

A generic [Agent Client Protocol](https://agentclientprotocol.com) harness. The browser is the
real ACP client (`@agentclientprotocol/sdk`); the server is a thin bridge that spawns agent
processes per thread and pipes NDJSON between their stdio and a WebSocket. Ships with Claude
Code (`@agentclientprotocol/claude-agent-acp`); any ACP agent can be added with one registry entry.

```
client (Vite React + Electron shell)  ──WS raw ACP──►  server (Node)  ──stdio──►  agent process
        ▲                                 ──REST──►     profiles / registry / sessions / FCM
```

## Run

```bash
# server — prints the access token on first start
cd server && pnpm install && pnpm dev          # http://0.0.0.0:8791, data/ auto-created

# web client
cd client && pnpm install && pnpm dev          # open http://localhost:5173, enter server URL + token

# desktop (Electron shell merged into the client project)
cd client && pnpm electron:dev                 # dev (frameless, vibrancy/acrylic)
cd client && pnpm electron:dist:win            # package for Windows (nsis + zip); electron:dist for host OS
```

The client stores server URL + token in localStorage (connect screen) — no build-time env.

## In-thread controls & metrics

- The composer's bottom row surfaces whatever the agent advertises over ACP: the **permission
  mode** (`session/set_mode` — default / accept edits / bypass / plan for Claude Code) and every
  **config option** (`session/set_config_option`) — model, thinking effort, etc.
- The header shows per-thread metrics: **input/output tokens, cache-hit rate** (from the
  `session/prompt` response's `usage`), **TTFT** (measured client-side), and **context window
  occupancy** (`usage_update`).
- Harness settings (connection, theme, profiles, agents) live on a dedicated Settings page.

## Projects & profiles

A thread = a **project** (the workspace) run by a **profile** (the agent):

- **Project** — working directory plus the MCP servers and skills it links to (by id).
- **Profile** — agent runtime, base URL + API key (env at spawn), model list (per-thread picker),
  default model. API keys never leave the server.
- **MCP servers** (`data/mcp-servers.json`) and **skills** (`data/skills.json`) — defined once,
  attached to any number of projects. MCP servers are sent to the agent in ACP `session/new`;
  skills are symlinked into `<cwd>/.claude/skills/` when the agent process spawns.
  Both have an **Import** button: `GET /api/import` scans what the agents on the server already
  have — `~/.claude.json` (global + per-project `mcpServers`), `~/.codex/config.toml`
  (`[mcp_servers.*]`), and skill directories under `~/.claude/skills`, `~/.codex/skills` and
  installed Claude plugins — minus whatever the library already holds.

Threads are grouped by project in the sidebar; all of it is managed on the Settings page.

## Adding an agent

Append to `server/data/agents.json` — `{apiKey}` `{baseUrl}` `{model}` `{effort}` `{cwd}`
placeholders are filled from the profile/project/thread choices; empty values are omitted:

```json
{ "id": "my-agent", "name": "My Agent", "command": "npx", "args": ["-y", "some-acp-agent"],
  "env": { "MY_API_KEY": "{apiKey}" } }
```

An env value that is a JSON object (e.g. Codex's `CODEX_CONFIG`) is pruned after placeholder
fill: keys whose placeholder resolved empty are dropped, and the var is omitted if nothing
survives.

Placeholders also support conditionals: `{baseUrl?literal}` emits `literal` only when the var is
set — combined with JSON pruning this lets a template emit whole config blocks conditionally.

Shipped agents: **Claude Code** (`ANTHROPIC_*` env), **Codex** (`CODEX_API_KEY`, or ChatGPT
OAuth via `codex login` on the server; model/effort/base-URL via `CODEX_CONFIG` — a profile
Base URL generates a `model_providers` gateway entry using `wire_api: "responses"`; edit the
agent entry to `"chat"` for chat-completions-only gateways), and a `fake-echo` test agent for
smoke tests (`server/test/fake-agent.mjs`).

## Push notifications (FCM)

Optional. Add to `server/data/config.json`:

```json
"fcm": {
  "serviceAccountPath": "/path/service-account.json",
  "webConfig": { "apiKey": "…", "projectId": "…", "messagingSenderId": "…", "appId": "…" },
  "vapidKey": "…"
}
```

The client fetches this at runtime and registers a service worker; pushes fire for permission
requests and finished turns while no client is attached. Notification clicks deep-link
(`/?session=<id>`).

## Behavior notes

- Threads survive disconnects: the agent process stays alive (idle timeout in config,
  default 30 min); reconnecting clients rebuild the transcript from the frame journal
  (`GET /api/sessions/:id/journal`) and resume live from a cursor.
- Steering: sending a message during a running turn issues a concurrent `session/prompt`;
  if the agent rejects it, the client cancels and resends.
- Voice input uses the native Web Speech API (mic button hidden where unsupported).

## Tests

```bash
cd server && pnpm test      # WS<->stdio pipe, sniffing, journal replay (fake agent)
```

The `fake-echo` agent (`server/test/fake-agent.mjs`) also emits modes, config options, a tool
call and usage numbers, so the full UI can be exercised without credentials.
