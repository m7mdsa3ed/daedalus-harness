/* ── One thread, one line ── the row, its actions, and its menus. */
import * as React from "react"
import { ChevronRight, MoreVertical, UsersIcon, WorkflowIcon, X } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { useIsMobile } from "@/hooks/use-device"
import { ItemContextMenu, renderMenuItems } from "@/components/item-context-menu"
import { AgentIcon } from "@/components/entity-icon"
import { Badge } from "@/components/ui/badge"
import { ThreadInfoCard } from "./thread-info-card"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { threadMenuItems, trashMenuItems } from "@/components/thread-menu"
import { activityAt, childKindOf, type SessionMeta } from "@/lib/settings"
import { threadPath } from "@/lib/router"
import { startRouteDrag } from "@/lib/workspace/route-drag"
import { shortAge } from "@/lib/time"
import type { ThreadActivity } from "@/lib/thread/phase"
import { cn } from "@/lib/utils"
import { FLOAT_ACTION, FLOAT_ROW } from "./scale"

/* The reading a row shows comes from `lib/thread/phase.ts` and is shared with
   the dock tabs and the project page. It used to be declared here as
   `"idle" | "running" | "waiting"`, derived from `turnActive` alone and unable
   to see the connection at all — so a thread whose socket had died thirty
   seconds ago, and was working through its reconnect ladder, read "Idle" in
   every list on screen. It also collided by name with the connection status in
   the store, which made both hard to grep for. */
export type ThreadStatus = ThreadActivity

/** One thread, one line: the agent's mark, the title, and its status or age. Nothing else on the row. The actions live in the
    ⋯ that floats over the title on hover and in the right-click (long-press, on
    a phone) context menu — the same list, built once.

    Memoized on narrow props — the session object (stable between server
    refreshes), three flags and four hoisted callbacks — so the per-token
    sidebar render skips every row whose status did not change. The menu items
    are built here for the same reason: an array of fresh closures per parent
    render would defeat the memo. */
/** The callbacks a row calls, grouped so the list hands over one stable object
    instead of eight props. Memoized by the list; a row reads it by identity. */
export interface ThreadRowHandlers {
  onOpen: (session: SessionMeta) => void
  onRename: (session: SessionMeta) => void
  onDelete: (session: SessionMeta) => void
  onRestore: (session: SessionMeta) => void
  onPurge: (session: SessionMeta) => void
  onPin: (session: SessionMeta) => void
  onHide: (session: SessionMeta) => void
  onToggleNotify: (session: SessionMeta) => void
  onRemoveWorktree?: (session: SessionMeta) => void
  onClose?: (session: SessionMeta) => void
}

