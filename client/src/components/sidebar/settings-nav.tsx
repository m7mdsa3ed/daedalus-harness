/* ── The settings nav, in the app sidebar ──
   The section list is the app sidebar's content while the panel in front of
   you is a settings page, and the thread list is its content otherwise.

   ── Why this is safe now, and was not before ──
   This nav lived here once, keyed on `location.pathname.startsWith("/settings")`,
   and broke when settings became a page tab like any other: the sidebar
   followed the *route*, so a settings tab open beside a chat rewrote the
   sidebar of the chat you were reading. The rule that fixed it is not "put the
   nav in the page" — it is **the URL is written by the focused panel**
   (`dock.tsx`'s `onDidActivePanelChange`, which navigates to the active chat's
   or page's path). Focusing the chat writes the chat's path; focusing the
   settings tab writes the settings path. So the route *is* the active panel's
   descriptor, and reading it here asks the question the old code only looked
   like it was asking. Focusing a terminal or an editor navigates nowhere, which
   is right: those are not places, and the sidebar should not change under them.

   One nav, the app's own parts and the app's own spacing scale — not a second
   sidebar with its own row height and accent. The icon rail carries it too:
   unlike the page-local rail this used to be, `SidebarMenuButton`'s `tooltip`
   asks `useSidebar()` and gets *this* sidebar's state, so the collapsed form
   is twenty labelled icons rather than twenty blank rows. */
import { ArrowLeft } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_OVERVIEW,
  sectionMeta,
  sectionOf,
  type SettingsSectionId,
} from "@/components/settings/sections"
import { ItemContextMenu } from "@/components/item-context-menu"
import { openInItems } from "@/components/open-in-menu"
import { startRouteDrag } from "@/lib/workspace/route-drag"
import { settingsPath, settingsRootPath } from "@/lib/router"

/** Is the panel in front of you a settings page? See the header: the dock
    writes the focused panel's path to the URL, so this is a reading of the
    active panel and not of "somewhere a settings tab exists". */
export const inSettingsPanel = (pathname: string) => pathname.startsWith("/settings")

/** Which section — a sub-route (`mcp/import`, a form) lights its section's
    row, because it *is* that section. `null` is the overview. */
export const settingsSectionFor = (pathname: string) =>
  sectionOf(pathname.split("/")[2] ?? "")

export function SettingsNav({ onBack }: { onBack: () => void }) {
  const location = useLocation()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const section = settingsSectionFor(location.pathname)

  const go = (path: string) => {
    if (isMobile) setOpenMobile(false)
    void navigate(path)
  }

  /* A section row navigates the tab in front (that is what a page tab is), so
     the other two shapes — a tab of its own, a column beside this one — are in
     its menu. A phone makes no column, so that row is left out there. */
  const row = (
    id: SettingsSectionId | null,
    label: string,
    Icon: (typeof SETTINGS_OVERVIEW)["icon"]
  ) => {
    const path = id ? settingsPath(id) : settingsRootPath()
    /* A section can be dragged into the dock as well as clicked into the tab in
       front: same payload as a thread's row, same landing (`dock-drop.tsx`). */
    const draggable = !isMobile
    return (
      <SidebarMenuItem key={id ?? "overview"}>
        <ItemContextMenu items={openInItems(path, { beside: !isMobile })}>
          <SidebarMenuButton
            tooltip={label}
            isActive={id === section}
            onClick={() => go(path)}
            draggable={draggable}
            onDragStart={draggable ? (event) => startRouteDrag(event, path) : undefined}
          >
            <Icon />
            <span>{label}</span>
          </SidebarMenuButton>
        </ItemContextMenu>
      </SidebarMenuItem>
    )
  }

  return (
    <>
      <SidebarGroup className="border-b border-sidebar-border">
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                className="text-muted-foreground"
                tooltip="Back to threads"
                onClick={onBack}
              >
                <ArrowLeft />
                <span>Back to threads</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {row(null, SETTINGS_OVERVIEW.label, SETTINGS_OVERVIEW.icon)}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain group-data-[collapsible=icon]:overflow-hidden">
        {SETTINGS_NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>
              <span className="truncate">{group.label}</span>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.sections.map((id) => {
                  const meta = sectionMeta(id)
                  return row(id, meta.label, meta.icon)
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </div>
    </>
  )
}
