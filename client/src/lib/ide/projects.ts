/* ── Which project a path belongs to ──
   The IDE speaks absolute `file://` URIs — a real path, so a file chip in the
   transcript, an explorer row and a diff title all name the same thing — but
   every server route is `/api/projects/:id/…?path=<relative>`. This is the
   one translation between the two, fed by the panel from the projects query
   (`setIdeProjects`) so the provider, which runs outside React, never asks
   the cache itself. Longest cwd wins, so a project nested inside another
   resolves to the inner one. */
import type { Project } from "@/lib/settings"

let projects: Project[] = []

export function setIdeProjects(next: Project[]): void {
  projects = next
}

export function ideProject(id: string): Project | undefined {
  return projects.find((project) => project.id === id)
}

const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, "") : path)

export interface Located {
  project: Project
  /** Project-relative, POSIX; "" is the project root. */
  relative: string
}

/** The project whose cwd encloses `absolute`, or null when none does. */
export function locate(absolute: string): Located | null {
  const path = trimSlash(absolute)
  let best: Located | null = null
  for (const project of projects) {
    const cwd = trimSlash(project.cwd)
    if (path !== cwd && !path.startsWith(cwd.endsWith("/") ? cwd : `${cwd}/`)) continue
    if (best && best.project.cwd.length >= cwd.length) continue
    best = { project, relative: path === cwd ? "" : path.slice(cwd.length + 1) }
  }
  return best
}

/** True for `/`, `/var`, `/var/www` when a project lives under them: the
    workbench stats a folder's parents, and they have to read as directories
    rather than as missing. */
export function isAncestorOfProject(absolute: string): boolean {
  const path = trimSlash(absolute)
  const prefix = path === "/" ? "/" : `${path}/`
  return projects.some((project) => trimSlash(project.cwd).startsWith(prefix))
}

export function absolutePath(cwd: string, relative: string): string {
  const root = trimSlash(cwd)
  return relative ? `${root}/${relative}` : root
}