export const ThreadRow = React.memo(function ThreadRow({
  session,
  state,
  trash,
  active,
  unread,
  pinned,
  showProject,
  project,
  agentIcon,
  showAge,
  projectLabel,
  handlers,
  fold,
  index,
  before,
  setSize,
  measure,
}: {
  session: SessionMeta
  state: ThreadStatus
  trash: boolean
  /** The thread whose tab is in front (`useActiveChat`), so the row says which
      one you are reading. Read by the list from the dock's published state and
      handed down as a prop, which keeps the row memoized on a boolean instead
      of a store subscription per row. */
  active: boolean
  /** A turn ended here after the reader last looked (the sidebar's
      `useUnreadIds`). The title is what says it — one weight up — rather than
      a mark beside it: the thing that changed is the thread, and a dot at the
      trailing end competes with the age for the one slot the row has left. */
  unread?: boolean
  pinned: boolean
  /** Whether the row names its project. Under a project's own folder it would
      only repeat the folder, so it wears the agent's mark alone. */
  showProject: boolean
  /** The project's name; "Other" when the catalog has no such project. */
  project: string
  /** The reader's row dress (Settings › Appearance › Sidebar). */
  agentIcon: boolean
  showAge: boolean
  /** Name the project on the row itself rather than only in its tooltip. */
  projectLabel: boolean
  handlers: ThreadRowHandlers
  /** Set on a thread with sub threads: a chevron at the row's trailing end
      folds them. `toggle` must be stable — the row is memoized. */
  fold?: { open: boolean; count: number; toggle: (open: boolean) => void }
  /** Its place in a windowed list (`lib/windowed-rows.ts`): the index, the
      margin standing for the rows skipped above it, the list's size (only when
      windowed) and the stable `measureElement`. All memo-safe. */
  index?: number
  before?: number
  setSize?: number
  measure?: (el: Element | null) => void
}) {
  const { onOpen, onRename, onDelete, onRestore, onPurge, onPin, onHide, onToggleNotify, onRemoveWorktree, onClose } = handlers
  /* One list feeds both the ⋯ menu and the right-click menu. */
  /* Delete is Trash, and Trash stops the agent: a turn in motion (or one
     waiting on an answer) is not something to throw away from a menu row —
     stop it first. Disabled with the reason on the row, not hidden. */
  const busy = state === "running" || state === "waiting"
  /* The device hook, not `useSidebar()`: a context read re-renders past
     `memo`, so every row in the list re-rendered on each sidebar toggle. */
  const isMobile = useIsMobile()
  const items = React.useMemo(
    () =>
      trash
        ? trashMenuItems(session, onRestore, onPurge, onRemoveWorktree)
        : threadMenuItems(
            session,
            pinned,
            {
              onRename,
              onDelete,
              onPin,
              onHide,
              onToggleNotify,
              onRemoveWorktree,
            },
            /* A phone folds every split back into one strip, so the row that
               makes one is not offered there (`open-in-menu`). */
            { beside: !isMobile }
          ).map((item) =>
            busy && item.type !== "sub" && item.type !== "separator" && item.type !== "icons" && item.destructive
              ? { ...item, disabled: true, hint: "Stop the turn first" }
              : item
          ),
    [session, trash, pinned, busy, isMobile, onRename, onDelete, onRestore, onPurge, onPin, onHide, onToggleNotify, onRemoveWorktree]
  )
  /* ── One line ──
     The agent's mark, the title, and at the trailing edge the status (a spinner,
     a badge, a glyph) or, when there is none, how long ago the thread last spoke.
     Model, project and the rest are one hover away (the row's card) and in the ⋯ card —
     a second line per row halved how many threads fit. */
  const age = shortAge(activityAt(session))
  const childKind = childKindOf(session)
  const row = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {agentIcon && <AgentIcon agentId={session.agentId} className="size-4 shrink-0" />}
      {/* A sub thread says what it is: the same marks the harness's own MCP
          rows wear (`BUILTIN_MCP_MARKS`) — people for an ask of another agent,
          the workflow glyph for a step. The words are for a screen reader. */}
      {childKind && (
        <>
          {childKind === "workflow" ? (
            <WorkflowIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <UsersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="sr-only">
            {childKind === "workflow" ? "Workflow step: " : childKind === "ask" ? "Ask: " : "Subagent: "}
          </span>
        </>
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          (session.exited || trash) && "text-muted-foreground",
          trash && "line-through",
          /* A turn ended here since the reader last looked: the title itself
             says it, one weight up. It is the only bold title in the list,
             which is the whole of why it reads at a glance, and it costs no
             slot on a row whose trailing edge the age and the ⋯ already share.
             Weight and not a colour, deliberately: a hue in this column means
             a state — amber needs you, red failed — and "there is news" is not
             one of those. Never against a state, which is louder and means
             now rather than since. */
          !trash && unread && "font-semibold",
          /* The status is the title's colour, not a mark beside it: amber for a
             thread waiting on you, red for a failed turn, and a shimmer sweeping
             the letters while a turn runs. */
          !trash && state === "waiting" && "text-warning",
          !trash && state === "failed" && "text-destructive",
          !trash && state === "running" && "harness-shimmer [animation-duration:3.2s]!"
        )}
      >
        {session.title}
        {unread && <span className="sr-only"> Unread</span>}
      </span>
      {/* An aside is flagged on the row: a thread started from a passage of
          another (`asideQuote`), whose card names that thread and quotes the
          passage. The words ride along for a screen reader only — the badge's
          own `title` was a second popover over a row that now has a card. */}
      {session.asideQuote && (
        <Badge variant="secondary">
          Aside
          <span className="sr-only"> on: {session.asideQuote}</span>
        </Badge>
      )}
      {projectLabel && showProject && (
        <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">{project}</span>
      )}
      {/* The ⋯ floats over the age on hover (`FLOAT_ACTION`, painted in the
          row's own hover colour), so nothing is reserved for it. */}
      {showAge && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground transition-opacity group-hover/menu-item:opacity-0">
          {age}
        </span>
      )}
    </span>
  )

  const reading = <ThreadInfoCard session={session} state={state} trash={trash} />

  /* The row itself — one button, whichever of the two menus is wrapped round it. */
  const button = (
    <SidebarMenuButton
      data-thread-id={session.id}
      isActive={active}
      onClick={() => onOpen(session)}
      /* Dragged into the dock, a row is the place it stands for: it lands as
         a tab on a strip, or makes a column beside the group it is dropped
         on (`dock-drop.tsx`). Not on a phone, where the same press is the
         long press that opens this menu. */
      draggable={!trash && !isMobile}
      onDragStart={
        trash || isMobile ? undefined : (event) => startRouteDrag(event, threadPath(session.id))
      }
      /* A finger resting on the row must not raise the browser's own
         callout or native context menu — the one context menu is Base
         UI's, opened on long press. */
      onContextMenu={(event) => {
        if (isMobile) event.preventDefault()
      }}
      className={cn(
        FLOAT_ROW,
        /* A parent's chevron always holds the trailing slot (a button cannot
           sit inside the row's own button), so the age stops short of it. */
        fold && "pr-7!",
        /* A phone has no hover, so the ⋯ (and the close and fold buttons
           beside it) are always drawn: the age stops short of all of them
           instead of sitting under the ⋯. */
        isMobile && (fold && onClose ? "pr-19!" : fold || onClose ? "pr-12!" : "pr-7!"),
        /* A faint wash over the whole row for the two states addressed to
           the reader, a step stronger on hover. The active row keeps its own
           selected ground: the wash and the selection are the same slot, and
           "you are reading this" is the fact that outranks "this needs you",
           which the title's colour and the status still say. */
        !trash && !active && state === "waiting" && "bg-warning/10 hover:bg-warning/15",
        !trash && !active && state === "failed" && "bg-destructive/10 hover:bg-destructive/15",
        isMobile && "select-none [-webkit-touch-callout:none]"
      )}
    >
      {row}
    </SidebarMenuButton>
  )

  return (
    <SidebarMenuItem
      ref={measure}
      data-index={index}
      style={before ? { marginTop: before } : undefined}
      aria-setsize={setSize}
      aria-posinset={setSize != null && index != null ? index + 1 : undefined}
    >
      {/* Hovering a row is a reading, not a wait: the same card the ⋯ opens,
          with no actions in it. It waits a beat so walking the list with the
          pointer does not flash a card per row — and it is not drawn on a
          phone, which has no hover: the ⋯ and the long press are its doors,
          and both open the same card.

          The card wraps the right-click menu and not the other way round:
          `ItemContextMenu` merges its own handlers onto its single child
          through `render`, so that child has to be an element that reaches the
          row's button — and a hover-card root renders no DOM of its own. The
          menu is the row itself either way, no wrapper DOM, and the same list
          as the ⋯ below, so the two cannot drift apart. On a phone its trigger
          is the long press the ⋯ is a finger-reach for. */}
      <HoverCard>
        <ItemContextMenu items={items}>
          {isMobile ? button : <HoverCardTrigger delay={400} closeDelay={120} render={button} />}
        </ItemContextMenu>
        {!isMobile && (
          <HoverCardContent
            side="right"
            align="start"
            sideOffset={8}
            className="w-72 max-w-[calc(var(--float-w)-1rem)] p-3"
          >
            {reading}
          </HoverCardContent>
        )}
      </HoverCard>
      {fold && (
        <SidebarMenuAction
          title={`${fold.open ? "Hide" : "Show"} ${fold.count} sub thread${fold.count === 1 ? "" : "s"}`}
          aria-expanded={fold.open}
          className="text-muted-foreground"
          onClick={(event) => {
            event.stopPropagation()
            fold.toggle(!fold.open)
          }}
        >
          <ChevronRight className={cn("transition-transform duration-200", fold.open && "rotate-90")} />
        </SidebarMenuAction>
      )}
      {onClose && (
        <SidebarMenuAction
          showOnHover
          title={`Close ${session.title}`}
          aria-label={`Close ${session.title}`}
          className={cn(FLOAT_ACTION, fold ? "right-13" : "right-7")}
          onClick={(event) => {
            event.stopPropagation()
            onClose(session)
          }}
        >
          <X />
        </SidebarMenuAction>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuAction showOnHover title={`Actions for ${session.title}`} className={cn(FLOAT_ACTION, fold && "right-7")}>
              <MoreVertical />
            </SidebarMenuAction>
          }
        />
        {/* The ⋯ opens the reading above the actions: the card with the
            thread's status and where it runs, then what to do with it. */}
        <DropdownMenuContent
          side={isMobile ? "bottom" : "right"}
          align={isMobile ? "end" : "start"}
          sideOffset={isMobile ? 8 : 4}
          className="w-72 max-w-[calc(var(--float-w)-1rem)]"
        >
          <div className="px-3 py-2">{reading}</div>
          <DropdownMenuSeparator />
          {renderMenuItems(items, { Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
})
