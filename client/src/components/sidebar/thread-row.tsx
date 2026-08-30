/* ── One thread, one line ── the row, its info card, and its menus. */
import * as React from "react"
import {
  ExternalLink,
  Link as LinkIcon,
  MoreVertical,
  Pin,
  PinOff,
  Trash2,
  Undo2,
} from "lucide-react"
import { toast } from "sonner"
import { reportError } from "@/lib/errors"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { AgentIcon, ProjectIcon } from "@/components/entity-icon"
import {
  ItemContextMenu,
  renderMenuItems,
  type MenuItemSpec,
} from "@/components/item-context-menu"
import { threadPath } from "@/lib/router"
import { togglePin } from "@/lib/pins"
import { type SessionMeta } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"
import { FLOAT_ACTION, FLOAT_ROW, ROW } from "./scale"

export type ThreadStatus = "idle" | "running" | "waiting"

/** How long a finger has to rest on a row before it is a press, not a tap. */
const LONG_PRESS_MS = 450

/** Hover has to rest this long before the card opens — a pointer crossing
    the list on its way somewhere else must not flash six cards. */
const HOVER_DELAY_MS = 500

/** One thread, one line. The title and — when there is one — a status dot;
    nothing else on the row. The info card is one popover: on desktop it opens
    on hover (Base UI's `openOnHover`, so it also closes when the pointer
    leaves both row and card); on a phone a long press opens it, with the
    row's actions under the card standing in for the right-click menu.

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
  onDelete: (session: SessionMeta) => void
  onRestore: (session: SessionMeta) => void
  onPurge: (session: SessionMeta) => void
}) {
  /* One list feeds both the hover dropdown and the right-click menu. */
  const items = React.useMemo(
    () =>
      trash
        ? trashMenuItems(session, onRestore, onPurge)
        : threadMenuItems(session, pinned, {
            openInNewTab: () => onOpen(session, true),
            onDelete,
          }),
    [session, trash, pinned, onOpen, onDelete, onRestore, onPurge]
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
          keeps the amber dot at the trailing edge — the floating ⋯ covers it
          while the pointer is on the row, which is fine: it is the one row
          you must act on, and a still mark is what says "stopped, for you". */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          (session.exited || trash) && "text-muted-foreground",
          trash && "line-through",
          state === "running" && "harness-shimmer"
        )}
      >
        {session.title}
      </span>
      {state === "waiting" && (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-amber-500" />
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
      className={cn(ROW, FLOAT_ROW, isMobile && "select-none [-webkit-touch-callout:none]")}
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
          {isMobile && (
            <div className="flex flex-col gap-0.5 border-t border-border/60 pt-2">
              {items.map((item, index) =>
                item.type === "separator" ? null : (
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
          )}
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction showOnHover title={`Actions for ${session.title}`} className={FLOAT_ACTION}>
              <MoreVertical />
            </SidebarMenuAction>
          }
        />
        <DropdownMenuContent side="right" align="start" className="w-44">
          {renderMenuItems(items, { Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
        </DropdownMenuContent>
      </DropdownMenu>
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
  const { state: store } = useStore()
  const project = store.projects.find((p) => p.id === session.projectId)
  const profile = store.profiles.find((p) => p.id === session.profileId)?.name
  const agent = store.agents.find((a) => a.id === session.agentId)?.name ?? session.agentId
  const when = (ts: number) =>
    new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
  const status = trash
    ? "In Trash"
    : state === "waiting"
      ? "Needs you"
      : state === "running"
        ? "Running"
        : session.exited
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

/** The row menu for a live thread — Trash rows get their own two items. */
function threadMenuItems(
  session: SessionMeta,
  pinned: boolean,
  handlers: {
    openInNewTab: () => void
    onDelete: (session: SessionMeta) => void
  }
): MenuItemSpec[] {
  return [
    {
      label: pinned ? "Unpin" : "Pin to top",
      icon: pinned ? <PinOff /> : <Pin />,
      onClick: () => togglePin(session.id),
    },
    { label: "Open in new tab", icon: <ExternalLink />, onClick: handlers.openInNewTab },
    {
      label: "Copy link",
      icon: <LinkIcon />,
      onClick: () => {
        navigator.clipboard
          .writeText(new URL(threadPath(session.id), window.location.origin).toString())
          .then(() => toast.success("Link copied"))
          .catch((err) => reportError(err, "Couldn't copy the link"))
      },
    },
    { type: "separator" },
    {
      label: "Delete",
      icon: <Trash2 />,
      destructive: true,
      onClick: () => handlers.onDelete(session),
    },
  ]
}

function trashMenuItems(
  session: SessionMeta,
  restore: (session: SessionMeta) => void,
  purge: (session: SessionMeta) => void
): MenuItemSpec[] {
  return [
    { label: "Restore", icon: <Undo2 />, onClick: () => restore(session) },
    { type: "separator" },
    {
      label: "Delete forever",
      icon: <Trash2 />,
      destructive: true,
      onClick: () => purge(session),
    },
  ]
}
