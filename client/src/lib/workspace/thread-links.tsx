/* ── Transcript → workspace ──
   How a file named in a tool call becomes something you can click.

   A context rather than props threaded through the transcript, for two
   reasons. `ThreadItemView` renders a dozen item kinds and would have to carry
   `projectId` and an opener through all of them to reach the one row that uses
   them. And the transcript is not only rendered inside the dock — anything that
   mounts it without a workspace gets `null` here and renders the same paths as
   plain text, which is the correct fallback rather than a crash.

   The dock knowledge stays on this side of the boundary: `thread-items` asks
   "can I open this?" and never learns what a panel is. */
import * as React from "react"

export interface ThreadLinks {
  projectId: string
  /** Open a file from the transcript. `line` scrolls to it. */
  openFile: (path: string, line?: number) => void
  /** Open an agent's edit as a comparison against the last commit. */
  openDiff: (path: string) => void
}

const ThreadLinksContext = React.createContext<ThreadLinks | null>(null)

export const ThreadLinksProvider = ThreadLinksContext.Provider

/** Null when the transcript is not inside a workspace. Callers render plain
    text in that case rather than a button that cannot do anything. */
export function useThreadLinks(): ThreadLinks | null {
  return React.useContext(ThreadLinksContext)
}

/**
 * A tool call's location path → the project-relative form the workspace speaks.
 *
 * Agents report absolute paths as often as not, and the file API only accepts
 * relative ones. Without the project's cwd here there is nothing to subtract,
 * so the best that can be done is strip a leading slash-run and let the server
 * refuse anything that then escapes — which it will, loudly, rather than
 * reading a file outside the project.
 */
export function toRelative(path: string, cwd?: string): string {
  let value = path.split("\\").join("/")
  const root = cwd?.split("\\").join("/").replace(/\/+$/, "")
  if (root && value.startsWith(`${root}/`)) value = value.slice(root.length + 1)
  return value.replace(/^\/+/, "")
}
