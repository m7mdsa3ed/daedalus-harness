/* ── The spaces switcher ──
   The scope above projects: "Personal", "Work". One menu, two triggers — the
   chip beside the sidebar toggle in the app header, and an icon in the
   sidebar's footer (which is what a phone reaches, inside the drawer). It is
   the app's dropdown menu, so it reads and keys like every other picker. */
import { Boxes, Plus } from "lucide-react"
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { usePrompt } from "@/components/prompt-dialog"
import { describeError } from "@/lib/errors"
import { useActiveSpace, useCreateSpace } from "@/lib/queries/catalog"
import { toast } from "@/lib/toast"
import { FooterMenuButton } from "./footer-menu"

/** The rows both triggers open. The menu closes itself on a pick; `onDone`
    is for what else should close with it (the drawer, on a phone). */
function SpaceMenuItems({ onDone }: { onDone?: () => void }) {
  const { spaces, id, setActive } = useActiveSpace()
  const createSpace = useCreateSpace()
  const prompt = usePrompt()

  const add = async () => {
    const name = await prompt({ title: "New space", placeholder: "Work", confirmLabel: "Create" })
    if (!name) return
    try {
      const space = await createSpace.mutateAsync({ name })
      setActive(space.id)
      onDone?.()
    } catch (err) {
      toast.error(describeError(err).title)
    }
  }

  return (
    <>
      {/* GroupLabel throws outside a group, so the label rides inside one. */}
      <DropdownMenuGroup>
        <DropdownMenuLabel>Spaces</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={id}
          onValueChange={(next) => {
            if (!next || next === id) return
            setActive(next)
            onDone?.()
          }}
        >
          {spaces.map((space) => (
            <DropdownMenuRadioItem key={space.id} value={space.id}>
              <Boxes />
              <span className="min-w-0 truncate">{space.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={createSpace.isPending} onClick={() => void add()}>
        <Plus />
        New space…
      </DropdownMenuItem>
    </>
  )
}

/** The sidebar footer's icon: the one place a space is picked. */
export function SpaceIconButton() {
  const { active } = useActiveSpace()
  return (
    <FooterMenuButton
      title={active ? `Space: ${active.name}` : "Spaces"}
      icon={<Boxes />}
      contentClassName="w-56"
    >
      {({ isMobile, setOpenMobile }) => (
        <SpaceMenuItems onDone={isMobile ? () => setOpenMobile(false) : undefined} />
      )}
    </FooterMenuButton>
  )
}
