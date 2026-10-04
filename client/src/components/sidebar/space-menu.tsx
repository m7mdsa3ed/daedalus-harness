/* ── The spaces switcher ──
   The scope above projects: "Personal", "Work". One card, two triggers — the
   chip beside the sidebar toggle in the app header, and an icon in the
   sidebar's footer (which is what a phone reaches, inside the drawer). The card
   is the same popover the server list uses (`sidebar/server-menu.tsx`): same
   glass, same header/list/footer, one voice for the furniture. */
import * as React from "react"
import { Boxes, Check, ChevronDownIcon, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useSidebar } from "@/components/ui/sidebar"
import { usePrompt } from "@/components/prompt-dialog"
import { GLASS_SURFACE } from "@/lib/header-chrome"
import { describeError } from "@/lib/errors"
import { useActiveSpace, useCreateSpace } from "@/lib/queries/catalog"
import { toast } from "@/lib/toast"
import { cn } from "@/lib/utils"
import { FOOTER_ICON } from "./scale"

/** The card both triggers open. `onDone` closes the popover (and, on a phone,
    the drawer) after a switch or a create — both are a "now show me that
    space" gesture. */
function SpaceMenuCard({ onDone }: { onDone: () => void }) {
  const { spaces, id, setActive } = useActiveSpace()
  const createSpace = useCreateSpace()
  const prompt = usePrompt()

  const add = async () => {
    const name = await prompt({ title: "New space", placeholder: "Work", confirmLabel: "Create" })
    if (!name) return
    try {
      const space = await createSpace.mutateAsync({ name })
      setActive(space.id)
      onDone()
    } catch (err) {
      toast.error(describeError(err).title)
    }
  }

  return (
    <div className="flex max-h-[min(26rem,var(--panel-h,100svh))] flex-col overflow-hidden rounded-2xl">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <Boxes aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] leading-5 font-semibold">Spaces</p>
          <p className="text-[11px] leading-4 text-muted-foreground">
            {spaces.length} {spaces.length === 1 ? "space" : "spaces"}
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {spaces.map((space) => {
          const isActive = space.id === id
          return (
            <button
              key={space.id}
              type="button"
              aria-current={isActive || undefined}
              onClick={() => {
                setActive(space.id)
                onDone()
              }}
              className={cn(
                "flex w-full cursor-default items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm outline-hidden select-none",
                !isActive &&
                  "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                isActive && "opacity-60"
              )}
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-sidebar-accent/70">
                <Boxes className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm leading-tight">{space.name}</span>
              {isActive && <Check className="size-4 shrink-0 text-foreground" />}
            </button>
          )
        })}
      </div>
      <div className="border-t border-border/60 p-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-between text-muted-foreground"
          disabled={createSpace.isPending}
          onClick={() => void add()}
        >
          New space…
          <Plus />
        </Button>
      </div>
    </div>
  )
}

/** The header chip, beside the sidebar toggle: the one control here that says
    *where* you are. */
export function SpaceSwitcher({ className }: { className?: string }) {
  const [open, setOpen] = React.useState(false)
  const { active } = useActiveSpace()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            title={active ? `Space: ${active.name}` : "Spaces"}
            className={cn(className, "pointer-events-auto min-w-0 gap-1")}
          >
            <Boxes className="size-3.5 shrink-0" />
            {/* The name is the width a phone does not have; the mark and the title say which. */}
            <span className="max-w-[9rem] truncate text-[13px] max-md:hidden">{active?.name ?? "Space"}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-60 max-md:hidden" />
          </Button>
        }
      />
      <PopoverContent
        align="start"
        sideOffset={8}
        className={cn(GLASS_SURFACE, "w-[min(20rem,calc(100vw-1rem))] p-0")}
      >
        <SpaceMenuCard onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** The sidebar footer's icon — the same card, reached inside the mobile drawer
    where the header chip is not the thing to hand. */
export function SpaceIconButton() {
  const [open, setOpen] = React.useState(false)
  const { isMobile, setOpenMobile } = useSidebar()
  const { active } = useActiveSpace()
  const done = () => {
    setOpen(false)
    if (isMobile) setOpenMobile(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            title={active ? `Space: ${active.name}` : "Spaces"}
            className={FOOTER_ICON}
          >
            <Boxes />
          </Button>
        }
      />
      {/* Upward on the rail, downward on a phone — the same placement the server
          and usage popovers beside it use. */}
      <PopoverContent
        align="start"
        side={isMobile ? "bottom" : "top"}
        sideOffset={8}
        className={cn(GLASS_SURFACE, "w-[min(22rem,calc(100vw-1rem))] p-0")}
      >
        <SpaceMenuCard onDone={done} />
      </PopoverContent>
    </Popover>
  )
}
