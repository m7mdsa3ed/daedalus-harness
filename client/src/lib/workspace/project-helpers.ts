/* The project-helpers client. Mirrors `server/src/project-helpers.ts` one
   call per route.

   A helper command is a person's own button against a workspace ("Restart
   server", "Run migrations") — the rows live on the project, are edited in
   Settings › Projects, and are run from the project page's header dropdown.
   Each function takes the connection to talk to — the query hooks in
   lib/queries supply it from the active server — so nothing here reaches for
   a module-level active connection. The run's answer is a *result*, exit
   code and output, not an error, unless the server itself rejected the
   request. */
import { api, type HelperCommand, type HelperRunResult, type ServerSettings } from "@/lib/settings"

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/helpers`

export interface HelperInput {
  name: string
  command: string
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

export function runHelper(
  settings: ServerSettings,
  projectId: string,
  helperId: string
): Promise<HelperRunResult> {
  return api<HelperRunResult>(settings, `${base(projectId)}/${helperId}/run`, { method: "POST" })
}