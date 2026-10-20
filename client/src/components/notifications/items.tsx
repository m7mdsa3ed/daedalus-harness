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
   agree: a tinted glyph, the row's tint and start bar, and a dot on the age. Read rows keep
   the layout and lose the colour, so the eye lands on what is new. */
import {
  CheckIcon,
  CircleCheckIcon,
  CircleXIcon,
  ArrowUpRightIcon,
  MessageCircleQuestionIcon,
  ShieldAlertIcon,
  type LucideIcon,
} from "lucide-react"

import type { AppNotification } from "@/lib/notifications-inbox"
import { useMarkNotificationsRead, useOpenNotification } from "@/lib/queries/surfaces"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"
import { StatusBadge, type StatusTone } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"

export const KIND_META: Record<
  AppNotification["kind"],
  {
    label: string
    /** Read as a request: something the agent is waiting on. */
    needsYou: boolean
    icon: LucideIcon
    /** The state it is said in (StatusBadge). */
    tone: StatusTone
  }
> = {
  permission: {
    label: "Permission needed",
    needsYou: true,
    icon: ShieldAlertIcon,
    tone: "warn",
  },
  question: {
    label: "Question asked",
    needsYou: true,
    icon: MessageCircleQuestionIcon,
    tone: "info",
  },
  turn_finished: {
    label: "Turn finished",
    needsYou: false,
    icon: CircleCheckIcon,
    tone: "ok",
  },
  turn_failed: {
    label: "Turn failed",
    needsYou: false,
    icon: CircleXIcon,
    tone: "bad",
  },
}

/** The count capsule — one of the app's genuine capsules, so `rounded-pill`.
    Neutral ink, not destructive red: the badge sits on the header's glass and
    reads as a count, not as an alarm. */
export function UnreadCount({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        "grid h-4 min-w-4 place-items-center rounded-pill bg-foreground px-1 text-[10px] leading-none font-semibold text-background tabular-nums",
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
  const Icon = KIND_META[kind].icon
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-full transition-colors",
        read ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
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
    <article
      className={cn(
        "group/notice relative flex min-h-12 w-full items-start gap-3 px-3 py-3 transition-colors hover:bg-muted/50 has-[[data-open]:focus-visible]:bg-muted/50 @panel-sm:px-4",
        /* Unread is the selected-row look every list uses: a tint and a bar
           at the start edge. */
        "before:pointer-events-none before:absolute before:inset-y-0 before:start-0 before:w-0.5 before:bg-primary before:opacity-0",
        !n.read && "bg-primary/5 before:opacity-100"
      )}
    >
      <KindGlyph
        kind={n.kind}
        read={n.read}
        className={cn(detailed ? "mt-0.5 size-8" : "size-7")}
      />

      <button
        type="button"
        data-open
        onClick={() => open(n)}
        className="min-w-0 flex-1 self-stretch text-left focus-visible:outline-none"
      >
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
          <span
            className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted-foreground"
            title={exactStamp(n.createdAt)}
          >
            {shortAge(n.createdAt)}
            {!n.read && <span aria-hidden className="size-1.5 rounded-full bg-primary" />}
          </span>
        </span>
        {body && (
          <span
            className={cn(
              "mt-0.5 block text-xs text-muted-foreground",
              detailed ? "line-clamp-3 text-pretty" : "truncate"
            )}
          >
            {body}
          </span>
        )}
        {detailed && n.threadTitle && (
          <span className="mt-1.5 flex">
            <StatusBadge tone={n.read ? "neutral" : meta.tone}>{meta.label}</StatusBadge>
          </span>
        )}
      </button>

      <div className={cn("relative z-10 flex shrink-0 items-center gap-1", detailed ? "self-center" : "self-start")}>
        <Button
          type="button"
          variant={detailed ? "outline" : "ghost"}
          size={detailed ? "xs" : "icon-xs"}
          aria-label="Visit thread"
          title="Visit thread"
          onClick={() => open(n)}
          className="text-muted-foreground"
        >
          {detailed && <span>Visit thread</span>}
          <ArrowUpRightIcon data-icon={detailed ? "inline-end" : undefined} />
        </Button>

        {!n.read && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Mark read"
            title="Mark read"
            onClick={() => markRead.mutate(n.id)}
            className="text-muted-foreground"
          >
            <CheckIcon />
          </Button>
        )}
      </div>
    </article>
  )
}
