/* ── The Source Control dock ──
   Sublime Merge's panes as dockview's: Locations, History, Files and Diff each
   a panel with a tab, so any of them can be hidden (the tab's ✕, or the Panels
   menu), dragged beside or into another, and resized - and the arrangement is
   kept. What the panes *show* is `GitWorkspace`'s: it builds each one as a node
   and hands them down, because every pane reads the same selection (which
   commit, which file) and a dock cannot own that.

   It is the thread dock's recipe one level in: the same `.dock-nested` surface,
   its own closed world (nothing crosses into or out of it), and on a phone-wide
   panel every pane is a tab in one group, since a split has no room there. */
import * as React from "react"
import {
  DockviewReact,
  themeAbyss,
  themeLight,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview-react"
import { LayoutPanelLeftIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { watchSashReset } from "@/components/workspace/dock-sizes"
import { PanelContainer } from "@/components/workspace/panel-container"
import { useIsNarrow } from "@/hooks/use-device"
import { saveScmLayout, savedScmLayout, SCM_PANES, type ScmPaneId } from "@/lib/workspace/scm-dock"
import { useTheme } from "@/lib/theme"
import { cn } from "@/lib/utils"

const TITLE = Object.fromEntries(SCM_PANES.map((pane) => [pane.id, pane.title])) as Record<ScmPaneId, string>

/* Which pane opens where, and how big: history on top, the files under it with
   the diff beside them, Locations a full-height column at the left. Order
   matters - a root-level `left` after the rest is what makes it full height. */
const OPEN_AT: Record<ScmPaneId, (api: DockviewApi) => Parameters<DockviewApi["addPanel"]>[0]["position"]> = {
  history: (api) => (api.getPanel("files") ? { referencePanel: "files", direction: "above" } : api.getPanel("diff") ? { referencePanel: "diff", direction: "above" } : undefined),
  files: (api) => (api.getPanel("history") ? { referencePanel: "history", direction: "below" } : api.getPanel("diff") ? { referencePanel: "diff", direction: "left" } : undefined),
  diff: (api) => (api.getPanel("files") ? { referencePanel: "files", direction: "right" } : api.getPanel("history") ? { referencePanel: "history", direction: "below" } : undefined),
  locations: () => ({ direction: "left" }),
}
const SIZE: Partial<Record<ScmPaneId, { initialWidth?: number; initialHeight?: number }>> = {
  locations: { initialWidth: 200 },
  files: { initialHeight: 320 },
  diff: { initialWidth: 420 },
}

function open(api: DockviewApi, id: ScmPaneId) {
  const existing = api.getPanel(id)
  if (existing) return existing.api.setActive()
  api.addPanel({ id, component: id, title: TITLE[id], position: OPEN_AT[id](api), ...SIZE[id] })
}

function buildDefault(api: DockviewApi) {
  api.clear()
  for (const id of ["history", "files", "diff", "locations"] as const) open(api, id)
  api.getPanel("history")?.api.setActive()
}

/** Every pane a tab of one group - a split has no room in a narrow panel. */
function stack(api: DockviewApi) {
  for (const { id } of SCM_PANES) if (!api.getPanel(id)) open(api, id)
  const home = api.getPanel("files")?.group ?? api.groups[0]
  if (!home) return
  for (const panel of api.panels) if (panel.group !== home) panel.api.moveTo({ group: home })
  api.getPanel("files")?.api.setActive()
}

/** The nodes `GitWorkspace` builds, one per pane. */
const PanesContext = React.createContext<Record<ScmPaneId, React.ReactNode> | null>(null)

function Pane({ api }: IDockviewPanelProps) {
  const panes = React.useContext(PanesContext)
  return (
    <PanelContainer>
      <div className="flex h-full min-h-0 flex-col">{panes?.[api.id as ScmPaneId]}</div>
    </PanelContainer>
  )
}

const components = Object.fromEntries(SCM_PANES.map((pane) => [pane.id, Pane])) as Record<ScmPaneId, typeof Pane>

/** The inner tab: the dock tab's material, a title and a ✕ - hiding is closing. */
function ScmTab({ api }: IDockviewPanelHeaderProps) {
  const active = React.useSyncExternalStore(
    (onChange) => {
      const sub = api.onDidActiveChange(onChange)
      return () => sub.dispose()
    },
    () => api.isActive,
    () => api.isActive
  )
  return (
    <div className="flex h-full min-w-0 flex-1 items-center py-0.5">
      <div
        data-active={active || undefined}
        className={cn("dock-tab relative mx-0.5 flex h-[var(--dock-chip-h)] min-w-0 flex-1 items-center gap-1.5 py-0 pr-2 pl-2.5 text-xs", active ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
        onKeyDown={(event) => {
          if (event.key === "Delete" || event.key === "Backspace") api.close()
        }}
      >
        <span data-tab-title className="flex min-w-0 flex-1 items-center"><span className="truncate">{api.title}</span></span>
        <button
          type="button"
          tabIndex={-1}
          data-tab-action="close"
          aria-label={`Hide ${api.title}`}
          title={`Hide ${api.title}`}
          className="grid size-4 shrink-0 place-items-center rounded-sm opacity-60 hover:bg-foreground/10 hover:opacity-100"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            api.close()
          }}
        >
          <XIcon className="size-3" />
        </button>
      </div>
    </div>
  )
}

export function ScmDock({ panes }: { panes: Record<ScmPaneId, React.ReactNode> }) {
  const { resolved } = useTheme()
  const root = React.useRef<HTMLDivElement>(null)
  const narrow = useIsNarrow(root)
  const narrowRef = React.useRef(narrow)
  narrowRef.current = narrow
  const [api, setApi] = React.useState<DockviewApi | null>(null)
  /* Which panes are open - re-read on every add and remove, for the menu. */
  const openIds = React.useSyncExternalStore(
    (onChange) => {
      if (!api) return () => {}
      const subs = [api.onDidAddPanel(onChange), api.onDidRemovePanel(onChange)]
      return () => subs.forEach((sub) => sub.dispose())
    },
    () => (api ? api.panels.map((panel) => panel.id).sort().join(",") : ""),
    () => ""
  ).split(",")

  const restore = React.useCallback((next: DockviewApi) => {
    const saved = savedScmLayout()
    if (saved) {
      try {
        next.fromJSON(saved)
        return
      } catch (error) {
        console.warn("Could not restore the Source Control layout", error)
      }
    }
    buildDefault(next)
  }, [])

  const teardown = React.useRef<(() => void) | undefined>(undefined)
  React.useEffect(() => () => teardown.current?.(), [])

  const onReady = (next: DockviewApi) => {
    setApi(next)
    if (narrowRef.current) stack(next)
    else restore(next)
    let timer: ReturnType<typeof setTimeout> | undefined
    const stopReset = watchSashReset(next)
    const layout = next.onDidLayoutChange(() => {
      clearTimeout(timer)
      /* A stacked layout is the narrow panel's, not the reader's: never kept. */
      timer = setTimeout(() => { if (!narrowRef.current) saveScmLayout(next.toJSON()) }, 400)
    })
    return () => {
      clearTimeout(timer)
      stopReset()
      layout.dispose()
    }
  }

  /* Crossing the narrow line folds the panes together, and back out unfolds
     them to the arrangement the reader had. */
  const wasNarrow = React.useRef(narrow)
  React.useEffect(() => {
    if (!api || wasNarrow.current === narrow) return
    wasNarrow.current = narrow
    if (narrow) stack(api)
    else restore(api)
  }, [narrow, api, restore])

  const theme = React.useMemo(
    () => ({ ...(resolved === "dark" ? themeAbyss : themeLight), tabAnimation: "smooth" as const, dndTabIndicator: "line" as const }),
    [resolved]
  )

  return (
    <PanesContext.Provider value={panes}>
      {/* The thread dock sets `--dock-header-overlap` on its groups, and a custom
          property inherits: zeroed here so these strips do not take its margin. */}
      <div ref={root} style={{ "--dock-header-overlap": "0px" } as React.CSSProperties} className="relative flex min-h-0 flex-1 flex-col">
        <DockviewReact
          className="dock-nested h-full min-h-0 flex-1"
          components={components}
          defaultRenderer="always"
          defaultTabComponent={ScmTab}
          disableTabsOverflowList
          disableDnd={narrow}
          theme={theme}
          onReady={(event) => {
            teardown.current?.()
            teardown.current = onReady(event.api)
          }}
        />
        <div className="absolute right-1 top-0 z-30 flex h-[var(--dock-chip-h)] items-center">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="Show or hide panes" title="Show or hide panes" className="size-6 text-muted-foreground hover:text-foreground">
                  <LayoutPanelLeftIcon className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-44">
              {SCM_PANES.map((pane) => (
                <DropdownMenuCheckboxItem
                  key={pane.id}
                  checked={openIds.includes(pane.id)}
                  onCheckedChange={(on) => {
                    if (!api) return
                    if (on) open(api, pane.id)
                    else api.getPanel(pane.id)?.api.close()
                  }}
                >
                  {pane.title}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { if (api) { saveScmLayout(null); buildDefault(api) } }}>Reset layout</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </PanesContext.Provider>
  )
}
