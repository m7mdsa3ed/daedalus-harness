/* ── Enable-notifications offer ──
   Until the browser has been asked for notification permission (or the user
   waves it off), this REPLACES the header's title row rather than sitting as a
   card above the composer. The header is the one strip that is always on
   screen and never scrolls, and the offer is temporary by construction — it
   answers itself the moment it is acted on — so borrowing that row costs
   nothing permanent and leaves the transcript and composer untouched.

   The ask itself must ride a click — setupPush never prompts — and once
   granted the same click registers this device for FCM push, so "enable"
   means both layers at once. */
import { AlertTriangle, Bell, CheckCircle2, HelpCircle, ShieldQuestion, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  dismissHeaderNotice,
  dismissNotificationOffer,
  openHeaderNotice,
  requestSystemNotifications,
  useHeaderNotice,
  useNotificationOffer,
  type ThreadEvent,
} from "@/lib/notifications"
import { setupPush } from "@/lib/push"
import { cn } from "@/lib/utils"
import { loadSettings } from "@/lib/settings"

export { useHeaderNotice, useNotificationOffer }

export function NotificationAlert() {
  const offer = useNotificationOffer()
  if (!offer) return null

  const enable = () => {
    void requestSystemNotifications().then((granted) => {
      if (!granted) return
      // Permission is the gate for both layers: now that it is open, register
      // this device for server push too (a no-op if FCM isn't configured).
      const settings = loadSettings()
      if (settings) void setupPush(settings)
    })
  }

  return (
    /* One header-height row, laid out like the title it stands in for: icon,
       text that truncates, actions pinned right. No card, no border — it is
       the header now, not something floating over it. */
    <div
      data-slot="notification-offer"
      // -webkit-app-region: the header is a drag region under Electron, and a
      // button inside one is not clickable unless it opts back out.
      className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]"
    >
      <Bell className="size-4 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">Turn on notifications?</span>{" "}
        {/* The reason is the first thing to go when the row is narrow — the
            question above carries the offer on its own. */}
        <span className="hidden text-muted-foreground sm:inline">
          Get told when a turn finishes, fails or needs you — even in the background.
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="outline" onClick={enable}>
          Enable
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={dismissNotificationOffer}
          aria-label="Not now"
          title="Not now"
        >
          <X />
        </Button>
      </div>
    </div>
  )
}


/* ── The event notice ──
   A turn finished, failed, or wants something, on a thread you are not looking
   at. It takes the header's row for a few seconds and then gives it back. Same
   shape as the offer above — icon, truncating text, actions right — because
   they occupy the same slot and should not make the header jump between two
   layouts. */

const NOTICE_ICONS: Record<ThreadEvent, React.ElementType> = {
  turnFinished: CheckCircle2,
  turnFailed: AlertTriangle,
  permissionNeeded: ShieldQuestion,
  questionAsked: HelpCircle,
}

export function HeaderNotice() {
  const notice = useHeaderNotice()
  if (!notice) return null

  const Icon = NOTICE_ICONS[notice.event]
  const failed = notice.event === "turnFailed"

  return (
    <div
      data-slot="header-notice"
      /* key on the id upstream: a replacement re-mounts, so the animation
         replays instead of the text swapping silently under the same row. */
      className="flex min-w-0 flex-1 animate-in items-center gap-2 fade-in slide-in-from-top-1 [-webkit-app-region:no-drag]"
    >
      <Icon className={cn("size-4 shrink-0", failed ? "text-destructive" : "text-primary")} />
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className={cn("font-medium", failed && "text-destructive")}>{notice.label}</span>{" "}
        <span className="text-muted-foreground">{notice.body}</span>
      </p>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="outline" onClick={() => openHeaderNotice(notice)}>
          Open
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={dismissHeaderNotice}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <X />
        </Button>
      </div>
    </div>
  )
}
