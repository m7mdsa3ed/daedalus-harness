/* ── Enable-notifications alert ──
   Sits above the composer until the browser has been asked for notification
   permission (or the user waves it off). The ask itself must ride a click —
   setupPush never prompts — and once granted the same click registers this
   device for FCM push, so "enable" means both layers at once. */
import { Bell, X } from "lucide-react"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  dismissNotificationOffer,
  requestSystemNotifications,
  useNotificationOffer,
} from "@/lib/notifications"
import { setupPush } from "@/lib/push"
import { loadSettings } from "@/lib/settings"

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
    <div className="mx-auto w-full max-w-[var(--harness-composer-width)] px-4 pb-2">
      <Alert>
        <Bell className="size-4" />
        <AlertTitle>Turn on notifications?</AlertTitle>
        <AlertDescription>
          Get told when a turn finishes, fails or needs your approval — even when this window is in
          the background.
        </AlertDescription>
        <AlertAction className="flex items-center gap-1">
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
        </AlertAction>
      </Alert>
    </div>
  )
}
