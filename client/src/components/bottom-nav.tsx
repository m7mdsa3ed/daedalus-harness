/* ── The phone's bottom bar ──
   A phone is for attention, not deep work: the five things reached for with a
   thumb — the thread list, the agents, a new thread, what is waiting on you,
   settings — in the one place a thumb reaches. Drawn by the shell only when
   `useIsMobile()` (the device), never on a narrow panel.

   It is **in flow**, the last row of the shell's column, not a fixed overlay:
   the dock above it simply ends where it starts, so every surface anchored to
   the bottom of a panel — the composer, the terminal's key row — sits above
   it with no offset to keep in sync. It owns the home-indicator inset, and
   while it is drawn `data-bottom-nav` on the root zeroes `--safe-bottom`, so
   nothing above it pads for that inset a second time.

   **It is not drawn while the soft keyboard is open.** The keyboard covers the
   bottom of the page (`overlays-content`), and the composer rides it by its
   own lift (`KEYBOARD_LIFT`); a bar still in flow would sit between the two
   and push the composer up by its own height. Removing it is what lets the
   composer land exactly on the keys. */
import * as React from "react"
import { BotIcon, InboxIcon, MessagesSquareIcon, PlusIcon, SettingsIcon, type LucideIcon } from "lucide-react"
import { useLocation, useNavigate } from "react-router"

import { UnreadCount } from "@/components/notifications/items"
import { useSidebar } from "@/components/ui/sidebar"
import { useKeyboardInset } from "@/hooks/use-keyboard-inset"
import { usePending } from "@/lib/queries/pending"
import { useInbox } from "@/lib/queries/surfaces"
import { notificationsPath, settingsRootPath } from "@/lib/router"
import { cn } from "@/lib/utils"

export function BottomNav({ onNewThread }: { onNewThread: () => void }) {
  const keyboard = useKeyboardInset()
  const shown = keyboard === 0

  React.useEffect(() => {
    if (!shown) return
    document.documentElement.setAttribute("data-bottom-nav", "")
    return () => document.documentElement.removeAttribute("data-bottom-nav")
  }, [shown])

  if (!shown) return null
  return <Bar onNewThread={onNewThread} />
}

function Bar({ onNewThread }: { onNewThread: () => void }) {
  const { openMobile, setOpenMobile } = useSidebar()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const pending = usePending().data?.length ?? 0
  const unread = useInbox().inbox?.unread ?? 0
  const at = (prefix: string) => !openMobile && pathname.startsWith(prefix)

  return (
    <nav
      aria-label="Main"
      className="grid shrink-0 grid-cols-5 px-1 pb-[env(safe-area-inset-bottom,0px)]"
    >
      <Item
        icon={MessagesSquareIcon}
        label="Threads"
        active={openMobile || pathname === "/" || pathname.startsWith("/t/")}
        onClick={() => setOpenMobile(true)}
      />
      <Item icon={BotIcon} label="Agents" active={at("/agents")} onClick={() => void navigate("/agents")} />
      <Item icon={PlusIcon} label="New" onClick={onNewThread} />
      <Item
        icon={InboxIcon}
        label="Inbox"
        active={at(notificationsPath())}
        onClick={() => void navigate(notificationsPath())}
        badge={
          /* What is waiting on you outranks what you have not read: a blocked
             agent is the one thing on this bar that costs time while unseen. */
          pending > 0 ? (
            <UnreadCount count={pending} className="bg-amber-500 text-white" />
          ) : unread > 0 ? (
            <UnreadCount count={unread} />
          ) : null
        }
        ariaCount={pending > 0 ? `${pending} waiting on you` : unread > 0 ? `${unread} unread` : undefined}
      />
      <Item
        icon={SettingsIcon}
        label="Settings"
        active={at(settingsRootPath())}
        onClick={() => void navigate(settingsRootPath())}
      />
    </nav>
  )
}

function Item({
  icon: Icon,
  label,
  active = false,
  onClick,
  badge,
  ariaCount,
}: {
  icon: LucideIcon
  label: string
  active?: boolean
  onClick: () => void
  badge?: React.ReactNode
  ariaCount?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-label={ariaCount ? `${label} (${ariaCount})` : label}
      className={cn(
        "flex h-12 flex-col items-center justify-center gap-0.5 rounded-lg text-[10px] leading-none font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        active ? "text-foreground" : "text-muted-foreground active:text-foreground"
      )}
    >
      <span className="relative">
        <Icon className="size-5" strokeWidth={active ? 2.25 : 1.75} />
        {badge && <span className="absolute -top-1.5 left-3">{badge}</span>}
      </span>
      {label}
    </button>
  )
}
