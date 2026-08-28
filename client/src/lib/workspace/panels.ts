/* ── Panel vocabulary ──
   What the dock can hold, and how a panel is named. Seven kinds, because a
   panel type is an interaction surface and not a data source: a diff is the
   editor looking at a file two ways, a browser is the preview at a different
   trust level, and a problems list is the output buffer filtered to the records
   that carry a location. Merging them is what keeps the registry, the palette
   and the close rules from having three near-copies of each other.

   A descriptor IS the panel's params. Dockview serializes params verbatim into
   localStorage, so this file is a storage schema as much as a type: ids and
   plain data only, nothing live, and every field has to survive a reload and a
   server restart. `parsePanel` is the other half of that contract — anything
   restored has to come back through it before the dock will trust it. */

export type PanelKind =
  | "chat"
  | "explorer"
  | "editor"
  | "terminal"
  | "source-control"
  | "web"
  | "output"

/** Whether a web panel is looking at a project's own dev server or the wider
    internet. It is carried on the descriptor so the panel cannot decide for
    itself; a panel may drop to "external" but never raise itself back. */
export type WebTrust = "project" | "external"

/** How an editor renders what it opened. Four modes, one panel. */
export type EditorMode = "text" | "diff" | "preview" | "unsupported"

export type PanelDescriptor =
  | { kind: "chat"; sessionId: string }
  | { kind: "explorer"; projectId: string }
  | { kind: "editor"; projectId: string; path: string; comparison?: string }
  | { kind: "terminal"; projectId: string; terminalId: string }
  | { kind: "source-control"; projectId: string }
  | { kind: "web"; trust: WebTrust; viewId: string; projectId?: string; url?: string }
  | { kind: "output"; projectId: string }

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
  explorer: { singleton: true, defaultTitle: "Explorer", implemented: true },
  editor: { singleton: false, defaultTitle: "Editor", implemented: true },
  terminal: { singleton: false, defaultTitle: "Terminal", implemented: true },
  "source-control": { singleton: true, defaultTitle: "Source control", implemented: true },
  web: { singleton: false, defaultTitle: "Preview", implemented: true },
  output: { singleton: true, defaultTitle: "Output", implemented: true },
}

export const PANEL_KINDS = Object.keys(PANEL_SPECS) as PanelKind[]

export function isPanelKind(value: unknown): value is PanelKind {
  return typeof value === "string" && value in PANEL_SPECS
}

/* Stable ids, so opening a resource twice focuses the panel that already has
   it. The editor has two id forms on purpose: a file and a comparison of that
   file are separately openable and separately closeable, while `mode` still
   lets one panel toggle between them. */
export function panelId(panel: PanelDescriptor): string {
  switch (panel.kind) {
    case "chat":
      return `thread:${panel.sessionId}`
    case "explorer":
      return `explorer:${panel.projectId}`
    case "editor":
      return panel.comparison
        ? `editor:${panel.projectId}:${panel.path}:${panel.comparison}`
        : `editor:${panel.projectId}:${panel.path}`
    case "terminal":
      return `terminal:${panel.projectId}:${panel.terminalId}`
    case "source-control":
      return `source-control:${panel.projectId}`
    case "web":
      return panel.trust === "external"
        ? `web:external:${panel.viewId}`
        : `web:${panel.projectId}:${panel.viewId}`
    case "output":
      return `output:${panel.projectId}`
  }
}

/** The project a panel belongs to, or null when it belongs to none. A chat's
    project lives on its session, not on the panel, so it is resolved by the
    caller that has the session list — the dock does not carry a copy that could
    go stale when a thread is moved. */
export function panelProject(panel: PanelDescriptor): string | null {
  switch (panel.kind) {
    case "chat":
      return null
    case "web":
      return panel.trust === "project" ? (panel.projectId ?? null) : null
    default:
      return panel.projectId
  }
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
    case "explorer":
      return projectId ? { kind: "explorer", projectId } : null
    case "editor": {
      const path = str(p.path)
      if (!projectId || !path) return null
      const comparison = str(p.comparison)
      return { kind: "editor", projectId, path, ...(comparison ? { comparison } : {}) }
    }
    case "terminal": {
      const terminalId = str(p.terminalId)
      return projectId && terminalId ? { kind: "terminal", projectId, terminalId } : null
    }
    case "source-control":
      return projectId ? { kind: "source-control", projectId } : null
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
    case "output":
      return projectId ? { kind: "output", projectId } : null
  }
}
