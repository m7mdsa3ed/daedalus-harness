/* ── /notifications — the whole inbox ──
   The bell in the header is the glance; this is the place. Outside /settings
   for the reason `/routines` and `/schedules` are: settings holds what you
   configure once (Settings › Notifications is still where push is turned on),
   and this is a history you read.

   It draws the same rows the popover does, one line richer, filed under the
   period they arrived in (Today, Yesterday, …) the way the sidebar files
   threads — a flat list of forty notices is a wall, and the question the reader
   brings is "what happened since I left". A filter row narrows by what the
   notice asks of you: the two kinds the agent is *blocked* on are one filter,
   because that is the one you check first.

   It is the only surface that offers Clear — emptying the inbox is
   housekeeping, and it is asked about here rather than under a list somebody
   opened for a glance. */
import * as React from "react"
import { BellIcon, CheckCheckIcon, SearchXIcon, Trash2Icon } from "lucide-react"
import { useNavigate } from "react-router"

import { useConfirm } from "@/components/confirm-dialog"
import { Empty } from "@/components/empty"
import { KIND_META, NotificationRow } from "@/components/notifications/items"
import { NeedsYou } from "@/components/notifications/needs-you"
import { SurfaceHeader } from "@/components/page-primitives"
import { ErrorNote } from "@/components/error-note"
import { Group, Section, TabBar } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { NotificationRowsSkeleton } from "@/components/ui/skeletons"
import type { AppNotification } from "@/lib/notifications-inbox"
import {
  useClearInbox,
  useInbox,
  useMarkNotificationsRead,
} from "@/lib/queries/surfaces"
import { settingsPath } from "@/lib/router"
import { inlineFromQuery } from "@/lib/errors"
import { periodLabel } from "@/lib/time"

type Filter = "all" | "unread" | "needs_you" | "turn_finished" | "turn_failed"

const FILTERS: { id: Filter; label: string; match: (n: AppNotification) => boolean }[] = [
  { id: "all", label: "All", match: () => true },
  { id: "unread", label: "Unread", match: (n) => !n.read },
  { id: "needs_you", label: "Needs you", match: (n) => KIND_META[n.kind].needsYou },
  { id: "turn_finished", label: "Finished", match: (n) => n.kind === "turn_finished" },
  { id: "turn_failed", label: "Failed", match: (n) => n.kind === "turn_failed" },
]

/** File notices under their period, in the order the list already has
    (newest first), so the first group is Today and no group is empty. */
function groupByPeriod(items: AppNotification[]) {
  const groups: { label: string; items: AppNotification[] }[] = []
  for (const n of items) {
    const label = periodLabel(n.createdAt)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(n)
    else groups.push({ label, items: [n] })
  }
  return groups
}

export function NotificationsInboxPage() {
  /* Landing on the page is the one moment the list has to be current — the
     cache otherwise refreshes only on return to the window. */
  const { inbox, isPending, error: readError, refetch } = useInbox()
  const error = React.useMemo(() => inlineFromQuery(readError, "Couldn't read the inbox"), [readError])
  const markRead = useMarkNotificationsRead()
  const clearInbox = useClearInbox()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [clearing, setClearing] = React.useState(false)
  const [filter, setFilter] = React.useState<Filter>("all")

  React.useEffect(() => {
    refetch()
  }, [refetch])

  const items = inbox?.items ?? []
  const unread = inbox?.unread ?? 0
  const counts = React.useMemo(
    () =>
      Object.fromEntries(
        FILTERS.map((f) => [f.id, items.filter(f.match).length])
      ) as Record<Filter, number>,
    [items]
  )
  const active = FILTERS.find((f) => f.id === filter) ?? FILTERS[0]
  const shown = React.useMemo(() => items.filter(active.match), [items, active])
  const groups = React.useMemo(() => groupByPeriod(shown), [shown])

  return (
    <>
      <SurfaceHeader
        title="Notifications"
        description="What the harness recorded while you were elsewhere: a turn that finished or failed, a permission the agent is blocked on, a question it asked. Opening one goes to its thread and marks it read."
        onBack={() => void navigate("/")}
        actions={
          items.length > 0 ? (
            <>
              <Button variant="outline" disabled={unread === 0} onClick={() => markRead.mutate(undefined)}>
                <CheckCheckIcon data-icon="inline-start" />
                Mark all read
              </Button>
              <Button
                variant="outline"
                className="hover:text-destructive"
                disabled={clearing}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: "Clear every notification?",
                      description:
                        "The inbox is emptied on every device. The threads themselves are untouched.",
                      confirmLabel: "Clear",
                      destructive: true,
                    }))
                  )
                    return
                  setClearing(true)
                  clearInbox.mutate(undefined, { onSettled: () => setClearing(false) })
                }}
              >
                <Trash2Icon data-icon="inline-start" />
                Clear
              </Button>
            </>
          ) : undefined
        }
      />

      {items.length > 0 && (
        <TabBar
          label="Filter notifications"
          value={filter}
          onChange={(id) => setFilter(id as Filter)}
          items={FILTERS.map((f) => ({
            id: f.id,
            label: f.label,
            count: counts[f.id],
            dot: f.id === "unread" && counts.unread > 0,
          }))}
        />
      )}

      <NeedsYou />

      {!inbox && error ? (
        <Section>
          <ErrorNote error={error} onRetry={refetch} />
        </Section>
      ) : !inbox && isPending ? (
        /* A read in flight is not an empty inbox. The card below says "nothing
           here yet", and it would say it while the list is still arriving. */
        <Group>
          <NotificationRowsSkeleton rows={5} detailed className="-mx-3 @panel-sm:-mx-4" />
        </Group>
      ) : items.length === 0 ? (
        <Empty
          size="lg"
          icon={BellIcon}
          action={
            <Button size="sm" variant="outline" onClick={() => void navigate(settingsPath("notifications"))}>
              Notification settings
            </Button>
          }
        >
          Nothing here yet. A notice is recorded when a turn ends, fails, or stops to ask you something — turn the
          ones you want delivered to this device on in Settings.
        </Empty>
      ) : (
        <>
          {shown.length === 0 ? (
            /* A filter that matches nothing is not an empty inbox, so it does
               not get the inbox's empty card — it gets a line and a way back. */
            <Empty
              size="lg"
              icon={SearchXIcon}
              action={
                <Button size="sm" variant="outline" onClick={() => setFilter("all")}>
                  Show all
                </Button>
              }
            >
              Nothing matches “{active.label}”.
            </Empty>
          ) : (
            groups.map((g) => (
              <Group key={g.label} label={g.label} count={g.items.length}>
                <ul className="-mx-3 divide-y @panel-sm:-mx-4">
                  {g.items.map((n) => (
                    <li key={n.id}>
                      <NotificationRow notification={n} detailed />
                    </li>
                  ))}
                </ul>
              </Group>
            ))
          )}
        </>
      )}
    </>
  )
}
