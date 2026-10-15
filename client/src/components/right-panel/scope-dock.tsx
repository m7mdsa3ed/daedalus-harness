/* ── What the route is about, and the dock the panels think they are in ──
   The right panel's contents are *scoped*: a thread's readings, shells and
   preview belong to that thread; a project page's belong to the project. The
   scope is read off the address bar, so there is one answer to "what is the
   panel about" and nothing to keep in step with a layout.

   The terminal, the preview, the transcript's file links and Source Control
   were all written to open things through `useDock()` — dockview's controller.
   There is no dock any more, but the doors they knock on are four methods
   (`openPanel`, `closePanel`, `registerCloseGuard`, `isPanelOpen`), so this
   provides a `DockContext` that answers them against the right-panel store,
   and routes the rest (a chat, a page, the board) to the router. The callers
   did not change; what they open now lands in the panel beside the page. */
import * as React from "react"
import { matchPath, useLocation, useNavigate } from "react-router"

import {
  DockContext,
  type CloseGuard,
  type WorkspaceDock,
} from "@/components/workspace/dock-context"
import {
  HOME_SCOPE,
  addTerminal,
  openSection,
  projectScope,
  removeTerminal,
  rightSheet,
  scopeSession,
  setPreview,
  threadScope,
  type RightSection,
  type Scope,
} from "@/lib/right-panel"
import { InspectorContext, ThreadJumpContext, type ThreadJumpTarget } from "@/lib/inspector"
import { boardPath, routedThreadId, threadPath } from "@/lib/router"

export { routedThreadId }
import { useSessionMeta } from "@/lib/store"
import { panelId } from "@/lib/workspace/panels"

export interface ScopeValue {
  scope: Scope
  /** The routed thread, when the scope is one. */
  sessionId: string | null
  /** The project the panels act on: the project page's, else the routed thread's. */
  projectId: string | null
}

const ScopeContext = React.createContext<ScopeValue>({
  scope: HOME_SCOPE,
  sessionId: null,
  projectId: null,
})

export function useScope(): ScopeValue {
  return React.useContext(ScopeContext)
}

/** The thread whose panel this is, or null on a page. */
export function useThreadDockSession(): string | null {
  return React.useContext(ScopeContext).sessionId
}

/** What a panel can ask of the panel it is in. Only "show me the transcript"
    survives: on a desktop the transcript is always beside the panel, and on a
    phone it is the sheet that has to get out of the way. */
export interface ThreadDockHandle {
  open: (kind: "transcript" | RightSection, reuse?: boolean) => void
}

export function useThreadDockHandle(): ThreadDockHandle | null {
  const { sessionId, scope } = useScope()
  return React.useMemo<ThreadDockHandle | null>(
    () =>
      sessionId
        ? {
            open: (kind) => {
              if (kind === "transcript") rightSheet.set(false)
              else openSection(scope, kind)
            },
          }
        : null,
    [sessionId, scope]
  )
}

/** The jump a reading uses to scroll the routed transcript (Agents, Changes). */
export function useThreadJump() {
  return React.useContext(ThreadJumpContext)
}

/** A scope with explicit values: the context and the dock shim bound to *this*
    scope. The route's own scope is one of these (`ScopeProvider`); the panes the
    right panel keeps mounted for scopes you have left are the others, so a shell
    opened from a thread still closes against that thread after you navigate. */
