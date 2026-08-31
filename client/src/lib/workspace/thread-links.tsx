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
  /**
   * Open a file from the transcript. `line` scrolls to it and puts the caret
   * there; `endLine` makes it a span, which the editor highlights — the
   * difference between "here is the file" and "here is the part the call was
   * about". See `lib/tools/files.fileRangeOf` for where a span comes from.
   */
  openFile: (path: string, line?: number, endLine?: number) => void
  /** Open an agent's edit as a comparison against the last commit. */
  openDiff: (path: string) => void
  /**
   * Open a page the agent read or cited in the workspace's own Browser panel,
   * rather than in a browser tab that leaves the app.
   *
   * One panel, reused: following a second source replaces the page in it, the
   * way clicking a second file replaces the editor. Callers keep their `href`
   * so a middle-click, a ⌘-click and "copy link" all still mean what they
   * always did — this is the plain left-click path only.
   */
  openUrl: (url: string) => void
}

const ThreadLinksContext = React.createContext<ThreadLinks | null>(null)

export const ThreadLinksProvider = ThreadLinksContext.Provider

/** Null when the transcript is not inside a workspace. Callers render plain
    text in that case rather than a button that cannot do anything. */
export function useThreadLinks(): ThreadLinks | null {
  return React.useContext(ThreadLinksContext)
}

/**
 * Is this click ours to intercept?
 *
 * A source stays an `<a href>` so the browser's own vocabulary keeps working —
 * ⌘-click for a background tab, middle-click, right-click → copy address. Only
 * the plain left click means "show me this", and only that one is turned into
 * a panel.
 */
export function isPlainClick(event: React.MouseEvent): boolean {
  return (
    event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
  )
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
