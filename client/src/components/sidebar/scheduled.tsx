/* ── Scheduled ── the prompts the server will deliver later. */
import {
  CalendarClock,
  MoreVertical,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react"
import { useLocation, useNavigate } from "react-router"
import { reportError } from "@/lib/errors"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useConfirm } from "@/components/confirm-dialog"
import type { Actions } from "@/lib/actions"
import { schedulePath, schedulesPath, threadPath } from "@/lib/router"
import { scheduleSkipped, scheduleWhen } from "@/lib/schedule"
import { isTopLevel, type ScheduledMessage } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { FoldableGroup } from "./groups"
import { ACTION, MENU } from "./scale"

/** Upcoming prompts the server will deliver even with no browser open — the
    sidebar's "Automations". It names the thread it will land in, so its row
    opens that thread. Shown even when empty, because a section that hides
    itself is also the one place nobody can find to create the first item;
    the + on the label reuses the schedule page and its picker, which is why
    it needs a live thread to exist at all. */
export function ScheduledGroup({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const navigate = useNavigate()
  const location = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()
  const confirm = useConfirm()

  const live = state.sessions.filter((s) => isTopLevel(s) && !s.draft && !s.deletedAt)

  const cancel = async (id: string) => {
    if (
      !(await confirm({
        title: "Cancel this scheduled message?",
        description:
          "It is removed from the schedule and never sent. The thread itself is untouched, and you can schedule the message again.",
        destructive: true,
        confirmLabel: "Cancel schedule",
      }))
    )
      return
    actions.cancelSchedule(id).catch((err) => reportError(err, "Couldn't cancel the schedule"))
  }

  const open = (sessionId: string) => {
    if (isMobile) setOpenMobile(false)
    void navigate(threadPath(sessionId))
  }

  const openList = () => {
    if (isMobile) setOpenMobile(false)
    void navigate(schedulesPath())
  }

  const titleOf = (sessionId: string) =>
    state.sessions.find((s) => s.id === sessionId)?.title ?? "Unknown thread"

  const toggle = (item: ScheduledMessage) => {
    const enable = item.enabled === 0 || scheduleSkipped(item)
    actions
      .updateSchedule(item.id, { enabled: enable })
      .catch((err) => reportError(err, "Couldn't update the schedule"))
  }

  const HEADER_BUTTON =
    "grid size-4 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

  return (
    <FoldableGroup
      groupKey="__scheduled"
      label="Scheduled"
      icon={<CalendarClock className="size-3 shrink-0" />}
      count={state.scheduled.length > 0 ? state.scheduled.length : undefined}
      action={
        <>
          {state.scheduled.length > 0 && (
            <button type="button" title="Manage schedules" onClick={openList} className={HEADER_BUTTON}>
              <Pencil className="size-3" />
              <span className="sr-only">Manage schedules</span>
            </button>
          )}
          {live.length > 0 && (
            <button
              type="button"
              title="New schedule"
              onClick={() =>
                void navigate(schedulePath(live[0].id), {
                  state: { returnTo: location.pathname + location.search },
                })
              }
              className={HEADER_BUTTON}
            >
              <Plus className="size-3.5" />
              <span className="sr-only">New schedule</span>
            </button>
          )}
        </>
      }
    >
      {state.scheduled.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
          {live.length > 0
            ? "Nothing scheduled. + adds a prompt the server sends later."
            : "Nothing scheduled — open a thread first."}
        </p>
      ) : (
        <SidebarMenu className={MENU}>
          {state.scheduled.map((item) => {
            const paused = item.enabled === 0
            const skipped = scheduleSkipped(item)
            return (
              <SidebarMenuItem key={item.id}>
                <SidebarMenuButton
                  tooltip={`${titleOf(item.sessionId)} — ${scheduleWhen(item.nextAt, item.everyMs)}${paused ? " (paused)" : ""}${skipped && item.lastError ? ` — ${item.lastError}` : ""}`}
                  onClick={() => open(item.sessionId)}
                  className="h-auto min-h-8 px-2 py-1 text-[13px]"
                >
                  {/* Two lines, because the message is the schedule's payload:
                      a row that showed only the thread could not tell two
                      schedules apart. */}
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-[13px] leading-tight",
                        paused && "text-muted-foreground"
                      )}
                    >
                      {titleOf(item.sessionId)}
                    </span>
                    <span
                      className={cn(
                        "block truncate text-[10px] leading-tight",
                        skipped ? "text-amber-500" : "text-muted-foreground"
                      )}
                    >
                      {paused && "Paused · "}
                      {skipped && `${item.lastError ?? "couldn't deliver"} · `}
                      {item.text} · {scheduleWhen(item.nextAt, item.everyMs)}
                    </span>
                  </span>
                </SidebarMenuButton>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <SidebarMenuAction showOnHover title="Schedule actions" className={ACTION}>
                        <MoreVertical />
                        <span className="sr-only">Schedule actions</span>
                      </SidebarMenuAction>
                    }
                  />
                  <DropdownMenuContent side="right" align="start" className="w-44">
                    <DropdownMenuItem onClick={() => toggle(item)}>
                      {paused || skipped ? <Play /> : <Pause />}
                      {paused || skipped ? "Resume" : "Pause"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={openList}>
                      <Pencil />
                      Edit…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => void cancel(item.id)}>
                      <Trash2 />
                      Cancel schedule
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
      )}
    </FoldableGroup>
  )
}
