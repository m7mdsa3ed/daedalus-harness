# Daedalus Harness

Generic ACP (Agent Client Protocol) harness. Three parts, one repo:

- `server/` — Node 22 + Hono + ws. Thin bridge: spawns ACP agent processes per thread
  (registry in `data/agents.json`, `{apiKey}`/`{baseUrl}`/`{model}`/`{cwd}` placeholders filled
  from profile + project) and pipes raw NDJSON between agent stdio and the client WebSocket.
  Owns **profiles** (agent config: credentials/models, `data/profiles.json`, keys redacted from
  the API), **projects** (workspace: cwd + linked MCP/skill ids, `data/projects.json`) and the
  **library** of reusable MCP servers/skills (`data/mcp-servers.json`, `data/skills.json`),
  bearer-token auth, the frame journal (reconnect/replay), and FCM push. `data/` holds
  secrets — gitignored, never commit.
- `client/` — Vite + React 19 + Tailwind v4 + shadcn (Base UI, NOT Radix: compose triggers
  with `render={...}`, not `asChild`; `SelectValue` needs explicit children for labels).
  The browser is the real ACP client via `@agentclientprotocol/sdk` over
  `experimental/ws-client`. State: one reducer in `src/lib/store.tsx`; side effects in
  `src/lib/actions.ts`; ACP connection per thread in `src/lib/acp.ts`. Theme/layout ported from
  `/var/www/mawared-off/social-live-agent/ai-agent-web` (glass surfaces, Inter, step-row
  transcript). Electron shell lives in `client/electron/` (frameless, vibrancy/acrylic).
- No build-time client config: server URL + token are entered at runtime (localStorage).

## Commands

- Server: `cd server && pnpm dev` (prints token), `pnpm test` (pipe self-check, fake agent).
- Client: `cd client && pnpm dev` / `pnpm build` / `pnpm electron:dev` / `pnpm electron:dist:win`.
- Typecheck: `pnpm exec tsc -b` (client), `pnpm exec tsc --noEmit` (server).
- `tsconfig` uses `erasableSyntaxOnly` — no TS constructor parameter properties.
- eslint currently crashes at startup (typescript-eslint vs typescript 7 — pre-existing).

## Conventions

- Protocol truth lives at the endpoints: the server never parses ACP beyond sniffing
  `session/new` / `session/prompt` / `session/request_permission` for metadata.
- ACP schema is the source for modes/config options/usage — render generically, don't
  hardcode per-agent knowledge in the client.
- Test agent: `server/test/fake-agent.mjs` (registered as `fake-echo`), drives the UI without
  credentials.
- No visual testing: don't drive the UI with Playwright/browser automation or take screenshots
  to check work. Verify with `tsc -b` and reasoning about the code; the user checks the UI.
