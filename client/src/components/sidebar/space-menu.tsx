/* ── The spaces switcher ──
   The scope above projects: "Personal", "Work". One menu, two triggers — the
   chip beside the sidebar toggle in the app header, and an icon in the
   sidebar's footer (which is what a phone reaches, inside the drawer). It is
   the app's dropdown menu, so it reads and keys like every other picker. */
import { Boxes, ChevronDownIcon, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { usePrompt } from "@/components/prompt-dialog"
import { describeError } from "@/lib/errors"
import { useActiveSpace, useCreateSpace } from "@/lib/queries/catalog"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
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

/** The header chip, beside the sidebar toggle: the one control here that says
    *where* you are. */
export function SpaceSwitcher({ className }: { className?: string }) {
  const { active } = useActiveSpace()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            title={active ? `Space: ${active.name}` : "Spaces"}
            aria-label={active ? `Space: ${active.name}` : "Spaces"}
            className={cn(className, "pointer-events-auto min-w-0 gap-1")}
          >
            <Boxes className="size-3.5 shrink-0" />
            {/* The name is the width a phone does not have; the mark and the title say which. */}
            <span className="max-w-[9rem] truncate text-[13px] max-md:hidden">{active?.name ?? "Space"}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60 max-md:hidden" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={8} className="w-56">
        <SpaceMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The sidebar footer's icon — the same menu, reached inside the mobile drawer
    where the header chip is not the thing to hand. */
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
