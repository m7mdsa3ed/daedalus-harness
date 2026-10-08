/* The footer's icon button + dropdown, shared by the servers and spaces menus:
   same trigger, same placement (upward on the rail, downward on a phone). */
import type * as React from "react"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { FOOTER_ICON } from "./scale"

export function FooterMenuButton({
  title,
  icon,
  contentClassName,
  children,
}: {
  title: string
  icon: React.ReactNode
  contentClassName?: string
  children: (ctx: { isMobile: boolean; setOpenMobile: (open: boolean) => void }) => React.ReactNode
}) {
  const { isMobile, setOpenMobile } = useSidebar()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" title={title} aria-label={title} className={FOOTER_ICON}>
            {icon}
          </Button>
        }
      />
      <DropdownMenuContent
        align="start"
        side={isMobile ? "bottom" : "top"}
        sideOffset={8}
        className={cn(contentClassName)}
      >
        {children({ isMobile, setOpenMobile })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
