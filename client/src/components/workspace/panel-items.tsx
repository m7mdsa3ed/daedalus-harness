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

   A row's shape — the muted icon, the label over its hint, the trailing edge —
   is `components/menu-row`'s, shared with every other row of the header menu,
   and so is the width of the popup that holds them (`MENU_WIDTH`, which undoes
   the anchor-width sizing that squeezed a long label under its own shortcut).
   The chord is drawn only where there is a keyboard to press it with; that
   decision lives in `MenuRow` too. */
import * as React from "react"
import {
  AppWindowIcon,
  LayoutGrid,
  PanelsTopLeft,
  PlusIcon,
  Rows3,
  SaveIcon,
  Square,
  Trash2,
} from "lucide-react"

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { usePrompt } from "@/components/prompt-dialog"
import { toast } from "@/lib/toast"
import type { WorkspaceDock } from "@/components/workspace/dock"
import { MENU_ROW, MENU_WIDTH, MenuRow } from "@/components/menu-row"
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
  { kind: "tasks", label: "Tasks", hint: "A board beside the work" },
  {
    kind: "ide",
    label: "IDE",
    hint: "Editor, files, search and source control",
    shortcut: "ide",
  },
]

/** One row, in the one shape every row of this menu has. */
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
    <DropdownMenuItem onClick={onClick} className={MENU_ROW}>
      <MenuRow icon={<Icon />} label={label} hint={hint} shortcut={shortcut} />
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
  canOpenPanels,
  flat,
}: {
  onNewTab: () => void
  onOpen: (kind: PanelKind) => void
  /** False with no thread routed: there is no project to open a panel for. */
  canOpenPanels: boolean
  /** Open the panel rows out in place instead of behind "Open a panel ▸".
      For the tab strip's +, where the menu *is* the question the submenu asks:
      a button meaning "open something" that answers with one row and a sideways
      list is a hop for nothing. In the header's menu the submenu stays, because
      there these rows share a list with everything else the thread can do. */
  flat?: boolean
}) {
  const panels = OPENABLE.map((entry) => (
    <PanelRow
      key={entry.kind}
      icon={PANEL_ICONS[entry.kind]}
      label={entry.label}
      hint={entry.hint}
      shortcut={entry.shortcut}
      onClick={() => onOpen(entry.kind)}
    />
  ))

  return (
    <DropdownMenuGroup>
      <PanelRow
        icon={PlusIcon}
        label="New thread"
        hint="A fresh conversation in this workspace"
        shortcut="newThread"
        onClick={onNewTab}
      />
      {canOpenPanels && flat && (
        <>
          <DropdownMenuSeparator />
          {panels}
        </>
      )}
      {canOpenPanels && !flat && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className={MENU_ROW}>
            <MenuRow
              icon={<PanelsTopLeft />}
              label="Open a panel"
              hint="A terminal, a browser, a board or the IDE"
            />
          </DropdownMenuSubTrigger>
          {/* Same sizing as the menu that holds it: a submenu is anchored to
              its trigger row, so without this the hints would wrap. */}
          <DropdownMenuSubContent className={MENU_WIDTH}>{panels}</DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
    </DropdownMenuGroup>
  )
}

/** The arrangements: the two presets, and the layouts the reader has saved.

    A submenu rather than rows, and in this menu rather than in the tab strip,
    for the same reason the panels are: it is one list, it is read rarely, and
    the strip is where a split dock would end up with two copies of it.

    Presets and saved layouts sit together because they answer the same
    question, but they are not the same thing and the menu says so — a preset
    rearranges what is open, a saved layout opens and closes panels to match
    what it holds (see `lib/workspace/layout.ts`). */
export function WorkspaceLayoutItems({ dock }: { dock: WorkspaceDock }) {
  const prompt = usePrompt()
  /* The saved list is localStorage, read on open. Bumped after a save or a
     delete so the menu that did it shows the result without being reopened. */
  const [revision, setRevision] = React.useState(0)
  const layouts = React.useMemo(() => dock.savedLayouts(), [dock, revision])

  const save = () => {
    void prompt({
      title: "Save this layout",
      description: "The panels that are open now, and where they sit.",
      placeholder: "Review",
      confirmLabel: "Save",
      maxLength: 60,
    }).then((name) => {
      if (!name) return
      if (dock.saveLayoutAs(name)) {
        setRevision((current) => current + 1)
        toast.success(`Saved “${name}”`)
      }
    })
  }

  return (
    <DropdownMenuGroup>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className={MENU_ROW}>
          <MenuRow
            icon={<LayoutGrid />}
            label="Layouts"
            hint="Rearrange the dock, or open a saved set"
          />
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className={MENU_WIDTH}>
          <DropdownMenuItem onClick={() => dock.applyPreset("ide")} className={MENU_ROW}>
            <MenuRow icon={<Rows3 />} label="Arrange: IDE" />
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => dock.applyPreset("focus")} className={MENU_ROW}>
            <MenuRow icon={<Square />} label="Arrange: Focus" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={save} className={MENU_ROW}>
            <MenuRow icon={<SaveIcon />} label="Save this layout…" />
          </DropdownMenuItem>
          {layouts.map((layout) => (
            <DropdownMenuItem
              key={layout.id}
              onClick={() => dock.applySavedLayout(layout.id)}
              className={MENU_ROW}
            >
              <MenuRow
                icon={<LayoutGrid />}
                label={layout.name}
                /* Deleting from the row that applies it: a saved layout has no
                   page of its own, and a list that can only be added to is one
                   nobody ever prunes. */
                trailing={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Delete ${layout.name}`}
                    className="-mr-1 size-5 shrink-0 opacity-60 hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation()
                      event.preventDefault()
                      dock.deleteSavedLayout(layout.id)
                      setRevision((current) => current + 1)
                    }}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                }
              />
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuGroup>
  )
}
