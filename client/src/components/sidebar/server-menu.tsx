/* ── The "account" row ──
   How both desktop apps end their sidebar: the server this client is on, name
   over address. Clicking it switches servers — everything this device knows
   is one menu away, plus Add and Settings › General for the rest (rename,
   forget, teardown before disconnect). */
import * as React from "react"
import { Check, ChevronDown, ServerIcon, Settings2 } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { settingsPath } from "@/lib/router"
import { loadServers, setActiveServer, type ServerSettings } from "@/lib/settings"

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
  /* The servers this device knows. Unlike everything else this comes from
     localStorage, not the store, and it only changes on Add/switch — both of
     which hard-reload the app — so reading it once per mount is enough. */
  const servers = React.useMemo(loadServers, [])

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <SidebarMenuButton
            size="lg"
            tooltip={`${settings.name} · ${settings.url}`}
            isActive={location.pathname === settingsPath("general")}
            className="h-11 px-2"
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-sidebar-accent text-sidebar-foreground/80">
              <ServerIcon className="size-4" />
            </span>
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
      {/* Solid, not glass: this is the one menu in the app that opens over
          the sidebar rather than out across the main pane, and frosted glass
          over another glass surface has nothing to reveal — see index.css. */}
      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-64" data-surface="solid">
        {/* The known servers, active one ticked at the top; switching is a
            state change (see App.tsx), which re-mounts the tree against the
            newly-active connection.

            Each label is Base UI's Menu.GroupLabel: it reads its group from
            context and throws outside one, so it sits inside the group it
            heads rather than loose in the content. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block text-xs">Servers</span>
          </DropdownMenuLabel>
          {servers.map((server) => {
            const isActive = server.id === settings.id
            return (
              <DropdownMenuItem
                key={server.id}
                disabled={isActive}
                onClick={() => setActiveServer(server.id)}
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
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block text-[11px]">Manage</span>
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={onAddServer}>
            <Settings2 className="size-4" />
            <span className="min-w-0 flex-1">Add server…</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void navigate(settingsPath("general"))}>
            <Settings2 className="size-4" />
            <span className="min-w-0 flex-1">Manage servers</span>
            <span className="ml-auto text-xs text-muted-foreground">{settingsPath("general")}</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
