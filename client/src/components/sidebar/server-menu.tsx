/* ── The servers button ──
   The server this client is on, in the footer's row of icons. Clicking it
   switches servers — everything this device knows is one menu away, plus Add
   and Settings › General for the rest (rename, forget, teardown before
   disconnect). The name and the address are the button's tooltip now; the row
   it used to fill is gone, which is what made room for the icons beside it.
   It is the app's dropdown menu, like the spaces switcher beside it.
   Each row says when that server and this build cannot work together — read
   from its `/api/health` while the menu is open. Switching to one is still
   allowed; the gate on the other side explains it. */
import * as React from "react"
import { useQueries } from "@tanstack/react-query"
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
import { StatusBadge } from "@/components/settings/primitives"
import { useSidebar } from "@/components/ui/sidebar"
import { compatOf } from "@/lib/compat"
import { healthQuery } from "@/lib/queries"
import { settingsPath } from "@/lib/router"
import { loadServers, setActiveServer, type ServerSettings } from "@/lib/settings"
import { MENU_ROW, MENU_WIDTH, MenuRow } from "@/components/menu-row"
import { cn } from "@/lib/utils"
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

const COMPAT_LABEL = { "server-old": "Update server", "client-old": "Update app" } as const

/** The rows, a component of their own so the health reads live and die with
    the open menu (the popup unmounts on close) rather than polling from the
    footer. A server that does not answer draws no badge: unreachable is not
    incompatible. */
function ServerRows({ servers }: { servers: ServerSettings[] }) {
  const health = useQueries({
    queries: servers.map((server) => ({ ...healthQuery(server), retry: false })),
  })
  return servers.map((server, i) => {
    const data = health[i]?.data
    const compat = data ? compatOf(data) : "ok"
    return (
      // The address is the hint line, kept monospaced (MenuRow's hint is its
      // one `leading-4` span).
      <DropdownMenuRadioItem key={server.id} value={server.id} className={cn(MENU_ROW, "[&_span.leading-4]:font-mono")}>
        <MenuRow
          icon={<ServerIcon />}
          label={server.name}
          hint={serverHost(server.url)}
          trailing={compat !== "ok" ? <StatusBadge tone="warn">{COMPAT_LABEL[compat]}</StatusBadge> : undefined}
        />
      </DropdownMenuRadioItem>
    )
  })
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
      contentClassName={MENU_WIDTH}
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
          <ServerRows servers={servers} />
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={onAddServer} className={MENU_ROW}>
        <MenuRow icon={<Plus />} label="Add server…" />
      </DropdownMenuItem>
      <DropdownMenuItem onClick={handleManage} className={MENU_ROW}>
        <MenuRow icon={<ChevronRightIcon />} label="Manage servers" />
      </DropdownMenuItem>
        </>
      )}
    </FooterMenuButton>
  )
}
