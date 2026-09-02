/* ── The IDE panel ──
   One panel holding the four things that are one product: a file explorer, a
   file search, source control, and the editor tabs they open into.

   All four are the harness's own. Monaco is the text surface and the diff and
   nothing else — the explorer is `file-explorer.tsx` over the workspace routes,
   source control is `scm-view.tsx` over the project's git routes, and both are
   ordinary components in this app's own design language. There is no workbench,
   no service overrides, no extension host, and therefore none of the rules that
   came with them: the panel is not a singleton element parked in a detached
   holder, and two projects can have two IDE panels open side by side.

   What is *open* inside the panel is still not the dock's business. The
   descriptor is `{kind:"ide", projectId}` and the tabs live in
   `lib/ide/editors.ts`, so a file opened at line 42 and the same file at line 9
   are one tab, and a tab with unsaved text survives the panel being closed and
   reopened. A file, a diff and a turn's changes are requests
   (`lib/ide/open.ts`) into that store, which is why the transcript can ask for
   one without importing an editor.

   Monaco itself is reached only through `lib/ide/monaco.ts`'s dynamic import,
   so a reader who never opens this panel never downloads it. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import { FilesIcon, GitCompareIcon, SearchIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useConfirm } from "@/components/confirm-dialog"
import { ChangesTab } from "@/components/workspace/changes-tab"
import { DiffTab } from "@/components/workspace/diff-tab"
import { FileExplorer } from "@/components/workspace/file-explorer"
import { FileSearch } from "@/components/workspace/file-search"
import { FileTab } from "@/components/workspace/file-tab"
import { PanelEmptyState } from "@/components/workspace/primitives"
import { ScmView } from "@/components/workspace/scm-view"
import { disposeCodeModel } from "@/components/workspace/code-editor"
import {
  activateTab,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  editorsOf,
  openTab,
  useEditors,
  type Tab,
} from "@/lib/ide/editors"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { useCoarsePointer } from "@/hooks/use-mobile"
import { useProjects } from "@/lib/queries/catalog"
import { cn } from "@/lib/utils"
import { basename } from "@/lib/workspace/fs-api"

type SideView = "explorer" | "search" | "scm"

/** Below this many pixels the side view and the editor take turns. */
const NARROW = 560

const SIDE_VIEWS: { id: SideView; label: string; icon: typeof FilesIcon }[] = [
  { id: "explorer", label: "Files", icon: FilesIcon },
  { id: "search", label: "Find a file", icon: SearchIcon },
  { id: "scm", label: "Source control", icon: GitCompareIcon },
]

/** The title a tab wears, and what the panel puts in its own tab. */
function titleOf(tab: Tab): string {
  switch (tab.body.kind) {
    case "file":
      return basename(tab.body.path)
    case "diff":
      return `${basename(tab.body.path)} (diff)`
    case "changes":
      return tab.body.scope === "uncommitted" ? "Uncommitted changes" : "Turn changes"
  }
}

