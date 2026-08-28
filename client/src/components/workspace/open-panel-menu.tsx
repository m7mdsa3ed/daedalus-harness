/* The + — everything the workspace can open, in one menu.

   It lives in the app header rather than on the tab strip. The strip's copy was
   per *group*, so a split dock had two of them and neither was obviously the
   one to press; and the strip disappears into the tab row on a narrow screen,
   which is the screen where this matters most, because there is no keyboard to
   reach any of it with.

   The chords are printed, not bound. The bindings live in app-shell with the
   rest of them, and every row here calls the same `openWorkspacePanel` they do
   — one implementation, so the menu and the keyboard cannot disagree about
   which side a panel docks on or whether pressing it again closes it. */
import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PANEL_ICONS } from "@/components/workspace/panel-kinds"
import { KEYS, formatChord } from "@/lib/shortcuts"
import type { PanelKind } from "@/lib/workspace/panels"

const OPENABLE: { kind: PanelKind; label: string; chord?: string }[] = [
  { kind: "explorer", label: "File explorer", chord: KEYS.explorer },
  { kind: "source-control", label: "Source control", chord: KEYS.sourceControl },
  { kind: "terminal", label: "Terminal", chord: KEYS.terminal },
  { kind: "output", label: "Output & problems", chord: KEYS.output },
  { kind: "web", label: "Preview" },
]

export function OpenPanelMenu({
  onNewTab,
  onOpen,
  canOpenPanels,
}: {
  onNewTab: () => void
  onOpen: (kind: PanelKind) => void
  /** False with no thread routed: there is no project to open a panel for. */
  canOpenPanels: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open a panel"
            title="Open a panel"
            className="shrink-0 text-muted-foreground"
          >
            <PlusIcon />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onNewTab}>
          <PlusIcon />
          New thread
          <DropdownMenuShortcut>{formatChord(KEYS.newThread)}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {canOpenPanels && (
          <>
            <DropdownMenuSeparator />
            {OPENABLE.map((entry) => {
              const Icon = PANEL_ICONS[entry.kind]
              return (
                <DropdownMenuItem key={entry.kind} onClick={() => onOpen(entry.kind)}>
                  <Icon />
                  {entry.label}
                  {entry.chord && (
                    <DropdownMenuShortcut>{formatChord(entry.chord)}</DropdownMenuShortcut>
                  )}
                </DropdownMenuItem>
              )
            })}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
