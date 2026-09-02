/* ── One thread, one line ── the row, its info card, and its menus. */
import * as React from "react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { AgentIcon, ProjectIcon } from "@/components/entity-icon"
import { flattenMenuItems, ItemContextMenu } from "@/components/item-context-menu"
import { threadMenuItems, trashMenuItems } from "@/components/thread-menu"
import { activityAt, type SessionMeta } from "@/lib/settings"
import { useAgents, useProfiles, useProjects } from "@/lib/queries/catalog"
import { useStoreSelect } from "@/lib/store"
import type { ThreadActivity } from "@/lib/thread/phase"
import { cn } from "@/lib/utils"
import { ROW } from "./scale"

/* The reading a row shows comes from `lib/thread/phase.ts` and is shared with
   the dock tabs and the project page. It used to be declared here as
   `"idle" | "running" | "waiting"`, derived from `turnActive` alone and unable
   to see the connection at all — so a thread whose socket had died thirty
   seconds ago, and was working through its reconnect ladder, read "Idle" in
   every list on screen. It also collided by name with the connection status in
   the store, which made both hard to grep for. */
export type ThreadStatus = ThreadActivity

/** How long a finger has to rest on a row before it is a press, not a tap. */
const LONG_PRESS_MS = 450

/** Hover has to rest this long before the card opens — a pointer crossing
    the list on its way somewhere else must not flash six cards. */
const HOVER_DELAY_MS = 500

/** One thread, one line. The title and — when there is one — a status dot;
    nothing else on the row. Everything else lives in one popover that opens
    on hover (Base UI's `openOnHover`, so it also closes when the pointer
    leaves both row and card) and, on a phone, on long press: the info card
    with the row's actions under it, standing in for the dot menu and, on a
    phone, for the right-click menu a finger cannot open.

    Memoized on narrow props — the session object (stable between server
    refreshes), three flags and four hoisted callbacks — so the per-token
    sidebar render skips every row whose status did not change. The menu items
    are built here for the same reason: an array of fresh closures per parent
    render would defeat the memo. */
export const ThreadRow = React.memo(function ThreadRow({
  session,
  state,
  trash,
  active,
  pinned,
  onOpen,
  onRename,
  onDelete,
  onRestore,
  onPurge,
}: {
  session: SessionMeta
  state: ThreadStatus
  trash: boolean
  active: boolean
  pinned: boolean
  onOpen: (session: SessionMeta, newTab?: boolean) => void
  onRename: (session: SessionMeta) => void
  onDelete: (session: SessionMeta) => void
  onRestore: (session: SessionMeta) => void
  onPurge: (session: SessionMeta) => void
}) {
  /* One list feeds both the popover's actions and the right-click menu. */
  const items = React.useMemo(
    () =>
      trash
        ? trashMenuItems(session, onRestore, onPurge)
        : threadMenuItems(session, pinned, {
            openInNewTab: () => onOpen(session, true),
            onRename,
            onDelete,
          }),
    [session, trash, pinned, onOpen, onRename, onDelete, onRestore, onPurge]
  )
  const { isMobile } = useSidebar()
  const [infoOpen, setInfoOpen] = React.useState(false)
  /* The press in flight: its timer, and whether it fired. `fired` outlives
     the timer because the click that ends a long press arrives *after*
     pointerup, and that click must open the card's row nowhere. */
  const press = React.useRef<{ timer: number; fired: boolean } | null>(null)

  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer)
  }
  const startPress = (event: React.PointerEvent) => {
    if (event.pointerType === "mouse") return
    cancelPress()
    const current = { fired: false, timer: 0 }
    current.timer = window.setTimeout(() => {
      current.fired = true
      setInfoOpen(true)
    }, LONG_PRESS_MS)
    press.current = current
  }
  const click = (event: React.MouseEvent) => {
    if (press.current?.fired) {
      press.current.fired = false
      event.preventDefault()
      return
    }
    onOpen(session, event.metaKey || event.ctrlKey)
  }

  const row = (
    <>
      {/* A running turn is the title itself shimmering — the pale band that
          the working line and a live thought already use — rather than a dot
          beside it: the row *is* the thing in motion. A thread waiting on you
          keeps the amber dot at the trailing edge — a still mark that says
          "stopped, for you", on the one row you must act on. */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          (session.exited || trash) && "text-muted-foreground",
          trash && "line-through",
          state === "running" && "harness-shimmer",
          /* A different animation from `running` on purpose: the shimmer means
             the agent is writing, and a reconnect is the opposite of that —
             something is happening *to* the thread, not in it. Before this the
             two were indistinguishable, because a row could not see the
             connection at all and a reconnecting thread simply read as idle. */
          (state === "reconnecting" || state === "offline") && "animate-pulse"
        )}
      >
        {session.title}
      </span>
      {state === "waiting" && (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />
      )}
      {/* A turn that ended badly is the other still mark that means "for you",
          and it is destructive rather than amber because the two are different
          asks: one is a question waiting to be answered, the other is work that
          stopped. It draws for a thread this device has never opened — the
          verdict is on the session row, not in the transcript. */}
      {state === "failed" && (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive" />
      )}
      {(state === "reconnecting" || state === "offline") && (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/60" />
      )}
    </>
  )
  const button = (
    <SidebarMenuButton
      size="sm"
      isActive={active}
      onClick={click}
      onPointerDown={startPress}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      /* A finger resting on the row must not also raise the browser's own
         callout or the native context menu — the popover is the long press. */
      onContextMenu={(event) => {
        if (isMobile) event.preventDefault()
      }}
      className={cn(ROW, isMobile && "select-none [-webkit-touch-callout:none]")}
    />
  )
  const card = <ThreadInfoCard session={session} state={state} trash={trash} />

  return (
    <SidebarMenuItem>
      <Popover
        open={infoOpen}
        onOpenChange={(open, details) => {
          /* A tap or click on the row is navigation, never a toggle — the
             popover's own press handling is ignored. Hover opens are Base
             UI's (desktop); a long press sets the state itself (mobile). */
          if (open && details.reason === "trigger-press") return
          setInfoOpen(open)
        }}
      >
        {isMobile ? (
          <PopoverTrigger render={button}>{row}</PopoverTrigger>
        ) : (
          <ItemContextMenu items={items}>
            <PopoverTrigger render={button} openOnHover delay={HOVER_DELAY_MS}>
              {row}
            </PopoverTrigger>
          </ItemContextMenu>
        )}
        <PopoverContent
          side={isMobile ? "bottom" : "right"}
          align="start"
          sideOffset={8}
          className="w-72 gap-3 p-3"
        >
          {card}
          {/* The info card carries the row's actions too, so one hover — or one
              long press — reaches both: the reading and what to do with it. On
              desktop this replaces the ⋯ dot menu that used to sit over the
              title; mobile already did this, which is what it now matches. */}
          <div className="flex flex-col gap-0.5 border-t border-border/60 pt-2">
            {/* Flattened: this list draws its own rows, so a submenu here
                would be a row that opens nothing. */}
            {flattenMenuItems(items).map((item, index) =>
              item.type === "separator" || item.type === "sub" ? null : (
                <button
                  key={index}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => {
                    setInfoOpen(false)
                    item.onClick()
                  }}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] hover:bg-accent disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
                    item.destructive && "text-destructive"
                  )}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              )
            )}
          </div>
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  )
})

