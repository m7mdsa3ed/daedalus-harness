/* ── The top bar's occupants ──
   The header itself is app-shell's overlay (it carries the sidebar toggle and
   the progressive blur the transcript scrolls under); these are what stands in
   it beside the toggle: where you are, and the right panel's doors. */
import * as React from "react"
import { AppWindowIcon, PanelRightIcon, SquareTerminalIcon } from "lucide-react"
import { useLocation, useNavigate } from "react-router"

import { useScope } from "@/components/right-panel/scope-dock"
import { useNewTerminal } from "@/components/right-panel/sections"
import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-device"
import { HEADER_CHIP } from "@/lib/header-chrome"
import { useChord } from "@/lib/keybindings"
import { useProjects } from "@/lib/queries/catalog"
import {
  openSection,
  rightSheet,
  toggleRightPanel,
  useRightPanel,
} from "@/lib/right-panel"
import { projectPath } from "@/lib/router"
import { formatChord } from "@/lib/shortcuts"
import { useSessionMeta } from "@/lib/store"
import { cn } from "@/lib/utils"

/** The project and the thread (or the page's name) — the one line that says
    where you are, now that there is no tab to say it. */
export function TopBarTitle({
  heading,
}: {
  heading: { crumb?: string; title: string } | null
}) {
  const { sessionId, projectId } = useScope()
  const meta = useSessionMeta(sessionId ?? "")
  const project = useProjects().find((candidate) => candidate.id === projectId)
  const navigate = useNavigate()
  const location = useLocation()
  if (sessionId) {
    return (
      <div className="pointer-events-auto flex min-w-0 items-center gap-1.5 text-xs">
        {project && (
          <>
            <button
              type="button"
              onClick={() => void navigate(projectPath(project.id))}
              className="max-w-[10rem] truncate text-muted-foreground transition-colors hover:text-foreground"
              title={`Open ${project.name}`}
            >
              {project.name}
            </button>
            <span aria-hidden className="text-muted-foreground/50">
              /
            </span>
          </>
        )}
        <span className="min-w-0 truncate font-medium">{meta?.title ?? "Thread"}</span>
      </div>
    )
  }
  if (!heading || location.pathname === "/") return null
  return (
    <div className="pointer-events-auto flex min-w-0 items-center gap-1.5 text-xs">
      {heading.crumb && (
        <>
          <span className="truncate text-muted-foreground">{heading.crumb}</span>
          <span aria-hidden className="text-muted-foreground/50">
            /
          </span>
        </>
      )}
      <span className="min-w-0 truncate font-medium">{heading.title}</span>
    </div>
  )
}

/** The right panel's doors: a shell, the preview, and the panel itself. */
export function TopBarActions() {
  const { scope } = useScope()
  const view = useRightPanel(scope)
  const isMobile = useIsMobile()
  const newTerminal = useNewTerminal(scope)
  const panelChord = useChord("rightPanel") ?? ""
  const chip = cn(HEADER_CHIP, "pointer-events-auto shrink-0 [-webkit-app-region:no-drag]")
  const showing = (section: "terminal" | "preview") => view.open && view.section === section
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(chip, showing("terminal") && "text-foreground")}
        title="Terminal"
        aria-label="Terminal"
        aria-pressed={showing("terminal")}
        onClick={() => {
          if (view.terminals.length === 0 && !showing("terminal")) newTerminal()
          openSection(scope, "terminal")
        }}
      >
        <SquareTerminalIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(chip, showing("preview") && "text-foreground")}
        title="Preview"
        aria-label="Preview"
        aria-pressed={showing("preview")}
        onClick={() => openSection(scope, "preview")}
      >
        <AppWindowIcon className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(chip, view.open && !isMobile && "text-foreground")}
        title={`Panel${panelChord ? ` (${formatChord(panelChord)})` : ""}`}
        aria-label="Toggle the panel"
        aria-pressed={view.open}
        onClick={() => (isMobile ? rightSheet.set(true) : toggleRightPanel())}
      >
        <PanelRightIcon className="size-3.5" />
      </Button>
    </div>
  )
}
