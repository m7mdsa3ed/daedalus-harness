/* ── Panel vocabulary ──
   What the dock can hold, and how a panel is named. A panel type is an
   interaction surface and not a data source: a diff is the editor looking at a
   file two ways, not a kind of its own. Merging them is what keeps the
   registry, the palette and the close rules from having near-copies of each
   other.

   A descriptor IS the panel's params. Dockview serializes params verbatim into
   localStorage, so this file is a storage schema as much as a type: ids and
   plain data only, nothing live, and every field has to survive a reload and a
   server restart. `parsePanel` is the other half of that contract — anything
   restored has to come back through it before the dock will trust it. */

export type PanelKind = "chat" | "terminal" | "web" | "tasks" | "page"

/** The project id of a terminal or IDE opened with no thread routed: the
    server roots it at $HOME (`projectRoot`). */
export const HOME_PROJECT_ID = "home"

/** A file against git, shown in the Preview panel: the two sides of a source-control row.
    A side is a `Comparison` name or a commit's `{ rev }` — the JSON-safe half of `DiffSide`. */
export type WebDiffSide = "head" | "staged" | "worktree" | { rev: string }
export interface WebDiff { path: string; left: WebDiffSide; right: WebDiffSide; repo?: string }

export type PanelDescriptor =
  /* `tabId` is what makes a second tab of the same thread possible: tabs are
     isolated, so one thread may stand in several of them, and each needs an id
     of its own. Absent for the first (and for every layout stored before). */
  | { kind: "chat"; sessionId: string; tabId?: string }
  /* `closeOnExit` is a helper command's terminal: it was opened by a button
     that meant "run this", not "give me a shell", so a clean exit is the end of
     the errand and the panel goes with it. A non-zero exit keeps the panel —
     that output is the whole reason you ran it. */
  | {
      kind: "terminal"
      projectId: string
      terminalId: string
      closeOnExit?: boolean
      /** A thread dock's shell: the thread it belongs to and its worktree
          (project-relative), so a restart is still that thread's. */
      sessionId?: string
      cwd?: string
    }
  /** The Preview panel: a project file (`workspace/file-preview.tsx`) or a
      file's diff, and nothing else - it embeds no web page. */
  | { kind: "web"; viewId: string; projectId: string; file?: string; diff?: WebDiff }
  /** A board, beside the work it describes. One panel, not one per board: the
      board being read is a *place inside* it (`lib/tasks-location.ts`) the way
      a file is a place inside the IDE, so it travels in the params and moving
      between boards is not opening a second panel. Boards are the server's,
      not a project's, which is why this carries no `projectId`. A second one is
      asked for by name the way a second IDE is (`viewId`), and then the two are
      two places, not two copies: the board is in the descriptor. */
  | { kind: "tasks"; boardId?: string; taskId?: string; viewId?: string }
  /** Every route that is not a thread — settings, a project's page, the inbox,
      the landing console — as a tab, so a settings page can stand beside the
      chat it is about. `path` is the route (pathname plus search) the panel
      renders through the app's own route table (`workspace/page-panel.tsx`).
      A page tab is the app's *browsing* tab: opening a page repoints the
      unpinned one rather than adding another (`openPage` in dock.tsx), so its
      id says nothing about where it is pointed. */
  | { kind: "page"; path: string }

export interface PanelSpec {
  /** One per resource *by default* — opening it again focuses what is there,
      unless the opener asks for a fresh one by minting a `viewId`. */
  singleton: boolean
  /** Shown until the panel knows better and calls `api.setTitle`. */
  defaultTitle: string
  /** False while a kind is declared but not yet built: a layout restored from a
      newer build still renders (as the unsupported state) instead of throwing,
      and nothing offers to open one. */
  implemented: boolean
}

export const PANEL_SPECS: Record<PanelKind, PanelSpec> = {
  chat: { singleton: true, defaultTitle: "Thread", implemented: true },
  terminal: { singleton: false, defaultTitle: "Terminal", implemented: true },
  web: { singleton: false, defaultTitle: "Preview", implemented: true },
  tasks: { singleton: true, defaultTitle: "Tasks", implemented: true },
  page: { singleton: false, defaultTitle: "Page", implemented: true },
}

export const PANEL_KINDS = Object.keys(PANEL_SPECS) as PanelKind[]

export function isPanelKind(value: unknown): value is PanelKind {
  return typeof value === "string" && value in PANEL_SPECS
}

/* Stable ids, so opening a resource twice focuses the panel that already has
   it. The IDE's id is its project alone: a file, a diff and a turn's changes
   are things opened *inside* it, and its own tab store tracks them — a second
   id per file is what made the same file at a second line a second panel. */
