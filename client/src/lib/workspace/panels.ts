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

export type PanelKind = "chat" | "ide" | "terminal" | "web" | "tasks" | "page"

/** Whether a web panel is looking at a project's own dev server or the wider
    internet. It is carried on the descriptor so the panel cannot decide for
    itself; a panel may drop to "external" but never raise itself back. */
export type WebTrust = "project" | "external"

export type PanelDescriptor =
  | { kind: "chat"; sessionId: string }
  /** The IDE — the editor, the file explorer, file search and source control
      in one. One per project, because what is open *inside* it is its own
      state (`lib/ide/editors.ts`) and not the dock's. */
  | { kind: "ide"; projectId: string }
  | { kind: "terminal"; projectId: string; terminalId: string }
  | { kind: "web"; trust: WebTrust; viewId: string; projectId?: string; url?: string }
  /** A board, beside the work it describes. One panel, not one per board: the
      board being read is a *place inside* it (`lib/tasks-location.ts`) the way
      a file is a place inside the IDE, so it travels in the params and moving
      between boards is not opening a second panel. Boards are the server's,
      not a project's, which is why this carries no `projectId`. */
  | { kind: "tasks"; boardId?: string; taskId?: string }
  /** Every route that is not a thread — settings, a project's page, the inbox,
      the landing console — as a tab, so a settings page can stand beside the
      chat it is about. `path` is the route (pathname plus search) the panel
      renders through the app's own route table (`workspace/page-panel.tsx`).
      A page tab is the app's *browsing* tab: opening a page repoints the
      unpinned one rather than adding another (`openPage` in dock.tsx), so its
      id says nothing about where it is pointed. */
  | { kind: "page"; path: string }

export interface PanelSpec {
  /** One per project — opening it again focuses what is there. */
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
  ide: { singleton: true, defaultTitle: "IDE", implemented: true },
  terminal: { singleton: false, defaultTitle: "Terminal", implemented: true },
  web: { singleton: false, defaultTitle: "Browser", implemented: true },
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
      return `thread:${panel.sessionId}`
    case "ide":
      return `ide:${panel.projectId}`
    case "terminal":
      return `terminal:${panel.projectId}:${panel.terminalId}`
    case "web":
      return panel.trust === "external"
        ? `web:external:${panel.viewId}`
        : `web:${panel.projectId}:${panel.viewId}`
    case "tasks":
      return "tasks"
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
      return sessionId ? { kind: "chat", sessionId } : null
    }
    case "ide": {
      return projectId ? { kind: "ide", projectId } : null
    }
    case "terminal": {
      const terminalId = str(p.terminalId)
      return projectId && terminalId ? { kind: "terminal", projectId, terminalId } : null
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
      }
    }
    case "web": {
      const viewId = str(p.viewId)
      if (!viewId) return null
      /* Trust is re-derived, never believed: a stored "project" on a panel with
         no project is how a demoted panel would silently climb back. Anything
         that is not a project panel with a project is external. */
      const trust: WebTrust = p.trust === "project" && projectId ? "project" : "external"
      return {
        kind: "web",
        trust,
        viewId,
        ...(trust === "project" && projectId ? { projectId } : {}),
        ...(str(p.url) ? { url: str(p.url) } : {}),
      }
    }
  }
}
