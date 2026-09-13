/* ── The "account" row ──
   How both desktop apps end their sidebar: the server this client is on, name
   over address. Clicking it switches servers — everything this device knows
   is one card away, plus Add and Settings › General for the rest (rename,
   forget, teardown before disconnect).

   The card is the same popover the plan-usage row above it opens
   (`sidebar/usage.tsx`): same side, same width, same header/list/footer, same
   glass — one voice for the footer's two popovers. */
import * as React from "react"
import { Check, ChevronDown, ChevronRightIcon, Plus, ServerIcon } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SidebarMenuButton, useSidebar } from "@/components/ui/sidebar"
import { GLASS_SURFACE } from "@/lib/header-chrome"
import { settingsPath } from "@/lib/router"
import { loadServers, setActiveServer, type ServerSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { ROW } from "./scale"

/** The address without its scheme — what identifies a server on a footer row
    the width of a sidebar. */
function serverHost(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "")
  } catch {
    return url
  }
}

export function ServerMenu({
  settings,
  onAddServer,
}: {
  settings: ServerSettings
  onAddServer: () => void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const [open, setOpen] = React.useState(false)
  /* The servers this device knows. Unlike everything else this comes from
     localStorage, not the store, and it only changes on Add/switch — both of
     which hard-reload the app — so reading it once per mount is enough. */
  const servers = React.useMemo(loadServers, [])

  const close = () => {
    setOpen(false)
    if (isMobile) setOpenMobile(false)
  }
  const handleAdd = () => {
    setOpen(false)
    onAddServer()
  }
  const handleManage = () => {
    close()
    void navigate(settingsPath("general"))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <SidebarMenuButton
            size="sm"
            tooltip={`${settings.name} · ${settings.url}`}
            isActive={location.pathname === settingsPath("general")}
            /* ROW like every other sidebar row — the same `px-2` inset, bare
               `size-4` icon and 13px label, differing only in height, for the
               two lines. The icon wears no tile: a 28px tile would push the
               name 12px right of the plan-usage and Settings labels. */
            className={cn(ROW, "h-11")}
          >
            <ServerIcon />
            <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
              <span className="block truncate text-[13px] font-medium leading-tight">{settings.name}</span>
              <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                {serverHost(settings.url)}
              </span>
            </span>
            <span className="text-sidebar-foreground/40 group-data-[collapsible=icon]:hidden">
              <ChevronDown className="size-3.5" />
            </span>
          </SidebarMenuButton>
        }
      />
      {/* Upward on the rail, downward on a phone — the same placement the
          usage popover above this row uses, for the same reason: on a desk
          the row is the last thing in the sidebar, on a phone its footer is
          mid-screen. */}
      <PopoverContent
        align="start"
        side={isMobile ? "bottom" : "top"}
        sideOffset={8}
        className={cn(GLASS_SURFACE, "w-[min(22rem,calc(100vw-1rem))] p-0")}
      >
        {/* `overflow-hidden` on the column, not the popup: the header rule,
            the rows' hover and the footer's ground would otherwise paint
            square corners over the card's rounded ones. */}
        <div className="flex max-h-[min(26rem,var(--panel-h,100svh))] flex-col overflow-hidden rounded-2xl">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
            <ServerIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] leading-5 font-semibold">Servers</p>
              <p className="text-[11px] leading-4 text-muted-foreground">
                {servers.length} {servers.length === 1 ? "server" : "servers"} known
              </p>
            </div>
          </div>
          {/* `py-1`, not `p-1`: the rows' own `px-3` is the card's 12px text
              edge — the same inset the header above and the usage card's list
              read at. A horizontal `p-1` put the rows 4px proud of both. */}
          <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {servers.map((server) => {
              const isActive = server.id === settings.id
              return (
                <button
                  key={server.id}
                  type="button"
                  disabled={isActive}
                  aria-current={isActive || undefined}
                  onClick={() => setActiveServer(server.id)}
                  className={cn(
                    "flex w-full cursor-default items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm outline-hidden select-none",
                    !isActive &&
                      "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                    isActive && "opacity-60"
                  )}
                >
                  <span className="grid size-6 shrink-0 place-items-center rounded-md bg-sidebar-accent/70">
                    <ServerIcon className="size-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm leading-tight">{server.name}</span>
                    <span className="block truncate font-mono text-[11px] leading-tight text-muted-foreground">
                      {serverHost(server.url)}
                    </span>
                  </span>
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
              onClick={handleAdd}
            >
              Add server…
              <Plus />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-between text-muted-foreground"
              onClick={handleManage}
            >
              Manage servers
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