export function panelId(panel: PanelDescriptor): string {
  switch (panel.kind) {
    case "chat":
      return panel.tabId ? `thread:${panel.sessionId}:${panel.tabId}` : `thread:${panel.sessionId}`
    case "terminal":
      return `terminal:${panel.projectId}:${panel.terminalId}`
    case "web":
      return `web:${panel.projectId}:${panel.viewId}`
    case "tasks":
      return panel.viewId ? `tasks:${panel.viewId}` : "tasks"
    case "page":
      /* Never looked up by — a page tab is found by `pageKey`, never by id
         (see `openPage`). This is only the *base* of a fresh tab's id. */
      return `page:${pageKey(panel.path)}`
  }
}

/** Which place a route is. One per top-level section — `/settings/mcp` and
    `/settings/rules` are the same settings tab pointed elsewhere — except
    where the second segment names a *thing*: a project's page and a thread's
    trace are places of their own. The root is `home`, the landing console. */
export function pageKey(path: string): string {
  const [, first = "", second = ""] = path.split("?")[0].split("/")
  if ((first === "projects" || first === "t") && second) return `${first}/${second}`
  return first || "home"
}

const SIDES = ["head", "staged", "worktree"]
const diffSide = (v: unknown): WebDiffSide | undefined =>
  typeof v === "string" && SIDES.includes(v)
    ? (v as WebDiffSide)
    : v && typeof v === "object" && typeof (v as { rev?: unknown }).rev === "string"
      ? { rev: (v as { rev: string }).rev }
      : undefined
function parseWebDiff(v: unknown): WebDiff | undefined {
  const d = (v ?? {}) as Record<string, unknown>
  const left = diffSide(d.left)
  const right = diffSide(d.right)
  return typeof d.path === "string" && d.path && left && right
    ? { path: d.path, left, right, ...(typeof d.repo === "string" ? { repo: d.repo } : {}) }
    : undefined
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

/**
 * Restored params → a descriptor, or null if this is not one.
 *
 * Every field is checked rather than cast. The params in localStorage were
 * written by some past build of this app and are the one input here that no
 * type can vouch for: a renamed field, a half-finished feature or a
 * hand-edited key all arrive looking like a panel. Returning null is what lets
 * the layout drop exactly the bad panel and keep the rest.
 */
export function parsePanel(component: unknown, params: unknown): PanelDescriptor | null {
  if (!isPanelKind(component)) return null
  const p = (params ?? {}) as Record<string, unknown>
  const projectId = str(p.projectId)
  switch (component) {
    case "chat": {
      const sessionId = str(p.sessionId)
      const tabId = str(p.tabId)
      return sessionId ? { kind: "chat", sessionId, ...(tabId ? { tabId } : {}) } : null
    }
    case "terminal": {
      const terminalId = str(p.terminalId)
      return projectId && terminalId
        ? {
            kind: "terminal",
            projectId,
            terminalId,
            closeOnExit: p.closeOnExit === true,
            ...(str(p.sessionId) ? { sessionId: str(p.sessionId) } : {}),
            ...(str(p.cwd) ? { cwd: str(p.cwd) } : {}),
          }
        : null
    }
    case "page": {
      const path = str(p.path)
      return path?.startsWith("/") ? { kind: "page", path } : null
    }
    case "tasks": {
      /* Both fields are optional and both are only ever *hints*: an unknown
         board falls through to the remembered one, and an unknown task closes
         its detail. Nothing here can fail to parse, so a tasks panel always
         comes back — with an empty board if that is all that survived. */
      return {
        kind: "tasks",
        ...(str(p.boardId) ? { boardId: str(p.boardId) } : {}),
        ...(str(p.taskId) ? { taskId: str(p.taskId) } : {}),
        ...(str(p.viewId) ? { viewId: str(p.viewId) } : {}),
      }
    }
    case "web": {
      /* A layout saved when the panel was a browser is dropped rather than
         drawn empty: it carried an address and a trust, and there is nothing
         left of either to show. A Preview with no file is *not* one of those —
         it is the explorer alone, which is a place worth restoring. */
      const viewId = str(p.viewId)
      const file = str(p.file)
      const diff = parseWebDiff(p.diff)
      if (!viewId || !projectId || "url" in p || "trust" in p) return null
      return {
        kind: "web",
        viewId,
        projectId,
        ...(file ? { file } : {}),
        ...(diff ? { diff } : {}),
      }
    }
  }
}
