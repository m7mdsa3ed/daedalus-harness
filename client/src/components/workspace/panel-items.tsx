/* Everything the workspace can open — the rows the + used to be.

   They live in the app header's one menu (components/thread-menu) rather than
   on the tab strip. The strip's copy was per *group*, so a split dock had two
   of them and neither was obviously the one to press; and the strip disappears
   into the tab row on a narrow screen, which is the screen where this matters
   most, because there is no keyboard to reach any of it with. The + button
   went the same way: the header now has one menu, not three icons.

   The chords are printed, not bound. The bindings live in app-shell with the
   rest of them, and every row here calls the same `openWorkspacePanel` they do
   — one implementation, so the menu and the keyboard cannot disagree about
   which side a panel docks on or whether pressing it again closes it.

   The menu that holds these sizes itself to its rows (`w-auto`), which is the
   one thing it could not do by default: `DropdownMenuContent` is
   `w-(--anchor-width)` — the width of the trigger — and that trigger is a 28px
   icon button, so every row was squeezed into `min-w-48` and a long label
   wrapped under its own shortcut. A row is one line here: the label never
   wraps, and the chord sits at the trailing edge with a gap it cannot lose. */
import type * as React from "react"
import { AppWindowIcon, PanelsTopLeft, PlusIcon } from "lucide-react"

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { Shortcut } from "@/components/shortcut"
import { PANEL_ICONS } from "@/components/workspace/panel-kinds"
import type { ShortcutId } from "@/lib/shortcuts"
import type { PanelKind } from "@/lib/workspace/panels"

const OPENABLE: { kind: PanelKind; label: string; hint: string; shortcut?: ShortcutId }[] = [
  {
    kind: "terminal",
    label: "Terminal",
    hint: "A shell in this project",
    shortcut: "terminal",
  },
  { kind: "web", label: "Browser", hint: "A page beside the thread" },
  {
    kind: "ide",
    label: "IDE",
    hint: "Editor, files, search and source control",
    shortcut: "ide",
  },
]

/** One row: icon, label over its hint, the chord at the trailing edge. The
    label and the hint are a column so the chord cannot be pushed onto a second
    line by a long name, and neither line ever wraps. */
function PanelRow({
  icon: Icon,
  label,
  hint,
  shortcut,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  hint?: string
  shortcut?: ShortcutId
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
      {shortcut && (
        <DropdownMenuShortcut className="mt-0.5 ps-4">
          <Shortcut id={shortcut} />
        </DropdownMenuShortcut>
      )}
    </DropdownMenuItem>
  )
}

/** The workspace rows, for whichever menu is holding them today.

    New thread is a root row and the panels are a submenu behind it: opening a
    panel is the rarer of the two and it is a *list* — one line that opens
    sideways beats two more lines the reader walks past to reach the thread's
    own actions. */
export function WorkspacePanelItems({
  onNewTab,
  onOpen,
  onOpenPreview,
  canOpenPanels,
}: {
  onNewTab: () => void
  onOpen: (kind: PanelKind) => void
  /** Present only when the routed thread's project has a dev command — the
      preview is the Browser panel pointed at the managed dev server, and a
      project without one has nothing to point at. */
  onOpenPreview?: () => void
  /** False with no thread routed: there is no project to open a panel for. */
  canOpenPanels: boolean
}) {
  return (
    <DropdownMenuGroup>
      <PanelRow
        icon={PlusIcon}
        label="New thread"
        hint="A fresh conversation in this workspace"
        shortcut="newThread"
        onClick={onNewTab}
      />
      {canOpenPanels && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <PanelsTopLeft />
            Open a panel
          </DropdownMenuSubTrigger>
          {/* Same sizing as the menu that holds it: a submenu is anchored to
              its trigger row, so without this the hints would wrap. */}
          <DropdownMenuSubContent className="w-auto max-w-[min(20rem,calc(100vw-1.5rem))] min-w-60">
            {onOpenPreview && (
              <PanelRow
                icon={AppWindowIcon}
                label="Preview"
                hint="The app, running in its dev server"
                shortcut="preview"
                onClick={onOpenPreview}
              />
            )}
            {OPENABLE.map((entry) => (
              <PanelRow
                key={entry.kind}
                icon={PANEL_ICONS[entry.kind]}
                label={entry.label}
                hint={entry.hint}
                shortcut={entry.shortcut}
                onClick={() => onOpen(entry.kind)}
              />
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
    </DropdownMenuGroup>
  )
}
