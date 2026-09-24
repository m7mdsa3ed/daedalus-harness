/* ── Fixed nav ──
   The rows every screen of the app is one click from, above the list rather
   than in it. New thread is the first menu row; Search is the icon button
   beside the brand in the header (`app-shell.tsx`).

   Deliberately only the rows that start something. Plan usage used to sit here
   too, as a peak-percentage badge that polled `GET /api/quota` every ten
   minutes; it was taken out for that timer and for being the one row that
   worked rather than navigated. It is back, and below this nav rather than in
   it: `sidebar/usage.tsx`, in the footer beside the account row, reading the
   list route the Usage page already reads instead of a timer of its own. A nav
   row is a place you go; the plans are a reading, and they belong with the
   server's name. */
import * as React from "react"
import { Bot, CalendarClock, MessageSquarePlus, Repeat, SquareKanban } from "lucide-react"
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
import { useChord } from "@/lib/keybindings"
import { formatChord, type ShortcutId } from "@/lib/shortcuts"
import { agentsPath, boardPath, routinesPath, schedulesPath } from "@/lib/router"
import { useRoutines, useScheduled } from "@/lib/queries/routines"
import { GROUP, MENU, ROW } from "./scale"

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
  const inRoutines = location.pathname.startsWith("/routines")
  const inSchedules = location.pathname.startsWith("/schedules")
  // Both lists are loaded at boot (the palette and the pages read the same
  // queries), so the rows can say how much is armed without asking again.
  const routineCount = useRoutines().data?.length ?? 0
  const scheduledCount = useScheduled().data?.length ?? 0
  const newThreadChord = useChord("newThread") ?? ""

  const items: NavItem[] = [
    ...(onNewThread
      ? [
          {
            key: "new-thread",
            /* A square with a pen is "edit"; this is a new *conversation*, which
               is what the row starts. */
            icon: <MessageSquarePlus />,
            label: "New thread",
            tooltip: newThreadChord
              ? `New thread (${formatChord(newThreadChord)})`
              : "New thread",
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
    {
      key: "agents",
      icon: <Bot />,
      label: "Agents",
      tooltip: "Agents — every thread's live state",
      isActive: location.pathname.startsWith("/agents"),
      onClick: () => void navigate(agentsPath()),
    },
    /* Two pages for what happens with nobody watching. The labels are the
       feature: a routine starts a NEW thread on its own (a clock, a webhook, a
       commit) and answers the agent's questions itself; a scheduled message
       speaks into a thread that ALREADY EXISTS. They sit together because
       "routine" and "scheduled" are not words that tell themselves apart, and
       the count on each is how much is armed — the number you are asking about
       before you open it. */
    {
      key: "routines",
      /* A lightning bolt says "instant" — the opposite of a routine. Recurrence
         is what the row is: the same thing, on its own clock, again. */
      icon: <Repeat />,
      label: "Routines",
      tooltip: "Routines — threads that start on their own",
      isActive: inRoutines,
      count: routineCount,
      onClick: () => void navigate(routinesPath()),
    },
    {
      key: "scheduled",
      icon: <CalendarClock />,
      label: "Scheduled",
      tooltip: "Scheduled — messages sent into a thread later",
      isActive: inSchedules,
      count: scheduledCount,
      onClick: () => void navigate(schedulesPath()),
    },
  ]

  return (
    <SidebarGroup className={GROUP}>
      <SidebarGroupContent>
        <SidebarMenu className={MENU}>
          {items.map((item) => (
            <SidebarMenuItem key={item.key}>
              <ItemContextMenu items={item.menu ?? []}>
                <SidebarMenuButton
                  size="sm"
                  tooltip={item.tooltip}
                  isActive={item.isActive}
                  onClick={item.onClick}
                  className={ROW}
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
    <span className="ml-auto text-[10px] tabular-nums text-muted-foreground group-data-[collapsible=icon]:hidden">
      {count}
    </span>
  )
}

/** The chord, at the row's trailing edge, only while the row is hovered — a
    hint, not a label. Hidden in the icon rail, where the tooltip carries it. */
function Kbd({ id }: { id: ShortcutId }) {
  return (
    <Shortcut
      id={id}
      className="ml-auto hidden opacity-0 transition-opacity group-hover/menu-button:opacity-100 sm:inline-flex group-data-[collapsible=icon]:hidden"
      keyClassName="h-4 min-w-4 bg-transparent px-0.5 text-[10px] text-muted-foreground/70"
    />
  )
}
