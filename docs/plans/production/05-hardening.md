# Phase 5: hardening

## Context

Phase 1 protects the door. This phase limits what something already inside can do: a
prompt-injected agent, a malicious MCP server, model-written markdown.

- **`/api/sql` is not read-only.** `db/index.ts:746` splices the body into
  `SELECT * FROM (...) AS q LIMIT n` with no bind values, so node-postgres uses the simple
  protocol and stacked statements escape the read-only transaction. The role is a superuser.
- **Loopback keys are global.** One `derive("wf")` key serves every session; `/hm`
  (`harness.ts:22`) forwards to every `/api` route with the master token; `/gw/<key>/p/<id>`
  attaches any profile's API key.
- **The agent's tools are unconfined.** `bash` passes `process.env` (`agent/src/tools/bash.ts:68`);
  `read_file`, `glob`, `grep` accept absolute paths and `..` and never ask (`fs-tools.ts:12`);
  `acceptEdits` approves writes anywhere; `read_file` loads the whole file before slicing; model
  calls have no timeout (`turn.ts:314`); subagents are uncapped and can pick any model.
- **Dependencies**: 4 critical, 55 high across the three packages, including the MCP SDK OAuth
  credential leak (relevant to `mcp-oauth.ts`) and an undici TLS bypass.

## Steps

1. **`/api/sql`**: run the server as a non-superuser role; give the route a `SELECT`-only role
   on non-secret tables; force the extended protocol so stacked statements are refused.
2. **Loopback keys per session**: `derive(purpose, sessionId)`, verified against the session in
   the path; `/gw` reaches only the thread's own profile; `/hm` gets a route allowlist (no
   `/api/sql`, `/api/backup`, `sync-export`, `/api/agents`, terminals); all loopback doors refuse
   non-loopback peers.
3. **Agent tools**:
   - `bash` gets an allowlisted env (PATH, HOME, LANG, TERM, user vars); the server spawns agents
     from a minimal base env, not `process.env`.
   - Paths outside the cwd (after realpath) are their own permission group and always ask, even
     under `acceptEdits`.
   - `read_file` stats first, refuses non-regular files, and reads only up to offset + limit.
   - An idle-stream watchdog on model calls (e.g. 120 s with no part) aborts the attempt into the
     existing retry classifier.
   - Cap concurrent subagents (e.g. 4); limit `task.model` to the profile's catalog.
4. **Dependencies**: `@modelcontextprotocol/sdk` 1.32 or later, zod 4.6.6 or later, ai-sdk
   versions that pull undici 7.30.1 or later, `pnpm.overrides` for dompurify and fast-uri; pin
   `@ai-sdk/anthropic` exactly (it imports `/internal`).
5. **Uploads and sockets**: `hono/body-limit` on the upload routes, enforced while streaming;
   `maxPayload` (1 MiB) on the WebSocket server; `mcp-logo.ts` checks size while reading.
6. **Headers**: a strict CSP on the client build (`script-src 'self'`, a tight `connect-src`,
   `object-src 'none'`); `hono/secure-headers` on the server; HSTS at the TLS terminator.
7. **Token in URLs**: accept `?token=` only on `/ws` and `/terminal`; later, a short-lived ticket
   (`POST /api/ws-ticket`) instead.
8. **Electron**: `shell.openExternal` only for `http:`, `https:`, `mailto:`
   (`client/electron/main.cjs:540`, `:576`).
9. **Client**: openui `Chart` keys its config by index, not the model's series name
   (`client/src/components/ui/chart.tsx:92`).
10. **Redaction**: MCP rows redact `env` and `headers` (`routes/library.ts:54`); a profile or
    web-search test falls back to the stored key only for the stored `baseUrl`
    (`profiles.ts:278`, `misc.ts:160`).
11. **SSRF**: link previews refuse link-local and metadata ranges (`link-preview.ts:85`).

## Done when

- A stacked statement on `/api/sql` is refused.
- A key minted for one session is rejected on another, and `/hm` answers 403 on `/api/sql`.
- An agent cannot read `server/data/config.json` or see `DATABASE_URL` without a prompt.
- `pnpm audit --prod` shows no critical in any package.
