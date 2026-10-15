/* ── A thread's transcript, inside its dock tab ──
   What `ThreadDock` was, less the nested dockview: the transcript with the scope
   the right panel reads (this thread's), the door "Open in inspector" knocks on,
   and the ref the readings scroll the transcript through. The thread's tools —
   readings, shell, preview — are the right panel's, not panes of this tab. */
import * as React from "react"
import { PlusIcon } from "lucide-react"

import { SECTION_META } from "@/components/right-panel/right-panel"
import { ScopeBoundary } from "@/components/right-panel/scope-dock"
import { useNewTerminal } from "@/components/right-panel/sections"
import { ThreadView } from "@/components/thread-view/thread-view"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Actions } from "@/lib/actions"
import { InspectorContext, ThreadJumpContext } from "@/lib/inspector"
import {
  openSection,
  threadScope,
  THREAD_SECTIONS,
  type RightSection,
  type Scope,
} from "@/lib/right-panel"
import { jumpRefFor } from "@/lib/thread-jump"

/** The + over the transcript — the one door to the thread's panels. A reading is
    shown in the right panel (not doubled); a terminal is a new shell. */
function ThreadPanelsMenu({ scope }: { scope: Scope }) {
  const newTerminal = useNewTerminal(scope)
  const TerminalIcon = SECTION_META.terminal.icon
  const row = (section: RightSection, label = SECTION_META[section].title) => {
    const { icon: Icon } = SECTION_META[section]
    return (
      <DropdownMenuItem key={section} onClick={() => openSection(scope, section)}>
        <Icon />
        {label}
      </DropdownMenuItem>
    )
  }
  const readings = THREAD_SECTIONS.filter(
    (section) => section !== "terminal" && section !== "preview" && section !== "trajectory"
  )
  return (
    <div className="pointer-events-none absolute top-[var(--dock-content-overlap,var(--app-header-h))] right-3 z-30 mt-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Open a panel for this thread"
              title="Open a panel for this thread"
              className="pointer-events-auto size-7 rounded-full text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <PlusIcon className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-48">
          {readings.map((section) => row(section))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={newTerminal}>
            <TerminalIcon />
            New terminal
          </DropdownMenuItem>
          {row("preview")}
          {row("trajectory")}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export function ThreadBody({
  sessionId,
  projectId,
  actions,
}: {
  sessionId: string
  projectId: string
  actions: Actions
}) {
  const scope = threadScope(sessionId)
  const openReading = React.useCallback((tab: RightSection) => openSection(scope, tab), [scope])
  const jumpRef = React.useMemo(() => jumpRefFor(sessionId), [sessionId])
  return (
    <ScopeBoundary scope={scope} sessionId={sessionId} projectId={projectId}>
      <InspectorContext.Provider value={openReading}>
        <ThreadJumpContext.Provider value={jumpRef}>
          <div className="relative flex h-full min-h-0 flex-col">
            <ThreadView sessionId={sessionId} actions={actions} docked />
            <ThreadPanelsMenu scope={scope} />
          </div>
        </ThreadJumpContext.Provider>
      </InspectorContext.Provider>
    </ScopeBoundary>
  )
}