/** What the row no longer says: the thread's status, who runs it and where,
    and when it began. */
function ThreadInfoCard({
  session,
  state,
  trash,
}: {
  session: SessionMeta
  state: ThreadStatus
  trash: boolean
}) {
  /* Three catalog reads. This card is rendered per row of the sidebar; the
     catalog lives in the query cache, so only a refresh of one of these three
     re-renders it — never a token from some other open thread. */
  const project = useProjects().find((p) => p.id === session.projectId)
  const profile = useProfiles().find((p) => p.id === session.profileId)?.name
  const agent = useAgents().find((a) => a.id === session.agentId)?.name ?? session.agentId
  /* The parent's title, not the row: a string compares by value, so this stays
     quiet through the parent thread's own stream. */
  const parentTitle = useStoreSelect((s) =>
    session.parentSessionId
      ? s.sessions.find((row) => row.id === session.parentSessionId)?.title
      : undefined
  )
  const when = (ts: number) =>
    new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  /* One reading, in the order it matters. The connection states are new here:
     a thread that had lost its socket used to say "Idle" in this card, which is
     the reading the card exists to prevent — and so is the failed turn, which
     was only ever visible by opening the transcript and scrolling to the end. */
  const status = trash
    ? "In Trash"
    : state === "waiting"
      ? "Needs you"
      : state === "running"
        ? "Running"
        : state === "reconnecting"
          ? "Reconnecting"
          : state === "offline"
            ? "Waiting for the server"
            : state === "failed"
              ? "Last turn failed"
              : state === "connecting"
                ? "Opening"
                : state === "gone"
                  ? "Deleted"
                  : state === "stopped" || session.exited
                    ? "Stopped"
                    : session.draft
                      ? "Not started"
                      : "Idle"
  const rows: [string, React.ReactNode][] = [
    ["Status", status],
    [
      "Agent",
      <span key="agent" className="flex items-center gap-1.5">
        <AgentIcon agentId={session.agentId} className="size-3.5" />
        {agent}
      </span>,
    ],
    ["Profile", profile ?? "—"],
    ["Model", [session.model, session.effort].filter(Boolean).join(" · ") || "Agent's own"],
    [
      "Project",
      <span key="project" className="flex items-center gap-1.5">
        {project && <ProjectIcon project={project} className="size-3.5" />}
        {project?.name ?? "Other"}
      </span>,
    ],
    ["Started", when(session.createdAt)],
  ]
  /* The list orders by activity now, so the card says what the position means
     — and only when it differs from the start, since a thread with one turn in
     it would otherwise print the same timestamp twice. */
  if (activityAt(session) - session.createdAt > 60_000)
    rows.push(["Last active", when(activityAt(session))])
  /* Why it failed, in the card rather than on the row: the row has space for a
     mark, and the card is where a reading is explained. One clipped line like
     every other value here — the failure itself, with its detail and a Retry,
     is a row in the transcript. */
  if (!trash && session.lastTurnError)
    rows.push([
      "Failure",
      <span key="failure" className="text-destructive" title={session.lastTurnError}>
        {session.lastTurnError}
      </span>,
    ])
  if (session.parentSessionId) rows.push(["Step of", parentTitle ?? "a workflow"])
  if (trash && session.deletedAt) rows.push(["Deleted", when(session.deletedAt)])
  return (
    <div className="flex flex-col gap-2 text-left text-xs">
      <p className="text-[13px] font-medium leading-snug">{session.title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate">{value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  )
}
