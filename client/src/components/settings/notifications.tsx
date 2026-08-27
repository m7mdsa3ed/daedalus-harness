import { toast } from "sonner"
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
import { setupPush } from "@/lib/push"
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
                    // Spaced out: one slot holds the header notice, so four at
                    // once would only ever show the last of them.
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
        shows them. When no client is connected to a thread at all, the server delivers the same
        events as push notifications to registered devices, if it has FCM configured.
      </p>
    </>
  )
}
