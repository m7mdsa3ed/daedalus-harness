/* ── The right panel ──
   One column beside the centre pane: a rail of the sections a scope offers and
   the section in front. A desktop draws it as a resizable column; a phone draws
   the same body as a full-screen sheet.

   **Scopes stay mounted.** A shell's scrollback and a preview's page are DOM
   state, so the panels of the last few scopes you were in are kept (hidden)
   rather than torn down on every navigation — the thread dock gave each thread
   that for free by keeping every tab mounted. The socket and the PTY are the
   server's either way; what this saves is the redraw. */
import * as React from "react"
import {
  AppWindowIcon,
  BotIcon,
  CoinsIcon,
  GitCompareIcon,
  InfoIcon,
  ListChecksIcon,
  PanelRightCloseIcon,
  RouteIcon,
  SquareTerminalIcon,
  type LucideIcon,
} from "lucide-react"

import { ScopeBoundary, useScope } from "@/components/right-panel/scope-dock"
import { SectionBody } from "@/components/right-panel/sections"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useIsMobile } from "@/hooks/use-device"
import type { Actions } from "@/lib/actions"
import {
  RIGHT_DEFAULT,
  rightSheet,
  scopeProject,
  scopeSession,
  sectionsFor,
  setRightOpen,
  setRightWidth,
  openSection,
  useRightPanel,
  type RightSection,
  type Scope,
} from "@/lib/right-panel"
import { useSessionMeta } from "@/lib/store"
import { cn } from "@/lib/utils"

export const SECTION_META: Record<RightSection, { title: string; icon: LucideIcon }> = {
  changes: { title: "Source Control", icon: GitCompareIcon },
  plan: { title: "Plan", icon: ListChecksIcon },
  agents: { title: "Agents", icon: BotIcon },
  details: { title: "Details", icon: InfoIcon },
  tokens: { title: "Tokens", icon: CoinsIcon },
  trajectory: { title: "Trajectory", icon: RouteIcon },
  terminal: { title: "Terminal", icon: SquareTerminalIcon },
  preview: { title: "Preview", icon: AppWindowIcon },
}

/** How many scopes keep their panels mounted. */
const KEEP_MOUNTED = 3

function useMountedScopes(scope: Scope): Scope[] {
  const [mounted, setMounted] = React.useState<Scope[]>([scope])
  React.useEffect(() => {
    setMounted((current) => [...current.filter((entry) => entry !== scope), scope].slice(-KEEP_MOUNTED))
  }, [scope])
  return mounted.includes(scope) ? mounted : [...mounted, scope]
}

/** One scope's sections. A section is mounted the first time it is in front and
    then kept, hidden, so a shell keeps its scrollback while you read the plan. */
function ScopePane({ scope, current, actions }: { scope: Scope; current: boolean; actions: Actions }) {
  const view = useRightPanel(scope)
  const sessionId = scopeSession(scope)
  const meta = useSessionMeta(sessionId ?? "")
  const projectId = scopeProject(scope) ?? meta?.projectId ?? null
  const [visited, setVisited] = React.useState<RightSection[]>([view.section])
  React.useEffect(() => {
    setVisited((all) => (all.includes(view.section) ? all : [...all, view.section]))
  }, [view.section])

  return (
    <ScopeBoundary scope={scope} sessionId={sessionId} projectId={projectId}>
      <div className={cn("relative min-h-0 flex-1", !current && "hidden")}>
        {visited
          .filter((section) => sectionsFor(scope).includes(section))
          .map((section) => (
            <div key={section} className={cn("absolute inset-0 overflow-hidden", section !== view.section && "hidden")}>
              <SectionBody section={section} scope={scope} sessionId={sessionId} actions={actions} />
            </div>
          ))}
      </div>
    </ScopeBoundary>
  )
}

function Rail({ scope, onClose }: { scope: Scope; onClose: () => void }) {
  const view = useRightPanel(scope)
  return (
    <div role="tablist" aria-label="Panel sections" className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {sectionsFor(scope).map((section) => {
          const { title, icon: Icon } = SECTION_META[section]
          const active = view.section === section
          return (
            <Button
              key={section}
              role="tab"
              aria-selected={active}
              variant="ghost"
              size="icon-xs"
              title={title}
              aria-label={title}
              onClick={() => openSection(scope, section)}
              className={cn(
                "size-7 shrink-0 text-muted-foreground",
                active && "bg-accent text-accent-foreground"
              )}
            >
              <Icon aria-hidden className="size-3.5" />
            </Button>
          )
        })}
      </div>
      <span className="shrink-0 truncate px-1 text-xs font-medium text-muted-foreground">
        {SECTION_META[view.section]?.title}
      </span>
      <Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Hide the panel" title="Hide the panel" className="shrink-0">
        <PanelRightCloseIcon aria-hidden className="size-4" />
      </Button>
    </div>
  )
}

function PanelBody({ actions, onClose }: { actions: Actions; onClose: () => void }) {
  const { scope } = useScope()
  const mounted = useMountedScopes(scope)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Rail scope={scope} onClose={onClose} />
      {mounted.map((entry) => (
        <ScopePane key={entry} scope={entry} current={entry === scope} actions={actions} />
      ))}
    </div>
  )
}

/** The desktop column. Draws nothing while closed (a closed panel mounts no
    shell), and reserves the header's height so its rail starts below it. */
export function RightPanelColumn({ actions }: { actions: Actions }) {
  const isMobile = useIsMobile()
  const { scope } = useScope()
  const view = useRightPanel(scope)
  const [dragWidth, setDragWidth] = React.useState<number | null>(null)
  if (isMobile || !view.open) return null
  const clamp = (value: number) => Math.min(value, Math.max(320, Math.round(window.innerWidth * 0.6)))
  const width = clamp(dragWidth ?? view.width)

  return (
    <aside
      aria-label="Panel"
      data-slot="right-panel"
      style={{ width }}
      className="relative flex min-h-0 shrink-0 flex-col border-l border-border bg-background pt-[var(--app-header-h)]"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the panel"
        title="Drag to resize · double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          setDragWidth(width)
        }}
        onPointerMove={(event) => {
          if (dragWidth === null) return
          const right = event.currentTarget.parentElement?.getBoundingClientRect().right ?? event.clientX
          setDragWidth(clamp(right - event.clientX))
        }}
        onPointerUp={() => {
          if (dragWidth !== null) setRightWidth(dragWidth)
          setDragWidth(null)
        }}
        onDoubleClick={() => setRightWidth(RIGHT_DEFAULT)}
        className={cn(
          "absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-primary/30",
          dragWidth !== null && "bg-primary/40"
        )}
      />
      <PanelBody actions={actions} onClose={() => setRightOpen(false)} />
    </aside>
  )
}

/** The phone's panel: the same body, full screen. Its open flag is not stored
    (`rightSheet`), so a reload never lands on an overlay. */
export function RightPanelSheet({ actions }: { actions: Actions }) {
  const isMobile = useIsMobile()
  const open = rightSheet.use()
  if (!isMobile) return null
  return (
    <Sheet open={open} onOpenChange={(next) => rightSheet.set(next)}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full max-w-none gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-none"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Panel</SheetTitle>
          <SheetDescription>The tools for this thread: readings, shells and preview.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col pt-[var(--safe-top)]">
          <PanelBody actions={actions} onClose={() => rightSheet.set(false)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
