/* ── The inbox, drawn ──
   Two surfaces read the same list — the header's bell (a popover, the passing
   glance) and `/notifications` (the page, where the whole history is) — so the
   row is written once here rather than beside either of them: a notice that
   says one thing in the popover and another on the page is two inboxes.

   The row *is* the acknowledgement: opening it navigates to the thread and
   marks it read (`openNotification`), because a notice you have read is one
   you have acted on. The tick beside an unread row is the other half — "I saw
   this, and there is nothing to go and look at". */
import { CheckIcon } from "lucide-react"

import type { AppNotification } from "@/lib/notifications-inbox"
import { useMarkNotificationsRead, useOpenNotification } from "@/lib/queries/surfaces"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"

export const KIND_META: Record<AppNotification["kind"], { label: string; dot: string }> = {
  permission: { label: "Permission needed", dot: "bg-amber-500" },
  question: { label: "The agent has a question", dot: "bg-sky-500" },
  turn_finished: { label: "Turn finished", dot: "bg-emerald-500" },
  turn_failed: { label: "Turn failed", dot: "bg-destructive" },
}

/** The count capsule — one of the app's genuine capsules, so `rounded-pill`. */
export function UnreadCount({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        "grid h-4 min-w-4 place-items-center rounded-pill bg-destructive px-1 text-[9px] leading-none font-semibold text-white tabular-nums",
        className
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}

/**
 * One notice.
 *
 * `detailed` is the page's face: it prints the kind as well as the thread's
 * name, which the popover leaves out — there the title and the body are what
 * fit, and the coloured dot already says the kind to anyone who reads it twice.
 */
export function NotificationRow({
  notification: n,
  detailed = false,
}: {
  notification: AppNotification
  detailed?: boolean
}) {
  const open = useOpenNotification()
  const markRead = useMarkNotificationsRead()
  const meta = KIND_META[n.kind]
  return (
    <button
      type="button"
      onClick={() => open(n)}
      className={cn(
        "flex w-full items-start gap-2.5 px-3 text-left transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        detailed ? "py-3 sm:px-4" : "py-2.5",
        !n.read && "bg-muted/40"
      )}
    >
      <span
        aria-hidden
        className={cn(
          "mt-1.5 size-2 shrink-0 rounded-full",
          n.read ? "bg-muted-foreground/40" : meta.dot
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-medium">{n.threadTitle ?? meta.label}</span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {shortAge(n.createdAt)}
          </span>
        </span>
        <span
          className={cn(
            "block text-xs text-muted-foreground",
            detailed ? "text-pretty" : "truncate"
          )}
        >
          {n.body ?? meta.label}
        </span>
        {detailed && n.threadTitle && (
          <span className="mt-1 block text-[11px] text-muted-foreground/80">{meta.label}</span>
        )}
      </span>
      {!n.read && (
        /* A span, not a button: the row is already one, and a button inside a
           button is markup no browser agrees on. */
        <span
          role="button"
          tabIndex={-1}
          aria-label="Mark read"
          onClick={(e) => {
            e.stopPropagation()
            markRead.mutate(n.id)
          }}
          className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <CheckIcon className="size-3.5" />
        </span>
      )}
    </button>
  )
}
