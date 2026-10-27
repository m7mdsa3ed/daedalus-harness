/* The workspace's arrangement rows — the layouts menu's list.

   Opening a *panel* is not here: the strip's + opens a tab and nothing else
   (a menu behind a + is the header menu wearing a second face), and the panel
   rows live in the app header's one menu, which is where the rest of the
   workspace's actions are.

   The chords are printed, not bound. The bindings live in app-shell with the
   rest of them, and every row a menu draws calls the same `openWorkspacePanel`
   they do — one implementation, so the menu and the keyboard cannot disagree
   about which side a panel docks on or whether pressing it again closes it.

   A row's shape — the muted icon, the label over its hint, the trailing edge —
   is `components/menu-row`'s, shared with every other row of the header menu,
   and so is the width of the popup that holds them (`MENU_WIDTH`, which undoes
   the anchor-width sizing that squeezed a long label under its own shortcut).
   The chord is drawn only where there is a keyboard to press it with; that
   decision lives in `MenuRow` too. */
import * as React from "react"
import { Columns2, Columns3, LayoutGrid, Rows2, SaveIcon, Square, Trash2 } from "lucide-react"

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
import type { PresetId, WorkspaceDock } from "@/components/workspace/dock-context"
import { MENU_ROW, MENU_WIDTH, MenuRow } from "@/components/menu-row"

/** The arrangement presets, in the order every menu lists them. */
export const LAYOUT_PRESETS: { id: PresetId; label: string; Icon: typeof Square }[] = [
  { id: "focus", label: "Focus", Icon: Square },
  { id: "columns", label: "Two columns", Icon: Columns2 },
  { id: "columns3", label: "Three columns", Icon: Columns3 },
  { id: "rows", label: "Two rows", Icon: Rows2 },
  { id: "grid", label: "Grid", Icon: LayoutGrid },
]

/** The arrangements: the presets, and the layouts the reader has saved.

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
          {LAYOUT_PRESETS.map(({ id, label, Icon }) => (
            <DropdownMenuItem key={id} onClick={() => dock.applyPreset(id)} className={MENU_ROW}>
              <MenuRow icon={<Icon />} label={`Arrange: ${label}`} />
            </DropdownMenuItem>
          ))}
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
                    title={`Delete ${layout.name}`}
                    className="-mr-1 shrink-0 opacity-60 hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation()
                      event.preventDefault()
                      dock.deleteSavedLayout(layout.id)
                      setRevision((current) => current + 1)
                    }}
                  >
                    <Trash2 />
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
