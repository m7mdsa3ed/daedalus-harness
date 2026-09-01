/* ── /notifications — the whole inbox ──
   The bell in the header is the glance; this is the place. Outside /settings
   for the reason `/routines` and `/schedules` are: settings holds what you
   configure once (Settings › Notifications is still where push is turned on),
   and this is a history you read.

   It draws the same rows the popover does, one line richer, and it is the only
   surface that offers Clear — emptying the inbox is housekeeping, and it is
   asked about here rather than under a list somebody opened for a glance. */
import * as React from "react"
import { BellIcon, CheckIcon, Trash2Icon } from "lucide-react"
import { useNavigate } from "react-router"

import { useConfirm } from "@/components/confirm-dialog"
import { NotificationRow } from "@/components/notifications/items"
import { EmptyCard, FormPageHeader, Group } from "@/components/settings/primitives"
import { Button } from "@/components/ui/button"
import {
  useClearInbox,
  useInbox,
  useMarkNotificationsRead,
} from "@/lib/queries/surfaces"
import { settingsPath } from "@/lib/router"

export function NotificationsInboxPage() {
  /* Landing on the page is the one moment the list has to be current — the
     cache otherwise refreshes only on return to the window. */
  const { inbox, refetch } = useInbox()
  const markRead = useMarkNotificationsRead()
  const clearInbox = useClearInbox()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [clearing, setClearing] = React.useState(false)

  React.useEffect(() => {
    refetch()
  }, [refetch])

  const items = inbox?.items ?? []
  const unread = inbox?.unread ?? 0

  return (
    <>
      <FormPageHeader
        title="Notifications"
        description="What the harness recorded while you were elsewhere: a turn that finished or failed, a permission the agent is blocked on, a question it asked. Opening one goes to its thread and marks it read."
        onBack={() => void navigate("/")}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground tabular-nums">
          {items.length === 0
            ? inbox
              ? "Nothing recorded"
              : "Loading…"
            : `${items.length} notice${items.length === 1 ? "" : "s"}${unread > 0 ? ` · ${unread} unread` : ""}`}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={unread === 0}
            onClick={() => markRead.mutate(undefined)}
          >
            <CheckIcon data-icon="inline-start" />
            Mark all read
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={clearing || items.length === 0}
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
      {items.length === 0 ? (
        <EmptyCard
          icon={BellIcon}
          text="Nothing here yet. A notice is recorded when a turn ends, fails, or stops to ask you something — turn the ones you want delivered to this device on in Settings."
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => void navigate(settingsPath("notifications"))}
            >
              Notification settings
            </Button>
          }
        />
      ) : (
        <Group>
          <ul className="divide-y">
            {items.map((n) => (
              <li key={n.id}>
                <NotificationRow notification={n} detailed />
              </li>
            ))}
          </ul>
        </Group>
      )}
    </>
  )
}
