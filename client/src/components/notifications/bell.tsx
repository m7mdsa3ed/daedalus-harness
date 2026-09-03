/* ── The bell, in the app header ──
   It sat on the sidebar's fixed nav, which is a column of places you *go*; a
   count capsule is not a place, and in the collapsed icon rail the capsule had
   to be flung into the row's corner to survive at all. The header is where a
   badge belongs — one target, always visible, on every route — so that is
   where it is now, beside the thread's own ⋯ menu.

   The sidebar keeps a row, and it navigates: `/notifications` is the whole
   history, and this popover is the glance — the newest handful, unread first
   in the sense that they are the coloured ones, and one line to the page for
   the rest. Fetched on open and on return to the window, never on a timer
   (see lib/notifications-inbox). */
import * as React from "react"
import { BellIcon, CheckCheckIcon, ChevronRightIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { NotificationRow, UnreadCount } from "@/components/notifications/items"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  useInbox,
  useMarkNotificationsRead,
} from "@/lib/queries/surfaces"
import { notificationsPath } from "@/lib/router"

/** The glance is the newest few; the page is the rest. */
const GLANCE = 8

export function NotificationBell() {
  /* The query cache owns the read: the badge fetches on mount, opening
     re-fetches, and returning to the window re-fetches via focus — the three
     moments the old module store asked for by hand. */
  const { inbox, refetch } = useInbox()
  const markRead = useMarkNotificationsRead()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)

  const unread = inbox?.unread ?? 0
  const items = inbox?.items ?? []
  const shown = items.slice(0, GLANCE)
  const rest = items.length - shown.length

  const goToAll = () => {
    setOpen(false)
    void navigate(notificationsPath())
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) refetch()
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
            title="Notifications"
          >
            <BellIcon />
            {unread > 0 && <UnreadCount count={unread} className="absolute -top-1 -right-1" />}
          </Button>
        }
      />
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-[min(24rem,calc(100vw-1rem))] p-0"
      >
        <div className="flex max-h-[min(28rem,var(--panel-h,100svh))] flex-col">
          {/* Header: the title, the unread count as a plain phrase, and the
              one action that belongs with a glance. */}
          <div className="flex items-center gap-2 border-b px-3.5 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-5">Notifications</p>
              <p className="text-[11px] leading-4 text-muted-foreground tabular-nums">
                {!inbox
                  ? "Loading…"
                  : items.length === 0
                    ? "Nothing recorded"
                    : unread > 0
                      ? `${unread} unread`
                      : "All read"}
              </p>
            </div>
            {unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                onClick={() => markRead.mutate(undefined)}
                title="Mark all read"
              >
                <CheckCheckIcon className="size-3.5" /> Mark all read
              </Button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {shown.length === 0 ? (
              <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 py-8 text-center">
                <BellIcon className="size-5 text-muted-foreground/50" />
                <p className="text-xs text-muted-foreground">
                  {inbox ? "You're all caught up." : "Loading…"}
                </p>
              </div>
            ) : (
              <ul className="divide-y">
                {shown.map((n) => (
                  <li key={n.id}>
                    <NotificationRow notification={n} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Clearing the inbox is housekeeping, and it lives on the page: a
              destructive button under a list you opened for a glance is one
              press away from taking the history with it. The footer is one
              line to the page, and says how much is waiting there. */}
          <button
            type="button"
            onClick={goToAll}
            className="flex items-center justify-between gap-2 border-t px-3.5 py-2.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span>{rest > 0 ? `${rest} more in the inbox` : "All notifications"}</span>
            <ChevronRightIcon className="size-3.5" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
