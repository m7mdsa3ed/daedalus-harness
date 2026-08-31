/* The + — everything the workspace can open, in one menu.

   It lives in the app header rather than on the tab strip. The strip's copy was
   per *group*, so a split dock had two of them and neither was obviously the
   one to press; and the strip disappears into the tab row on a narrow screen,
   which is the screen where this matters most, because there is no keyboard to
   reach any of it with.

   The chords are printed, not bound. The bindings live in app-shell with the
   rest of them, and every row here calls the same `openWorkspacePanel` they do
   — one implementation, so the menu and the keyboard cannot disagree about
   which side a panel docks on or whether pressing it again closes it.

   The menu sizes itself to its rows (`w-auto`), which is the one thing it could
   not do by default: `DropdownMenuContent` is `w-(--anchor-width)` — the width
   of the trigger — and this trigger is a 28px icon button, so every row was
   squeezed into `min-w-48` and "Output & problems" wrapped under its own
   shortcut. A row is one line here: the label never wraps, and the chord sits
   at the trailing edge with a gap it cannot lose. */
import type * as React from "react"
import { PlusIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Shortcut } from "@/components/shortcut"
import { PANEL_ICONS } from "@/components/workspace/panel-kinds"
import { KEYS } from "@/lib/shortcuts"
import type { PanelKind } from "@/lib/workspace/panels"

const OPENABLE: { kind: PanelKind; label: string; hint: string; chord?: string }[] = [
  {
    kind: "terminal",
    label: "Terminal",
    hint: "A shell in this project",
    chord: KEYS.terminal,
  },
  { kind: "web", label: "Browser", hint: "A page beside the thread" },
]

/** One row: icon, label over its hint, the chord at the trailing edge. The
    label and the hint are a column so the chord cannot be pushed onto a second
    line by a long name, and neither line ever wraps. */
function PanelRow({
  icon: Icon,
  label,
  hint,
  chord,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  hint?: string
  chord?: string
  onClick: () => void
}) {
  return (
    <DropdownMenuItem onClick={onClick} className="items-start gap-2.5 py-2">
      <Icon className="mt-0.5 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate leading-5 whitespace-nowrap">{label}</span>
        {hint && (
          <span className="truncate text-xs leading-4 whitespace-nowrap text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground/70">
            {hint}
          </span>
        )}
      </span>
      {chord && (
        <DropdownMenuShortcut className="mt-0.5 ps-4">
          <Shortcut chord={chord} />
        </DropdownMenuShortcut>
      )}
    </DropdownMenuItem>
  )
}

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
      {/* `w-auto` undoes the anchor-width sizing; the max is the escape hatch
          for a narrow phone, where a menu wider than the screen would be
          clipped rather than merely wide. */}
      <DropdownMenuContent align="end" className="w-auto max-w-[min(20rem,calc(100vw-1.5rem))] min-w-60">
        <DropdownMenuGroup>
          <PanelRow
            icon={PlusIcon}
            label="New thread"
            hint="A fresh conversation in this workspace"
            chord={KEYS.newThread}
            onClick={onNewTab}
          />
        </DropdownMenuGroup>
        {canOpenPanels && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="px-3 py-1.5 text-[10px] font-medium tracking-widest uppercase">
                Open a panel
              </DropdownMenuLabel>
              {OPENABLE.map((entry) => (
                <PanelRow
                  key={entry.kind}
                  icon={PANEL_ICONS[entry.kind]}
                  label={entry.label}
                  hint={entry.hint}
                  chord={entry.chord}
                  onClick={() => onOpen(entry.kind)}
                />
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
