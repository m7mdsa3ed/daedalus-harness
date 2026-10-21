/* ── Fixed nav ──
   The rows every screen of the app is one click from, above the list rather
   than in it. New thread is the first menu row; Search is the icon button
   beside the brand in the header (`app-shell.tsx`).

   Deliberately only the rows that start something. Plan usage is not here (nor
   anywhere in the sidebar): it lives on Settings › Usage. */
import * as React from "react"
import { MessageSquarePlus, Repeat, SquareKanban } from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { openInItems } from "@/components/open-in-menu"
import { startRouteDrag } from "@/lib/workspace/route-drag"
import { useIsMobile } from "@/hooks/use-device"
import { Shortcut } from "@/components/shortcut"
import { Badge } from "@/components/ui/badge"
import { useChord } from "@/lib/keybindings"
import { formatChord, type ShortcutId } from "@/lib/shortcuts"
import { automationsPath, boardPath } from "@/lib/router"
import { useLayoutOptions } from "@/lib/layout-options"
import { useAutomations, useUnreadAutomationRuns } from "@/lib/queries/automations"

/** One nav row. Data rather than four copies of the same JSX: every row is the
    same three primitives — a menu item, a button, an icon and a label — and
    the only thing that has ever differed between them is which optional piece
    it carries. Adding a row is one entry in the array below. */
interface NavItem {
  key: string
  icon: React.ReactNode
  label: string
  /** Also what the icon rail says, where the label is clipped away. */
  tooltip: string
  isActive?: boolean
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  /** The quiet trailing count. Absent where the row has nothing to count. */
  count?: number
  /** Something here finished and nobody has read it. Drawn beside the name
      rather than at the trailing edge, because it is a status of the row and
      not a second tally — the same place the Sessions label puts "needs you". */
  alert?: number
  /** The chord hint on hover. Absent where the row has no binding. */
  shortcut?: ShortcutId
  /** Right-click rows. An empty list adds no wrapper DOM (`ItemContextMenu`
      returns its child untouched), so every row can be wrapped alike. */
  menu?: MenuItemSpec[]
  /** The place the row stands for, when it is one: what its menu opens
      elsewhere and what a drag into the dock carries. Absent on a row that
      starts something instead ("New tab"), which has no place to be. */
  path?: string
}

export function SidebarNav({ onNewThread }: { onNewThread?: () => void } = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const inBoard = location.pathname.startsWith("/board")
  const inAutomations = location.pathname.startsWith("/automations")
  // The list is loaded at boot (the palette and the page read the same query),
  // so the row can say how much is armed without asking again.
  const automationCount = useAutomations().data?.filter((a) => a.enabled).length ?? 0
  /* The other half of that row: how many runs finished with nobody looking.
     An automation's whole point is that nobody is there, so this is the only
     place in the chrome that can tell you one has been. */
  const unreadRuns = useUnreadAutomationRuns().data?.count ?? 0
  const newThreadChord = useChord("newThread") ?? ""
  const { sidebarShowPlaces } = useLayoutOptions()
  /* A place row is clicked to go there in the tab in front; the menu is where
     the other two shapes are — a tab of its own, a column beside this one. A
     phone has no column to make, so that row is not offered (`open-in-menu`). */
  const isMobile = useIsMobile()

  const items: NavItem[] = [
    ...(onNewThread
      ? [
          {
            key: "new-thread",
            /* A square with a pen is "edit"; this is a new *conversation*, which
               is what the row starts. */
            icon: <MessageSquarePlus />,
            label: "New tab",
            tooltip: newThreadChord
              ? `New tab (${formatChord(newThreadChord)})`
              : "New tab",
            shortcut: "newThread" as ShortcutId,
            onClick: () => onNewThread(),
          } satisfies NavItem,
        ]
      : []),
    {
      key: "tasks",
      icon: <SquareKanban />,
      label: "Tasks",
      tooltip: "Tasks board",
      isActive: inBoard,
      onClick: () => void navigate(boardPath()),
      menu: openInItems(boardPath(), { beside: !isMobile }),
      path: boardPath(),
    },
    /* One page for what happens with nobody watching: a prompt that runs on a
       clock, a webhook or a commit, in a new thread each time or in one that
       already exists. The count is how much is armed — the number you are
       asking about before you open it. */
    {
      key: "automations",
      /* A lightning bolt says "instant" — the opposite of this. Recurrence is
         what the row is: the same thing, on its own clock, again. */
      icon: <Repeat />,
      label: "Automations",
      tooltip: "Automations — prompts that run on their own",
      isActive: inAutomations,
      count: automationCount,
      alert: unreadRuns,
      onClick: () => void navigate(automationsPath()),
      menu: openInItems(automationsPath(), { beside: !isMobile }),
      path: automationsPath(),
    },
  ]
  /* The three places are the reader's to hide (Settings › Appearance ›
     Sidebar): they stay one palette search away. New tab always stays. */
  const shown = sidebarShowPlaces ? items : items.filter((item) => item.key === "new-thread")

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {shown.map((item) => {
            const { path } = item
            /* A place dragged into the dock lands as a tab there, or as a column
               beside the group it is dropped on. Not on a phone, where the press
               is the long press that opens this menu. */
            const draggable = !!path && !isMobile
            return (
              <SidebarMenuItem key={item.key}>
                <ItemContextMenu items={item.menu ?? []}>
                  <SidebarMenuButton
                    tooltip={item.tooltip}
                    isActive={item.isActive}
                    onClick={item.onClick}
                    draggable={draggable}
                    onDragStart={
                      draggable && path ? (event) => startRouteDrag(event, path) : undefined
                    }
                  >
                    {item.icon}
                    <span>{item.label}</span>
                    {item.alert !== undefined && item.alert > 0 && <NavAlert count={item.alert} />}
                    {item.count !== undefined && <NavCount count={item.count} />}
                    {item.shortcut && <Kbd id={item.shortcut} />}
                  </SidebarMenuButton>
                </ItemContextMenu>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

/** News from a row whose page runs on its own: filled, because it is the one
    thing here addressed to the reader rather than describing the page. Hidden
    in the icon rail with the count, where the tooltip still carries "on". */
function NavAlert({ count }: { count: number }) {
  return (
    <Badge
      className="bg-primary/10 text-primary tabular-nums group-data-[collapsible=icon]:hidden"
      title={`${count} run${count === 1 ? "" : "s"} finished since you last looked`}
    >
      {count}
    </Badge>
  )
}

/** The quiet count a nav row carries when its page has something in it —
    hidden at zero (an empty page needs no number in front of it) and in the
    icon rail, where the icon is the whole row. */
function NavCount({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <Badge variant="secondary" className="ml-auto tabular-nums group-data-[collapsible=icon]:hidden">
      {count}
    </Badge>
  )
}

/** The chord, at the row's trailing edge, only while the row is hovered — a
    hint, not a label. Hidden in the icon rail, where the tooltip carries it. */
function Kbd({ id }: { id: ShortcutId }) {
  return (
    <Shortcut
      id={id}
      className="ml-auto hidden opacity-0 transition-opacity group-hover/menu-button:opacity-100 sm:inline-flex group-data-[collapsible=icon]:hidden"
    />
  )
}
