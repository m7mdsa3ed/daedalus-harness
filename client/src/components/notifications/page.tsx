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
import { KIND_META, NotificationRow } from "@/components/notifications/items"
import { EmptyCard, FormPageHeader } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { AppNotification } from "@/lib/notifications-inbox"
import {
  useClearInbox,
  useInbox,
  useMarkNotificationsRead,
} from "@/lib/queries/surfaces"
import { settingsPath } from "@/lib/router"
import { periodLabel } from "@/lib/time"
import { cn } from "@/lib/utils"

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
  const { inbox, refetch } = useInbox()
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
      <FormPageHeader
        title="Notifications"
        description="What the harness recorded while you were elsewhere: a turn that finished or failed, a permission the agent is blocked on, a question it asked. Opening one goes to its thread and marks it read."
        onBack={() => void navigate("/")}
      />

      {items.length === 0 ? (
        <EmptyCard
          icon={BellIcon}
          text={
            inbox
              ? "Nothing here yet. A notice is recorded when a turn ends, fails, or stops to ask you something — turn the ones you want delivered to this device on in Settings."
              : "Loading…"
          }
          action={
            inbox ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void navigate(settingsPath("notifications"))}
              >
                Notification settings
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* The toolbar: filters on the left, housekeeping on the right. It
              sticks under the header so a long history keeps its controls in
              reach; the backdrop is the page's own colour, so scrolled rows
              vanish under it rather than showing through. */}
          <div className="sticky top-0 z-10 -mx-1 mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 bg-background/95 px-1 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            <ToggleGroup
              value={[filter]}
              onValueChange={(v) => {
                const next = (v as Filter[])[0]
                if (next) setFilter(next)
              }}
              spacing={1}
              size="sm"
              className="-ml-1 flex-wrap"
              aria-label="Filter notifications"
            >
              {FILTERS.map((f) => (
                <ToggleGroupItem
                  key={f.id}
                  value={f.id}
                  size="sm"
                  className="h-7 gap-1.5 px-2.5 text-xs data-[pressed]:bg-muted data-[pressed]:text-foreground text-muted-foreground"
                >
                  {f.label}
                  <span
                    className={cn(
                      "rounded-pill px-1.5 py-px text-[10px] leading-4 tabular-nums",
                      f.id === "unread" && counts.unread > 0
                        ? "bg-destructive text-white"
                        : "bg-muted-foreground/10 text-muted-foreground"
                    )}
                  >
                    {counts[f.id]}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground"
                disabled={unread === 0}
                onClick={() => markRead.mutate(undefined)}
              >
                <CheckCheckIcon data-icon="inline-start" />
                Mark all read
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-muted-foreground hover:text-destructive"
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
            </div>
          </div>

          {shown.length === 0 ? (
            /* A filter that matches nothing is not an empty inbox, so it does
               not get the inbox's empty card — it gets a line and a way back. */
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-10 text-center">
              <SearchXIcon className="size-5 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">
                Nothing matches “{active.label}”.
              </p>
              <Button size="sm" variant="outline" onClick={() => setFilter("all")}>
                Show all
              </Button>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.label} className="mb-6 last:mb-0">
                <h2 className="mb-2 flex items-baseline gap-2 px-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {g.label}
                  <span className="text-[10px] font-normal tabular-nums normal-case tracking-normal text-muted-foreground/70">
                    {g.items.length}
                  </span>
                </h2>
                <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                  {g.items.map((n) => (
                    <li key={n.id}>
                      <NotificationRow notification={n} detailed />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </>
      )}
    </>
  )
}
