import { toast } from "@/lib/toast"
import { BellRingIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import {
  requestSystemNotifications,
  setNotificationPref,
  testThreadNotification,
  useNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/notifications"
import { loadSettings } from "@/lib/settings"
import { setupPush, teardownPush } from "@/lib/push"
import { PageHeader, Group, Row } from "./primitives"
import { sectionMeta } from "./sections"

const THREAD_EVENT_ROWS: {
  key: keyof Pick<
    NotificationPrefs,
    "turnFinished" | "turnFailed" | "permissionNeeded" | "questionAsked"
  >
  title: string
  subtitle: string
}[] = [
  {
    key: "turnFinished",
    title: "Turn finished",
    subtitle: "The agent finished answering.",
  },
  {
    key: "turnFailed",
    title: "Turn failed",
    subtitle: "The prompt errored — agent crash, rejected request, unreachable endpoint.",
  },
  {
    key: "permissionNeeded",
    title: "Permission needed",
    subtitle: "The agent is waiting for you to approve a tool call.",
  },
  {
    key: "questionAsked",
    title: "Question asked",
    subtitle: "The agent is waiting for you to answer a question.",
  },
]

export function NotificationsPage() {
  const meta = sectionMeta("notifications")
  const prefs = useNotificationPrefs()
  return (
    <>
      <PageHeader meta={meta} />
      <Group label="Thread events">
        {THREAD_EVENT_ROWS.map(({ key, title, subtitle }) => (
          <Row key={key} title={title} subtitle={subtitle}>
            <Switch
              checked={prefs[key]}
              onCheckedChange={(checked) => setNotificationPref(key, checked)}
              aria-label={title}
            />
          </Row>
        ))}
      </Group>
      <Group label="Delivery">
        <Row
          title="System notifications"
          subtitle="Also notify through the operating system when this window is hidden or unfocused."
        >
          <Switch
            checked={prefs.system}
            onCheckedChange={(checked) => {
              if (!checked) {
                setNotificationPref("system", false)
                // Turning this off has to reach the server's token list too, or
                // the pushes it sends while no tab is attached keep arriving —
                // which is the loudest half of what was just switched off.
                const settings = loadSettings()
                if (settings) void teardownPush(settings)
                return
              }
              void requestSystemNotifications().then((granted) => {
                if (granted) {
                  setNotificationPref("system", true)
                  // The same grant opens server push — register this device
                  // now (a no-op when the server has no FCM configured).
                  const settings = loadSettings()
                  if (settings) void setupPush(settings)
                } else
                  toast.error("Notifications are blocked", {
                    description:
                      "Allow notifications for this site in the browser (or OS) settings, then try again.",
                  })
              })
            }}
            aria-label="System notifications"
          />
        </Row>
        <Row
          title="Sounds"
          subtitle="Play a short cue for each event above — also on the thread you are reading."
        >
          <Switch
            checked={prefs.sound}
            onCheckedChange={(checked) => setNotificationPref("sound", checked)}
            aria-label="Sounds"
          />
        </Row>
        <Row title="Tool-start sound" subtitle="Play a quiet tick when a tool call starts.">
          <Switch
            checked={prefs.toolStartedSound}
            onCheckedChange={(checked) => setNotificationPref("toolStartedSound", checked)}
            aria-label="Tool-start sound"
          />
        </Row>
        <Row title="Tool-failure sound" subtitle="Play a low blip when a tool call fails.">
          <Switch
            checked={prefs.toolFailedSound}
            onCheckedChange={(checked) => setNotificationPref("toolFailedSound", checked)}
            aria-label="Tool-failure sound"
          />
        </Row>
        <Row
          title="Vibration"
          subtitle="Vibrate for thread events and tool activity where the device and browser support it."
        >
          <Switch
            checked={prefs.vibration}
            onCheckedChange={(checked) => setNotificationPref("vibration", checked)}
            aria-label="Vibration"
          />
        </Row>
        {/* Notifications are, by design, the one thing you cannot make happen:
            they fire for a thread you are NOT reading, from a window you are
            NOT looking at. So the only way to see what you just configured is
            to ask for one. This forces past both of those checks — the
            preferences above still decide what a real event does. */}
        <Row
          icon={BellRingIcon}
          title="Send a test notification"
          subtitle="Shows one now, as if it had happened on another thread. The switches above are ignored for the test."
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm">
                  Send test
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-56">
              {THREAD_EVENT_ROWS.map(({ key, title }) => (
                <DropdownMenuItem key={key} onClick={() => testThreadNotification(key)}>
                  {title}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() =>
                  THREAD_EVENT_ROWS.forEach(({ key }, index) =>
                    // Spaced out so the stack is readable rather than a pile of
                    // four toasts all landing in the same instant.
                    window.setTimeout(() => testThreadNotification(key), index * 1200)
                  )
                }
              >
                One of each
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Row>
      </Group>
      <p className="px-1 text-xs text-pretty text-muted-foreground">
        Events on a thread you are currently reading are never announced — the transcript already
        shows them — except by sound, when it is on. When no client is connected to a thread at all, the server delivers the same
        events as push notifications to registered devices, if it has FCM configured.
      </p>
    </>
  )
}
