/* ── The servers button ──
   The server this client is on, in the footer's row of icons. Clicking it
   switches servers — everything this device knows is one menu away, plus Add
   and Settings › General for the rest (rename, forget, teardown before
   disconnect). The name and the address are the button's tooltip now; the row
   it used to fill is gone, which is what made room for the icons beside it.
   It is the app's dropdown menu, like the spaces switcher beside it. */
import * as React from "react"
import { ChevronRightIcon, Plus, ServerIcon } from "lucide-react"
import { useNavigate } from "react-router"
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { useSidebar } from "@/components/ui/sidebar"
import { settingsPath } from "@/lib/router"
import { loadServers, setActiveServer, type ServerSettings } from "@/lib/settings"
import { FooterMenuButton } from "./footer-menu"

/** The address without its scheme — what identifies a server in a tooltip or a
    row of a menu, where there is no room for the whole URL. */
function serverHost(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname !== "/" ? u.pathname.replace(/\/$/, "") : "")
  } catch {
    return url
  }
}

export function ServerIconButton({
  settings,
  onAddServer,
}: {
  settings: ServerSettings
  onAddServer: () => void
}) {
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  /* From localStorage, not the store: re-read when the active server's identity
     (id, name, url) changes, which is when the list can have changed. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const servers = React.useMemo(loadServers, [settings.id, settings.name, settings.url])

  const handleManage = () => {
    if (isMobile) setOpenMobile(false)
    void navigate(settingsPath("general"))
  }

  return (
    <FooterMenuButton
      title={`${settings.name} · ${serverHost(settings.url)}`}
      icon={<ServerIcon />}
      contentClassName="w-64"
    >
      {() => (
        <>
      {/* GroupLabel throws outside a group, so the label rides inside one. */}
      <DropdownMenuGroup>
        <DropdownMenuLabel>Servers</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={settings.id}
          onValueChange={(next) => next && next !== settings.id && setActiveServer(next)}
        >
          {servers.map((server) => (
            <DropdownMenuRadioItem key={server.id} value={server.id}>
              <ServerIcon />
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{server.name}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {serverHost(server.url)}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onAddServer}>
        <Plus />
        Add server…
      </DropdownMenuItem>
      <DropdownMenuItem onClick={handleManage}>
        <ChevronRightIcon />
        Manage servers
      </DropdownMenuItem>
        </>
      )}
    </FooterMenuButton>
  )
}
