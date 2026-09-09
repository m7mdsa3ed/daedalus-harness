/* ── The Trash's own action ── everything else in the group belongs to a
   thread in it, and lives on the row. */
import * as React from "react"
import { Trash2 } from "lucide-react"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { useConfirm } from "@/components/confirm-dialog"
import type { Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { MENU, ROW } from "./scale"

/** The one action that belongs to the Trash rather than to a thread in it.
    At the foot of the list, not on the label: the label is a disclosure
    trigger, and a destructive button inside a trigger is a click away from
    being hit by someone who only meant to fold the group. */
export function EmptyTrash({ sessions, actions }: { sessions: SessionMeta[]; actions: Actions }) {
  const confirm = useConfirm()
  const [busy, setBusy] = React.useState(false)

  const empty = async () => {
    if (
      !(await confirm({
        title: sessions.length === 1 ? "Empty the Trash?" : `Delete ${sessions.length} threads forever?`,
        description:
          "The harness forgets them. Only each agent's own transcript file would still have the conversation.",
        confirmLabel: "Delete forever",
        destructive: true,
      }))
    )
      return
    setBusy(true)
    /* One at a time: purgeThread refreshes the session list after each, and a
       parallel burst would have several refreshes racing. There are never many. */
    try {
      for (const session of sessions) await actions.purgeThread(session.id)
    } catch (err) {
      reportError(err, "Couldn't empty the Trash")
    } finally {
      setBusy(false)
    }
  }

  return (
    <SidebarMenu className={MENU}>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="sm"
          onClick={empty}
          disabled={busy}
          tooltip="Delete every thread in the Trash"
          className={cn(ROW, "text-muted-foreground hover:bg-destructive/10 hover:text-destructive")}
        >
          <Trash2 />
          <span className="truncate">{busy ? "Emptying…" : "Empty Trash"}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
