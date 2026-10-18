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
import { settingsPath, settingsRootPath } from "@/lib/router"
import { focusOpenChat, lastActiveChatId, leavePage, useOpenThreads } from "@/lib/workspace/open-threads"
import { cn } from "@/lib/utils"
import { GROUP, GROUP_LABEL, MENU, ROW, TIER } from "./scale"

/** Is the panel in front of you a settings page? See the header: the dock
    writes the focused panel's path to the URL, so this is a reading of the
    active panel and not of "somewhere a settings tab exists". */
export const inSettingsPanel = (pathname: string) => pathname.startsWith("/settings")

/** Which section — a sub-route (`mcp/import`, a form) lights its section's
    row, because it *is* that section. `null` is the overview. */
export const settingsSectionFor = (pathname: string) =>
  sectionOf(pathname.split("/")[2] ?? "")

export function SettingsNav() {
  const location = useLocation()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const section = settingsSectionFor(location.pathname)
  /* Leaving settings goes back to the thread you were last reading, else the
     landing console — the same "/" the dock lands on when the last tab closes.
     A Back row rather than closing the tab: the sidebar cannot close a panel
     it is not inside, and on a phone there is no tab strip to close it from. */
  const lastThread = useOpenThreads().at(-1)

  const go = (path: string) => {
    if (isMobile) setOpenMobile(false)
    void navigate(path)
  }

  const row = (
    id: SettingsSectionId | null,
    label: string,
    Icon: (typeof SETTINGS_OVERVIEW)["icon"]
  ) => (
    <SidebarMenuItem key={id ?? "overview"}>
      <SidebarMenuButton
        size="sm"
        className={ROW}
        tooltip={label}
        isActive={id === section}
        onClick={() => go(id ? settingsPath(id) : settingsRootPath())}
      >
        <Icon />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )

  return (
    <>
      <SidebarGroup className={cn(TIER, GROUP, "border-b border-sidebar-border pb-3")}>
        <SidebarGroupContent>
          <SidebarMenu className={MENU}>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                className={cn(ROW, "text-muted-foreground")}
                tooltip="Back to threads"
                onClick={() => {
                  /* This tab goes back to what it was showing before settings
                     took its place. Failing that, the tab that already holds
                     the thread you were last reading comes to the front, else the
                     last one opened; with none open this tab
                     goes back to the New tab page. Navigating instead would
                     turn this settings tab into a second copy of the thread. */
                  if (isMobile) setOpenMobile(false)
                  if (leavePage()) return
                  const reading = lastActiveChatId()
                  if (reading && focusOpenChat(reading)) return
                  if (lastThread && focusOpenChat(lastThread)) return
                  void navigate("/")
                }}
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
          <SidebarGroup key={group.label} className={cn(TIER, GROUP)}>
            <SidebarGroupLabel className={GROUP_LABEL}>
              <span className="truncate">{group.label}</span>
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className={MENU}>
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
