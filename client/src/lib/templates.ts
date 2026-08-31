/* ── Project templates ──
   A template is a starting point stored as a row: a repo to clone, a kit of
   library links, and the instruction the agent carries out in its first turn.
   The harness runs none of it — `createProjectFromTemplate` makes one empty
   directory and records the project, and everything after that is an ordinary
   turn in the agent's own cwd.

   Shaped like `lib/workspace/previews.ts`: the server is the store *and* the
   validator, and every call goes through the same `api`/`ApiError` path, so a
   failure reaches `describeError` unchanged. */
import { api, loadSettings, ApiError, type ServerSettings, type Project } from "@/lib/settings"

/** One row of `project_templates`, as `GET /api/templates` reports it. The
    nullable columns come back the way a project's `logoUrl` does — `""` for
    "none" — except `repoRef`/`repoSubdir`, which are genuinely tri-state:
    null means "the repo's own default". */
export interface Template {
  id: string
  name: string
  description: string
  logoUrl: string
  /** Where the starter is cloned from. Not a URL as far as the server is
      concerned: `git clone` takes ssh remotes and local paths too. */
  repoUrl: string
  repoRef: string | null
  repoSubdir: string | null
  /** Free text the gallery groups by — `"node"`, later `"python"`. A label,
      never something either end switches on. */
  runtime: string
  tags: string[]
  /** Markdown: install command, env file, dev command. */
  setup: string
  /** The body handed to the composer. */
  prompt: string
  /** The kit this template brings, on top of the profile's own links. */
  mcpServerIds: string[]
  skillIds: string[]
  commandIds: string[]
  /** Built-in provenance, exactly like an agent's; 0 = the user's own. */
  seededVersion: number
  createdAt: number
}

/** What the form sends. `seededVersion` and `createdAt` are the row's own
    history and are never inputs — the server keeps them across an update. */
export interface TemplateInput {
  name: string
  description?: string
  logoUrl?: string
  repoUrl: string
  repoRef?: string | null
  repoSubdir?: string | null
  runtime?: string
  tags?: string[]
  setup?: string
  prompt?: string
  mcpServerIds?: string[]
  skillIds?: string[]
  commandIds?: string[]
}

/** The kit, as the arrays a draft carries. */
export interface TemplateLinks {
  mcpServerIds: string[]
  skillIds: string[]
  commandIds: string[]
}

/** `POST /api/projects/from-template`. The project is a real row with the
    directory already on disk; the prompt is rendered server-side (so the
    client cannot drift from the placeholders) and goes straight into the
    draft's composer; the links ride that draft's picks into the eventual
    `POST /api/sessions`. Nothing has been spawned and no session row exists. */
export interface CreatedFromTemplate {
  project: Project
  prompt: string
  links: TemplateLinks
}

function server(): ServerSettings {
  const settings = loadSettings()
  if (!settings) throw new ApiError({ status: 0, path: "/api", serverMessage: "not connected" })
  return settings
}

const base = "/api/templates"

export const listTemplates = (signal?: AbortSignal): Promise<Template[]> =>
  api<Template[]>(server(), base, { signal })

export const createTemplate = (input: TemplateInput): Promise<Template> =>
  api<Template>(server(), base, { method: "POST", body: JSON.stringify(input) })

export const updateTemplate = (id: string, input: TemplateInput): Promise<Template> =>
  api<Template>(server(), `${base}/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(input),
  })

export const deleteTemplate = (id: string): Promise<{ ok: true }> =>
  api<{ ok: true }>(server(), `${base}/${encodeURIComponent(id)}`, { method: "DELETE" })

/**
 * Create the directory and the project row.
 *
 * A project route, not a template one — what it makes is a project, and the
 * template is an argument. `parentDir` must be absolute and exist; `folderName`
 * defaults to `slugifyName(name)` server-side, and is the one path segment the
 * harness ever writes outside a project root.
 */
export const createProjectFromTemplate = (input: {
  templateId: string
  name: string
  parentDir: string
  folderName?: string
}): Promise<CreatedFromTemplate> =>
  api<CreatedFromTemplate>(server(), "/api/projects/from-template", {
    method: "POST",
    body: JSON.stringify(input),
  })

/** The server's own `slugifyName`, spelled again here for one reason: the
    dialog shows the folder it is about to create before it asks for it, and a
    placeholder that disagrees with what the server does is worse than none. */
export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/**
 * The host a starter is cloned from, for the card's one line about the repo.
 *
 * `repoUrl` is whatever `git clone` takes, so this reads three shapes and
 * gives up rather than guessing: an ordinary URL, scp-style `git@host:owner/x`,
 * and a local path (which has no host and says so by returning null).
 */
export function repoHost(repoUrl: string): string | null {
  const raw = repoUrl.trim()
  if (!raw || raw.startsWith("/") || raw.startsWith(".") || raw.startsWith("~")) return null
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(raw)
  if (scp) return scp[1]
  try {
    return new URL(raw).host || null
  } catch {
    return null
  }
}
