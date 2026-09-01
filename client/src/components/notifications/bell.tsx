/* ── The bell, in the app header ──
   It sat on the sidebar's fixed nav, which is a column of places you *go*; a
   count capsule is not a place, and in the collapsed icon rail the capsule had
   to be flung into the row's corner to survive at all. The header is where a
   badge belongs — one target, always visible, on every route — so that is
   where it is now, beside the thread's own ⋯ menu.

   The sidebar keeps a row, and it navigates: `/notifications` is the whole
   history, and this popover is the glance. Fetched on open and on return to
   the window, never on a timer (see lib/notifications-inbox). */
import * as React from "react"
import { BellIcon, CheckIcon, ListIcon } from "lucide-react"
import { useNavigate } from "react-router"

import { NotificationRow, UnreadCount } from "@/components/notifications/items"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  useInbox,
  useMarkNotificationsRead,
} from "@/lib/queries/surfaces"
import { notificationsPath } from "@/lib/router"

export function NotificationBell() {
  /* The query cache owns the read: the badge fetches on mount, opening
     re-fetches, and returning to the window re-fetches via focus — the three
     moments the old module store asked for by hand. */
  const { inbox, refetch } = useInbox()
  const markRead = useMarkNotificationsRead()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)

  const unread = inbox?.unread ?? 0

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
            {unread > 0 && <UnreadCount count={unread} className="absolute top-0 right-0" />}
          </Button>
        }
      />
      <PopoverContent align="end" side="bottom" sideOffset={8} className="w-80 p-0">
        <div className="flex max-h-[min(24rem,var(--panel-h,100svh))] flex-col">
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            <p className="text-sm font-medium">Notifications</p>
            {unread > 0 && (
              <span className="rounded-pill bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                {unread} unread
              </span>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {(inbox?.items.length ?? 0) === 0 ? (
              <div className="grid min-h-28 place-items-center px-4 py-6 text-center text-xs text-muted-foreground">
                {inbox ? "Nothing here yet." : "Loading…"}
              </div>
            ) : (
              <ul className="divide-y">
                {inbox!.items.map((n) => (
                  <li key={n.id}>
                    <NotificationRow notification={n} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Clearing the inbox is housekeeping, and it lives on the page: a
              destructive button under a list you opened for a glance is one
              press away from taking the history with it. */}
          <div className="flex items-center gap-1 border-t px-2 py-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground"
              disabled={unread === 0}
              onClick={() => markRead.mutate(undefined)}
            >
              <CheckIcon className="size-3.5" /> Mark all read
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 gap-1 text-xs text-muted-foreground"
              onClick={() => {
                setOpen(false)
                void navigate(notificationsPath())
              }}
            >
              <ListIcon className="size-3.5" /> All notifications
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
