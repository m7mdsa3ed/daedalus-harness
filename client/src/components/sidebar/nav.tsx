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
import { Shortcut } from "@/components/shortcut"
import { Badge } from "@/components/ui/badge"
import { useChord } from "@/lib/keybindings"
import { formatChord, type ShortcutId } from "@/lib/shortcuts"
import { automationsPath, boardPath } from "@/lib/router"
import { useLayoutOptions } from "@/lib/layout-options"
import { useAutomations } from "@/lib/queries/automations"

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
  /** The chord hint on hover. Absent where the row has no binding. */
  shortcut?: ShortcutId
  /** Right-click rows. An empty list adds no wrapper DOM (`ItemContextMenu`
      returns its child untouched), so every row can be wrapped alike. */
  menu?: MenuItemSpec[]
}

export function SidebarNav({ onNewThread }: { onNewThread?: () => void } = {}) {
  const location = useLocation()
  const navigate = useNavigate()
  const inBoard = location.pathname.startsWith("/board")
  const inAutomations = location.pathname.startsWith("/automations")
  // The list is loaded at boot (the palette and the page read the same query),
  // so the row can say how much is armed without asking again.
  const automationCount = useAutomations().data?.filter((a) => a.enabled).length ?? 0
  const newThreadChord = useChord("newThread") ?? ""
  const { sidebarShowPlaces } = useLayoutOptions()

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
      onClick: () => void navigate(automationsPath()),
    },
  ]
  /* The three places are the reader's to hide (Settings › Appearance ›
     Sidebar): they stay one palette search away. New tab always stays. */
  const shown = sidebarShowPlaces ? items : items.filter((item) => item.key === "new-thread")

  return (
    <SidebarGroup>
      <SidebarGroupContent>
        <SidebarMenu>
          {shown.map((item) => (
            <SidebarMenuItem key={item.key}>
              <ItemContextMenu items={item.menu ?? []}>
                <SidebarMenuButton
                  tooltip={item.tooltip}
                  isActive={item.isActive}
                  onClick={item.onClick}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.count !== undefined && <NavCount count={item.count} />}
                  {item.shortcut && <Kbd id={item.shortcut} />}
                </SidebarMenuButton>
              </ItemContextMenu>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
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