export function IdePanel({ api, params }: IDockviewPanelProps<{ projectId: string }>) {
  const { projectId } = params
  const projects = useProjects()
  const project = projects.find((entry) => entry.id === projectId)
  const confirm = useConfirm()
  const coarse = useCoarsePointer()

  const editors = useEditors(projectId)
  const active = editors.tabs.find((tab) => tab.id === editors.activeId) ?? null
  const [side, setSide] = React.useState<SideView>("explorer")
  const [sideOpen, setSideOpen] = React.useState(true)

  /* ── One pane at a time when there is room for one ──
     Below `NARROW` the sidebar and the editor cannot share the width — a
     224px explorer beside a 130px editor is two things you cannot use — so the
     side view takes the whole panel while it is open, and picking a file in it
     is what closes it. Measured on the panel itself, not the window: a phone
     is narrow, but so is this panel docked beside a transcript on a laptop. */
  const root = React.useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = React.useState(false)
  React.useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      /* A hidden tab measures 0 — dockview keeps every panel mounted — and
         that is not "narrow", it is "not on screen". */
      if (width > 0) setNarrow(width < NARROW)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const narrowRef = React.useRef(narrow)
  narrowRef.current = narrow

  React.useEffect(() => {
    const name = project?.name ?? "IDE"
    api.setTitle(active ? `${titleOf(active)} — ${name}` : `${name} — IDE`)
  }, [api, project, active])

  const openFile = React.useCallback(
    (path: string) => {
      openTab(projectId, { kind: "file", path })
      if (narrowRef.current) setSideOpen(false)
    },
    [projectId]
  )

  const openDiff = React.useCallback(
    (path: string, comparison: "head" | "staged") => {
      openTab(projectId, { kind: "diff", path, comparison })
      if (narrowRef.current) setSideOpen(false)
    },
    [projectId]
  )

  /* Closing a tab asks first when it has unsaved text, and disposing the model
     is what makes it a *close* rather than a hide — the buffer, the undo stack
     and the folds go with it. `lib/workspace/buffers.ts` still holds the text
     for the next open, which is what makes discarding recoverable. */
  const close = React.useCallback(
    async (tab: Tab) => {
      if (editorsOf(projectId).dirty.has(tab.id)) {
        const discard = await confirm({
          title: `Discard changes to ${titleOf(tab)}?`,
          description: "The edits in this tab have not been written to disk.",
          confirmLabel: "Discard",
          destructive: true,
        })
        if (!discard) return
      }
      if (tab.body.kind === "file") disposeCodeModel(`${projectId}:${tab.body.path}`)
      closeTab(projectId, tab.id)
    },
    [confirm, projectId]
  )

  const menuFor = (tab: Tab): MenuItemSpec[] => [
    { label: "Close", onClick: () => void close(tab) },
    { label: "Close others", onClick: () => closeOtherTabs(projectId, tab.id) },
    { label: "Close all", onClick: () => closeAllTabs(projectId) },
  ]

  if (!project) return <PanelEmptyState>This project is no longer available.</PanelEmptyState>

  return (
    <div ref={root} className="flex h-full min-h-0 w-full">
      {/* The rail: which side view is showing, and whether one is. Clicking the
          view you are on collapses the sidebar, which is the gesture every
          editor has and the only way to get the full width on a phone. */}
      <div
        className={cn(
          "flex shrink-0 flex-col items-center gap-1 border-r border-border/60 py-1",
          coarse ? "w-12" : "w-9"
        )}
      >
        {SIDE_VIEWS.map((view) => (
          <Tooltip key={view.id}>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={view.label}
                  aria-pressed={sideOpen && side === view.id}
                  className={cn(
                    coarse ? "size-10" : "size-7",
                    sideOpen && side === view.id && "bg-accent text-accent-foreground"
                  )}
                  onClick={() => {
                    if (sideOpen && side === view.id) setSideOpen(false)
                    else {
                      setSide(view.id)
                      setSideOpen(true)
                    }
                  }}
                >
                  <view.icon className="size-4" />
                </Button>
              }
            />
            <TooltipContent side="right">{view.label}</TooltipContent>
          </Tooltip>
        ))}
      </div>

      {sideOpen && (
        <div
          className={cn(
            "flex shrink-0 flex-col border-r border-border/60",
            narrow ? "min-w-0 flex-1" : "w-56 @panel-md:w-64"
          )}
        >
          {side === "explorer" && (
            <FileExplorer
              projectId={projectId}
              onOpenFile={openFile}
              selected={active?.body.kind === "file" ? active.body.path : null}
            />
          )}
          {side === "search" && <FileSearch projectId={projectId} onOpenFile={openFile} />}
          {side === "scm" && <ScmView projectId={projectId} onOpenDiff={openDiff} onOpenFile={openFile} />}
        </div>
      )}

      <div className={cn("flex min-w-0 flex-1 flex-col", narrow && sideOpen && "hidden")}>
        {editors.tabs.length > 0 && (
          <div className="flex shrink-0 items-stretch gap-px overflow-x-auto border-b border-border/60">
            {editors.tabs.map((tab) => (
              <ItemContextMenu key={tab.id} items={menuFor(tab)}>
                <div
                  className={cn(
                    "group flex min-w-0 items-center gap-1 border-r border-border/60 pr-1 pl-2 text-xs",
                    tab.id === editors.activeId
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-accent/40"
                  )}
                >
                  <button
                    type="button"
                    onClick={() => activateTab(projectId, tab.id)}
                    className="min-w-0 max-w-40 truncate py-1.5"
                    title={tab.body.kind === "changes" ? titleOf(tab) : tab.body.path}
                  >
                    {titleOf(tab)}
                  </button>
                  {editors.dirty.has(tab.id) && (
                    <span aria-label="Unsaved" className="size-1.5 shrink-0 rounded-full bg-primary" />
                  )}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Close ${titleOf(tab)}`}
                    className="size-5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 has-focus-visible:opacity-100"
                    onClick={() => void close(tab)}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </div>
              </ItemContextMenu>
            ))}
          </div>
        )}

        {/* Every open tab stays mounted and the inactive ones are hidden, so a
            scroll position, a selection and an in-flight read survive switching
            away and back — the thing a keyed remount would throw away. */}
        <div className="relative min-h-0 flex-1">
          {editors.tabs.length === 0 ? (
            <PanelEmptyState>
              Open a file from the explorer, or follow one out of a transcript.
            </PanelEmptyState>
          ) : (
            editors.tabs.map((tab) => (
              <div
                key={tab.id}
                className={cn("absolute inset-0", tab.id === editors.activeId ? "flex" : "hidden")}
              >
                <div className="min-w-0 flex-1">
                  {tab.body.kind === "file" && (
                    <FileTab
                      projectId={projectId}
                      tabId={tab.id}
                      path={tab.body.path}
                      reveal={editors.reveals[tab.id]}
                      active={tab.id === editors.activeId}
                    />
                  )}
                  {tab.body.kind === "diff" && (
                    <DiffTab projectId={projectId} path={tab.body.path} comparison={tab.body.comparison} />
                  )}
                  {tab.body.kind === "changes" && (
                    <ChangesTab sessionId={tab.body.sessionId} scope={tab.body.scope} />
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
