/* ── The inbox, drawn ──
   Two surfaces read the same list — the header's bell (a popover, the passing
   glance) and `/notifications` (the page, where the whole history is) — so the
   row is written once here rather than beside either of them: a notice that
   says one thing in the popover and another on the page is two inboxes.

   The row *is* the acknowledgement: opening it navigates to the thread and
   marks it read (`openNotification`), because a notice you have read is one
   you have acted on. The tick beside an unread row is the other half — "I saw
   this, and there is nothing to go and look at".

   Layout: a kind glyph in a tinted disc on the left (the dot it replaced said
   the kind only to someone who had learned four colours), then the thread's
   name with the age on the same baseline, the body under it, and — on the page
   — the kind spelled out as a small caption. Unread is said three ways that
   agree: a tinted glyph, a bolder title, and a dot on the age. Read rows keep
   the layout and lose the colour, so the eye lands on what is new. */
import {
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  MessageCircleQuestionIcon,
  ShieldAlertIcon,
  type LucideIcon,
} from "lucide-react"

import type { AppNotification } from "@/lib/notifications-inbox"
import { useMarkNotificationsRead, useOpenNotification } from "@/lib/queries/surfaces"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"

export const KIND_META: Record<
  AppNotification["kind"],
  {
    label: string
    /** Read as a request: something the agent is waiting on. */
    needsYou: boolean
    icon: LucideIcon
    /** The unread disc: tint + foreground. */
    tone: string
    /** The dot on the age, and the accent bar. */
    dot: string
  }
> = {
  permission: {
    label: "Permission needed",
    needsYou: true,
    icon: ShieldAlertIcon,
    tone: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  question: {
    label: "Question asked",
    needsYou: true,
    icon: MessageCircleQuestionIcon,
    tone: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
  },
  turn_finished: {
    label: "Turn finished",
    needsYou: false,
    icon: CircleCheckIcon,
    tone: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  turn_failed: {
    label: "Turn failed",
    needsYou: false,
    icon: CircleXIcon,
    tone: "bg-destructive/15 text-destructive",
    dot: "bg-destructive",
  },
}

/** The count capsule — one of the app's genuine capsules, so `rounded-pill`.
    Neutral ink, not destructive red: the badge sits on the header's glass and
    reads as a count, not as an alarm. */
export function UnreadCount({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        "grid h-[18px] min-w-[18px] place-items-center rounded-pill bg-foreground px-1.5 text-[10px] leading-none font-semibold text-background tabular-nums",
        className
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}

/** The kind's glyph in its disc. Read rows are drawn in the muted tone so the
    unread ones carry the colour. */
export function KindGlyph({
  kind,
  read,
  className,
}: {
  kind: AppNotification["kind"]
  read: boolean
  className?: string
}) {
  const meta = KIND_META[kind]
  const Icon = meta.icon
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full transition-colors",
        read ? "bg-muted text-muted-foreground/70" : meta.tone,
        className
      )}
    >
      <Icon className="size-[55%]" strokeWidth={2} />
    </span>
  )
}

const exactStamp = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

/**
 * One notice.
 *
 * `detailed` is the page's face: room for the body to wrap and for the kind
 * to be spelled out under it. The popover keeps the body to one line and lets
 * the glyph say the kind.
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
  const title = n.threadTitle ?? meta.label
  const body = n.body ?? (n.threadTitle ? meta.label : null)

  return (
    <div
      className={cn(
        "group/notice relative flex w-full items-start gap-3 transition-colors hover:bg-accent/50 has-[[data-open]:focus-visible]:bg-accent/50",
        detailed ? "px-4 py-3.5" : "px-3 py-2.5",
        !n.read && "bg-primary/[0.04]"
      )}
    >
      <KindGlyph
        kind={n.kind}
        read={n.read}
        className={cn(detailed ? "mt-0.5 size-8" : "size-7")}
      />

      {/* The whole row is one target; the button is the text so a screen reader
          hears the notice and not the housekeeping beside it. `after:` stretches
          its hit area over the row without nesting a button inside a button. */}
      <button
        type="button"
        data-open
        onClick={() => open(n)}
        className="min-w-0 flex-1 text-left focus-visible:outline-none after:absolute after:inset-0 after:content-['']"
      >
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13px] leading-5",
              n.read ? "font-normal text-foreground/90" : "font-semibold text-foreground"
            )}
          >
            {title}
          </span>
          <span
            className="flex shrink-0 items-center gap-1.5 text-[11px] leading-5 tabular-nums text-muted-foreground"
            title={exactStamp(n.createdAt)}
          >
            {shortAge(n.createdAt)}
            {!n.read && <span aria-hidden className={cn("size-1.5 rounded-full", meta.dot)} />}
          </span>
        </span>
        {body && (
          <span
            className={cn(
              "mt-0.5 block text-xs leading-[1.4] text-muted-foreground",
              detailed ? "line-clamp-3 text-pretty" : "truncate"
            )}
          >
            {body}
          </span>
        )}
        {detailed && n.threadTitle && (
          <span className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground/80">
            <span aria-hidden className={cn("size-1.5 rounded-full", n.read ? "bg-muted-foreground/40" : meta.dot)} />
            {meta.label}
          </span>
        )}
      </button>

      {!n.read && (
        /* Above the row's stretched hit area (`relative` + z), and a real
           button, since it is no longer inside one. Revealed on hover and on
           keyboard focus; always shown where there is no hover to reveal it. */
        <button
          type="button"
          aria-label="Mark read"
          title="Mark read"
          onClick={() => markRead.mutate(n.id)}
          className={cn(
            "relative z-10 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-[color,background-color,opacity] hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/notice:opacity-100",
            detailed ? "mt-0.5" : ""
          )}
        >
          <CheckIcon className="size-3.5" />
        </button>
      )}
    </div>
  )
}
