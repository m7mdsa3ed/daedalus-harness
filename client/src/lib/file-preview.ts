/* ── Previewing a file the thread names ──
   A mention (`@src/app.ts`) or a `resource_link` the agent sent names a path
   the way the *server* resolved it (`server/src/mentions.ts`): relative to the
   thread's cwd, absolute, or `~/`. The Preview panel reads files through the
   project's own routes, which take project-relative paths and nothing else, so
   this is the one place a named path becomes one — or becomes nothing, for a
   path outside the project, which stays plain text rather than a link that can
   only fail. */
import * as React from "react"

import { HOME_PROJECT_ID } from "@/lib/workspace/panels"

export interface FileScope {
  projectId: string
  /** The project's absolute cwd, to strip from an absolute path. */
  root?: string
  /** An isolated thread's worktree, project-relative — where its relative paths start. */
  worktree?: string
}

/** POSIX `normalize` for a relative path; null when it climbs past the root. */
function clean(path: string): string | null {
  const out: string[] = []
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") {
      if (!out.length) return null
      out.pop()
    } else out.push(part)
  }
  return out.join("/")
}

/** The project-relative path a named path points at, or null when it is not in the project. */
export function projectPath(raw: string, scope: FileScope): string | null {
  const path = raw.replace(/^file:\/\//, "")
  const decoded = raw.startsWith("file://") ? decodeURIComponent(path) : path
  if (decoded.startsWith("~/"))
    // $HOME is the home project's root and no other's.
    return scope.projectId === HOME_PROJECT_ID ? clean(decoded.slice(2)) : null
  if (decoded.startsWith("/")) {
    const root = scope.root?.replace(/\/+$/, "")
    if (!root || !decoded.startsWith(root + "/")) return null
    return clean(decoded.slice(root.length + 1)) || null
  }
  return clean(scope.worktree ? `${scope.worktree}/${decoded}` : decoded) || null
}

/** Opens a project-relative path in the Preview panel; null where no thread is in reach. */
export interface FilePreviewValue {
  scope: FileScope
  open: (path: string) => void
}

export const FilePreviewContext = React.createContext<FilePreviewValue | null>(null)

/** How a file is drawn, by its extension. */
export type PreviewKind = "image" | "pdf" | "html" | "markdown" | "text"

const KINDS: Record<string, PreviewKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  avif: "image", bmp: "image", ico: "image", svg: "image",
  pdf: "pdf",
  html: "html", htm: "html",
  md: "markdown", markdown: "markdown", mdx: "markdown",
}

export function previewKind(path: string): PreviewKind {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return KINDS[ext] ?? "text"
}
