/* The project-helpers client. Mirrors `server/src/project-helpers.ts` one
   call per route.

   A helper command is a person's own button against a workspace ("Restart
   server", "Run migrations") — the rows live on the project, are edited in
   Settings › Projects, and are run from the project page's header dropdown.
   Each function takes the connection to talk to — the query hooks in
   lib/queries supply it from the active server — so nothing here reaches for
   a module-level active connection.

   Running one is not here: it answers with a terminal rather than with output,
   so it lives with the other terminal-creating calls in
   `lib/workspace/terminals.ts` (`startHelperTerminal`). */
import { api, type HelperCommand, type ServerSettings } from "@/lib/settings"

/** One runnable script a project's package.json declares: the name to read
    (dir-qualified when nested) and the shell line that runs it from the
    project root. Mirrors `server/src/project-scripts.ts`. */
export interface ProjectScript {
  name: string
  command: string
}

/** One `!` line this project has run, and how often. Mirrors
    `server/src/shell-history.ts` — a tally the server keeps as lines run, not
    a list anyone wrote. */
export interface ShellUse {
  line: string
  count: number
  /** Epoch ms of the last run. */
  lastAt: number
}

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/helpers`

export interface HelperInput {
  name: string
  command: string
  /** Project-relative directory; empty/absent = the project's cwd. */
  cwd?: string | null
  /** Extra environment variables; empty/absent = none. */
  env?: Record<string, string> | null
  description?: string | null
  /** Ask before running. */
  confirm?: boolean
}

export function addHelper(
  settings: ServerSettings,
  projectId: string,
  input: HelperInput
): Promise<HelperCommand> {
  return api<HelperCommand>(settings, base(projectId), {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function updateHelper(
  settings: ServerSettings,
  projectId: string,
  helperId: string,
  input: HelperInput
): Promise<HelperCommand> {
  return api<HelperCommand>(settings, `${base(projectId)}/${helperId}`, {
    method: "PUT",
    body: JSON.stringify(input),
  })
}

export function deleteHelper(
  settings: ServerSettings,
  projectId: string,
  helperId: string
): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(settings, `${base(projectId)}/${helperId}`, { method: "DELETE" })
}
