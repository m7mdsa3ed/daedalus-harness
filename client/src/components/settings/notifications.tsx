import * as React from "react"
import type { LucideIcon } from "lucide-react"
import { toast } from "@/lib/toast"
import { BellIcon, BellOffIcon, BellRingIcon, CheckCircle2Icon, CircleAlertIcon, HelpCircleIcon, ShieldAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { DataTable, TitleCell, type DataTableColumnMeta, type TableAction } from "@/components/ui/data-table"
import type { ColumnDef } from "@/lib/table"
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
import { Notice } from "@/components/notice"
import { Group, PageHeader, Row, Section, StatusBadge } from "./primitives"
import { sectionMeta } from "./sections"
import { useTableFilter } from "@/lib/use-table-filter"

const THREAD_EVENT_ROWS: {
  key: keyof Pick<
    NotificationPrefs,
    "turnFinished" | "turnFailed" | "permissionNeeded" | "questionAsked"
  >
  title: string
  subtitle: string
  icon: LucideIcon
}[] = [
  {
    key: "turnFinished",
    icon: CheckCircle2Icon,
    title: "Turn finished",
    subtitle: "The agent finished answering.",
  },
  {
    key: "turnFailed",
    icon: CircleAlertIcon,
    title: "Turn failed",
    subtitle: "The prompt errored — agent crash, rejected request, unreachable endpoint.",
  },
  {
    key: "permissionNeeded",
    icon: ShieldAlertIcon,
    title: "Permission needed",
    subtitle: "The agent is waiting for you to approve a tool call.",
  },
  {
    key: "questionAsked",
    icon: HelpCircleIcon,
    title: "Question asked",
    subtitle: "The agent is waiting for you to answer a question.",
  },
]

/** Turning this off has to reach the server's token list too, or the pushes it
    sends while no tab is attached keep arriving — the loudest half of what was
    just switched off. Turning it on asks the browser first. */
function toggleSystem(checked: boolean) {
  if (!checked) {
    setNotificationPref("system", false)
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
}

const CUE_ROWS: {
  key: keyof Pick<
    NotificationPrefs,
    "sound" | "toolStartedSound" | "toolFailedSound" | "vibration"
  >
  title: string
  subtitle: string
}[] = [
  {
    key: "sound",
    title: "Sounds",
    subtitle: "Play a short cue for each event above — also on the thread you are reading.",
  },
  {
    key: "toolStartedSound",
    title: "Tool-start sound",
    subtitle: "Play a quiet tick when a tool call starts.",
  },
  {
    key: "toolFailedSound",
    title: "Tool-failure sound",
    subtitle: "Play a low blip when a tool call fails.",
  },
  {
    key: "vibration",
    title: "Vibration",
    subtitle: "Vibrate for thread events and tool activity where the device and browser support it.",
  },
]

type EventRow = (typeof THREAD_EVENT_ROWS)[number] & { on: boolean }

/** The browser's answer, in words — the half of "can this device reach you"
    that the switch alone does not say. */
function permissionNote(): string {
  if (typeof Notification === "undefined") return "This browser cannot show system notifications."
  if (Notification.permission === "granted") return "Permission granted."
  if (Notification.permission === "denied") return "Blocked by the browser — allow this site in its settings."
  return "The browser will ask when you switch this on."
}

/* The table's columns, actions and mark are module-level so the table's
   per-row memo holds; only `on` moves, and it rides in the row. */
const EVENT_COLUMNS: ColumnDef<EventRow, unknown>[] = [
  {
    id: "event",
    header: "Event",
    cell: ({ row }) => (
      <TitleCell
        title={row.original.title}
        subtitle={<span title={row.original.subtitle}>{row.original.subtitle}</span>}
      />
    ),
    meta: { title: true } satisfies DataTableColumnMeta,
  },
  {
    id: "notify",
    header: "Announce",
    cell: ({ row }) => (
      <Switch
        checked={row.original.on}
        onCheckedChange={(checked) => setNotificationPref(row.original.key, checked)}
        aria-label={`Announce ${row.original.title}`}
      />
    ),
    meta: { align: "end", className: "w-28" } satisfies DataTableColumnMeta,
  },
]

const EVENT_ACTIONS: TableAction<EventRow>[] = [
  {
    id: "test",
    label: "Send test",
    icon: <BellIcon className="size-4" />,
    onClick: (row) => testThreadNotification(row.key),
  },
]

const eventMark = (row: EventRow) => {
  const Icon = row.icon
  return <Icon />
}

/** A phone row: mark, the event in full (the description wraps — four rows
    can afford it), and the one switch at the thumb's edge. */
const eventPhoneRow = (row: EventRow) => {
  const Icon = row.icon
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{row.title}</div>
        <div className="text-sm/relaxed text-muted-foreground">{row.subtitle}</div>
      </div>
      <Switch
        checked={row.on}
        onCheckedChange={(checked) => setNotificationPref(row.key, checked)}
        aria-label={`Announce ${row.title}`}
      />
    </div>
  )
}

export function NotificationsPage() {
  const meta = sectionMeta("notifications")
  const prefs = useNotificationPrefs()
  const rows = React.useMemo<EventRow[]>(
    () => THREAD_EVENT_ROWS.map((row) => ({ ...row, on: prefs[row.key] })),
    [prefs]
  )
  const eventsOn = rows.filter((row) => row.on).length
  const f = useTableFilter(rows, {
    text: (r) => `${r.title} ${r.subtitle}`,
    placeholder: "Search events…",
    fields: [{ id: "announce", label: "Announce", of: (r) => (r.on ? "On" : "Off") }],
  })
  return (
    <>
      <PageHeader meta={meta} />
      <Group label="Delivery" hint="Whether this device is allowed to reach you outside the app.">
        <Row
          icon={prefs.system ? BellRingIcon : BellOffIcon}
          title={
            <span className="flex items-center gap-2">
              System notifications
              <StatusBadge tone={prefs.system ? "ok" : "neutral"} dot={prefs.system}>
                {prefs.system ? "On" : "Off"}
              </StatusBadge>
            </span>
          }
          subtitle={`Also notify through the operating system when this window is hidden or unfocused. ${permissionNote()}`}
        >
          <Switch checked={prefs.system} onCheckedChange={toggleSystem} aria-label="System notifications" />
        </Row>
        {/* Notifications are, by design, the one thing you cannot make happen:
            they fire for a thread you are NOT reading, from a window you are
            NOT looking at. So the only way to see what you just configured is
            to ask for one. This forces past both of those checks — the
            preferences below still decide what a real event does. */}
        <Row
          icon={BellIcon}
          title="Send test"
          subtitle="Shows one now, as if it had happened on another thread. The switches below are ignored for the test."
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm" className="h-11 @panel-sm:h-9">
                  <BellIcon />
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
      <Section label="Events" hint="Choose which thread events are announced.">
        <DataTable
          columns={EVENT_COLUMNS}
          data={f.rows}
          filtering={f.filtering}
          getRowId={(row) => row.key}
          actions={EVENT_ACTIONS}
          mark={eventMark}
          mobile={{ renderRow: eventPhoneRow }}
          emptyIcon={<BellIcon />}
          emptyMessage={f.narrowed ? "No events match." : undefined}
          toolbar={
            <span className="text-sm text-muted-foreground tabular-nums">
              {eventsOn} of {rows.length} announced
            </span>
          }
        />
      </Section>
      <Group label="Sound and vibration" hint="Cues that play alongside the events above.">
          {CUE_ROWS.map(({ key, title, subtitle }) => (
            <Row key={key} title={title} subtitle={subtitle}>
              <Switch
                checked={prefs[key]}
                onCheckedChange={(checked) => setNotificationPref(key, checked)}
                aria-label={title}
              />
            </Row>
          ))}
      </Group>
      <Notice className="mt-8" size="md">
        <p className="text-pretty">
          Events on a thread you are currently reading are never announced — the transcript already
          shows them — except by sound, when it is on. When no client is connected to a thread at
          all, the server delivers the same events as push notifications to registered devices, if
          it has FCM configured.
        </p>
      </Notice>
    </>
  )
}