export function ScopeBoundary({
  scope,
  sessionId,
  projectId,
  children,
}: ScopeValue & { children: React.ReactNode }) {
  const navigate = useNavigate()
  const value = React.useMemo<ScopeValue>(
    () => ({ scope, sessionId, projectId }),
    [scope, sessionId, projectId]
  )

  /* Read through refs by the dock below, which has to stay one object: it is
     handed to panels that capture it in effects. */
  const live = React.useRef({ scope, navigate })
  live.current = { scope, navigate }
  const guards = React.useRef(new Map<string, CloseGuard>())

  const dock = React.useMemo<WorkspaceDock>(() => {
    const shim: Partial<WorkspaceDock> = {
      openPanel: (panel) => {
        const { scope: here, navigate: go } = live.current
        switch (panel.kind) {
          case "terminal":
            addTerminal(here, {
              terminalId: panel.terminalId,
              projectId: panel.projectId,
              ...(panel.sessionId ? { sessionId: panel.sessionId } : {}),
              ...(panel.cwd ? { cwd: panel.cwd } : {}),
              ...(panel.closeOnExit ? { closeOnExit: true } : {}),
            })
            return
          case "web":
            /* `file` and `diff` are *replaced* (a file link clears the diff, and
               the reverse); the address is only set when the caller names one. */
            setPreview(here, {
              ...(panel.url ? { url: panel.url } : {}),
              file: panel.file,
              diff: panel.diff,
            })
            openSection(here, "preview")
            return
          case "chat":
            void go(threadPath(panel.sessionId))
            return
          case "page":
            void go(panel.path)
            return
          case "tasks":
            void go(boardPath(panel.boardId, panel.taskId))
            return
        }
      },
      openChat: (id) => void live.current.navigate(threadPath(id)),
      openPage: (path) => void live.current.navigate(path),
      closePanel: async (id) => {
        const guard = guards.current.get(id)
        if (guard && !(await guard())) return
        if (id.startsWith("terminal:")) removeTerminal(live.current.scope, id.slice(id.lastIndexOf(":") + 1))
      },
      registerCloseGuard: (id, guard) => {
        guards.current.set(id, guard)
        return () => {
          if (guards.current.get(id) === guard) guards.current.delete(id)
        }
      },
      isPanelOpen: () => false,
    }
    /* The rest of `WorkspaceDock` is tabs, splits, layouts and popouts — nothing
       a panel inside the right panel calls. A stray call is a bug worth seeing. */
    return new Proxy(shim, {
      get(target, key) {
        if (key in target) return target[key as keyof WorkspaceDock]
        if (typeof key === "string")
          return () => {
            console.warn(`dock.${key}() is not available: there is no dock any more`)
          }
        return undefined
      },
    }) as WorkspaceDock
  }, [])

  return (
    <ScopeContext.Provider value={value}>
      <DockContext.Provider value={dock}>{children}</DockContext.Provider>
    </ScopeContext.Provider>
  )
}

/** What the address bar says the panel is about. */
export function useRouteScope(): ScopeValue {
  const location = useLocation()
  const sessionId = routedThreadId(location.pathname, location.search)
  const meta = useSessionMeta(sessionId ?? "")
  const pageProject = matchPath("/projects/:projectId", location.pathname)?.params.projectId
  const projectId = pageProject ?? meta?.projectId ?? null
  const scope = sessionId ? threadScope(sessionId) : pageProject ? projectScope(pageProject) : HOME_SCOPE
  return React.useMemo(() => ({ scope, sessionId, projectId }), [scope, sessionId, projectId])
}

/** The route's scope, plus the two doors that only make sense for the thread in
    front of you: "Open in inspector" and the transcript's scroll-to-row. */
export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const { scope, sessionId, projectId } = useRouteScope()
  const meta = useSessionMeta(sessionId ?? "")

  const jumpRef = React.useRef<((id?: string, turn?: ThreadJumpTarget) => void) | null>(null)
  const scopeRef = React.useRef(scope)
  scopeRef.current = scope
  const openReading = React.useCallback((tab: RightSection) => openSection(scopeRef.current, tab), [])

  return (
    <ScopeBoundary scope={scope} sessionId={sessionId} projectId={projectId}>
      <InspectorContext.Provider value={scopeSession(scope) && meta ? openReading : null}>
        <ThreadJumpContext.Provider value={jumpRef}>{children}</ThreadJumpContext.Provider>
      </InspectorContext.Provider>
    </ScopeBoundary>
  )
}

/** The id a terminal's dock calls are keyed by. */
export const terminalPanelId = (projectId: string, terminalId: string) =>
  panelId({ kind: "terminal", projectId, terminalId })
