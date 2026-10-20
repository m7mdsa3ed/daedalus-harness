/* Whether this client build and a server build can work together — the one
   pure answer the gate, the server menu and (later) a multi-server view all
   ask. The numbers come from `@daedalus/compat` (server/src/compat.ts), frozen
   into this bundle at build time; the server's come from `/api/health`. */
import { API, MIN_SERVER_API } from "@daedalus/compat"

export type Compat = "ok" | "server-old" | "client-old"

/** What `/api/health` says about the server's contract. Both fields are
    absent on a server older than versioning, which reads as API 0. */
export type HealthCompat = { api?: number; minClientApi?: number }

export function compatOf(health: HealthCompat, client = { api: API, minServerApi: MIN_SERVER_API }): Compat {
  if ((health.api ?? 0) < client.minServerApi) return "server-old"
  if (client.api < (health.minClientApi ?? 0)) return "client-old"
  return "ok"
}

/** How a server is updated where it runs: pm2:start builds, pushes
    the schema and restarts (CLAUDE.md "Deployed built"). Said by the gate and
    by Settings › General. */
export const SERVER_UPDATE_COMMAND = "git pull && pnpm pm2:start"
