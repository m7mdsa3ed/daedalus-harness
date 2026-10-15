/* ── Panel vocabulary ──
   What the right panel can hold and how a panel is named. A descriptor is the
   shape the scope's dock (`components/right-panel/scope-dock.tsx`) answers
   `openPanel` with — a terminal, a preview, or a navigation (a chat, a page,
   the board). The panel itself is stored by `lib/right-panel.ts`; this file
   only names things. */

/** The project id of a terminal or preview opened with no project routed: the
    server roots it at $HOME (`projectRoot`). */
export const HOME_PROJECT_ID = "home"

/** Whether a web panel is looking at a project's own dev server or the wider
    internet. It is carried on the descriptor so the panel cannot decide for
    itself; a panel may drop to "external" but never raise itself back. */
export type WebTrust = "project" | "external"

/** A file against git, shown in the Preview: the two sides of a source-control row.
    A side is a `Comparison` name or a commit's `{ rev }` — the JSON-safe half of `DiffSide`. */
export type WebDiffSide = "head" | "staged" | "worktree" | { rev: string }
export interface WebDiff { path: string; left: WebDiffSide; right: WebDiffSide; repo?: string }

export type PanelDescriptor =
  | { kind: "chat"; sessionId: string }
  /* `closeOnExit` is a helper command's terminal: it was opened by a button
     that meant "run this", not "give me a shell", so a clean exit is the end of
     the errand and the shell goes with it. A non-zero exit keeps it — that
     output is the whole reason you ran it. */
  | {
      kind: "terminal"
      projectId: string
      terminalId: string
      closeOnExit?: boolean
      /** A thread's shell: the thread it belongs to and its worktree
          (project-relative), so a restart is still that thread's. */
      sessionId?: string
      cwd?: string
    }
  /** `file` is a project-relative path the preview is showing instead of the page. */
  | { kind: "web"; trust: WebTrust; viewId: string; projectId?: string; url?: string; file?: string; diff?: WebDiff }
  /** The board, which is a route. */
  | { kind: "tasks"; boardId?: string; taskId?: string; viewId?: string }
  /** Any route (pathname plus search). */
  | { kind: "page"; path: string }

/* Stable ids: a terminal's id keys its close guard and its sub-tab title. */
export function panelId(panel: PanelDescriptor): string {
  switch (panel.kind) {
    case "chat":
      return `thread:${panel.sessionId}`
    case "terminal":
      return `terminal:${panel.projectId}:${panel.terminalId}`
    case "web":
      return panel.trust === "external"
        ? `web:external:${panel.viewId}`
        : `web:${panel.projectId}:${panel.viewId}`
    case "tasks":
      return panel.viewId ? `tasks:${panel.viewId}` : "tasks"
    case "page":
      return `page:${panel.path}`
  }
}
