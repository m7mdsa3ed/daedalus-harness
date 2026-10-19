/* ── One thread, one line ── the row, its actions, and its menus. */
import * as React from "react"
import { ChevronRight, MoreVertical, X } from "lucide-react"
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
import { ThreadInfoCard } from "./thread-info-card"
import { threadMenuItems, trashMenuItems } from "@/components/thread-menu"
import { activityAt, type SessionMeta } from "@/lib/settings"
import { shortAge } from "@/lib/time"
import type { ThreadActivity } from "@/lib/thread/phase"
import { cn } from "@/lib/utils"
import { ACTION, FLOAT_ACTION, FLOAT_ROW, ROW } from "./scale"

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
  onRemoveWorktree?: (session: SessionMeta) => void
  onClose?: (session: SessionMeta) => void
}

export const ThreadRow = React.memo(function ThreadRow({
  session,
  state,
  trash,
  pinned,
  showProject,
  project,
  agentIcon,
  showAge,
  projectLabel,
  handlers,
  fold,
}: {
  session: SessionMeta
  state: ThreadStatus
  trash: boolean
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
}) {
  const { onOpen, onRename, onDelete, onRestore, onPurge, onPin, onRemoveWorktree, onClose } = handlers
  /* One list feeds both the ⋯ menu and the right-click menu. */
  /* Delete is Trash, and Trash stops the agent: a turn in motion (or one
     waiting on an answer) is not something to throw away from a menu row —
     stop it first. Disabled with the reason on the row, not hidden. */
  const busy = state === "running" || state === "waiting"
  /* What the second line used to say, as the row's tooltip. */
  const reason = trash ? null : state === "waiting" ? "Needs you" : state === "failed" ? "Error — the last turn failed" : null
  const detail = [reason, session.model, showProject ? project : null].filter(Boolean).join(" · ")
  const items = React.useMemo(
    () =>
      trash
        ? trashMenuItems(session, onRestore, onPurge, onRemoveWorktree)
        : threadMenuItems(session, pinned, {
            onRename,
            onDelete,
            onPin,
            onRemoveWorktree,
          }).map((item) =>
            busy && item.type !== "sub" && item.type !== "separator" && item.type !== "icons" && item.destructive
              ? { ...item, disabled: true, hint: "Stop the turn first" }
              : item
          ),
    [session, trash, pinned, busy, onRename, onDelete, onRestore, onPurge, onPin, onRemoveWorktree]
  )
  /* The device hook, not `useSidebar()`: a context read re-renders past
     `memo`, so every row in the list re-rendered on each sidebar toggle. */
  const isMobile = useIsMobile()
  /* ── One line ──
     The agent's mark, the title, and at the trailing edge the status (a spinner,
     a badge, a glyph) or, when there is none, how long ago the thread last spoke.
     Model, project and the rest are one hover away (the row's tooltip) and in
     the ⋯ card — a second line per row halved how many threads fit. */
  const age = shortAge(activityAt(session))
  const row = (
    <span className="flex min-w-0 flex-1 items-center gap-2" title={detail}>
      {agentIcon && <AgentIcon agentId={session.agentId} className="size-3.5 shrink-0" />}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          (session.exited || trash) && "text-muted-foreground",
          trash && "line-through",
          /* The status is the title's colour, not a mark beside it: amber for a
             thread waiting on you, red for a failed turn, and a shimmer sweeping
             the letters while a turn runs. */
          !trash && state === "waiting" && "text-amber-700 dark:text-amber-400",
          !trash && state === "failed" && "text-destructive",
          !trash && state === "running" && "harness-shimmer [animation-duration:3.2s]!"
        )}
      >
        {session.title}
      </span>
      {/* An aside is flagged on the row: a thread started from a passage of
          another (`asideQuote`), whose card names that thread. */}
      {session.asideQuote && (
        <span className="shrink-0 rounded-sm bg-primary/10 px-1 text-[10px] text-primary" title={`Aside on: ${session.asideQuote}`}>
          Aside
        </span>
      )}
      {projectLabel && showProject && (
        <span className="max-w-[35%] shrink-0 truncate text-[11px] text-muted-foreground/70">{project}</span>
      )}
      {/* The ⋯ floats over the age on hover (`FLOAT_ACTION`, painted in the
          row's own hover colour), so nothing is reserved for it. */}
      {showAge && (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground transition-opacity group-hover/menu-item:opacity-0">
          {age}
        </span>
      )}
    </span>
  )

  const card = <ThreadInfoCard session={session} state={state} trash={trash} />

  return (
    <SidebarMenuItem>
      {/* The right-click menu is the row itself — no wrapper DOM — and it is
          the same list as the ⋯ below, so the two cannot drift apart. On a
          phone its trigger is the long press the ⋯ is a finger-reach for. */}
      <ItemContextMenu items={items}>
        <SidebarMenuButton
          data-thread-id={session.id}
          size="sm"
          onClick={() => onOpen(session)}
          /* A finger resting on the row must not raise the browser's own
             callout or native context menu — the one context menu is Base
             UI's, opened on long press. */
          onContextMenu={(event) => {
            if (isMobile) event.preventDefault()
          }}
          className={cn(
            ROW,
            FLOAT_ROW,
            /* A parent's chevron always holds the trailing slot (a button cannot
               sit inside the row's own button), so the age stops short of it. */
            fold && "pr-7!",
            /* A faint wash over the whole row for the two states addressed to
               the reader, a step stronger on hover. */
            !trash && state === "waiting" && "bg-amber-500/10 hover:bg-amber-500/15",
            !trash && state === "failed" && "bg-destructive/10 hover:bg-destructive/15",
            isMobile && "select-none [-webkit-touch-callout:none]"
          )}
        >
          {row}
        </SidebarMenuButton>
      </ItemContextMenu>
      {fold && (
        <SidebarMenuAction
          title={`${fold.open ? "Hide" : "Show"} ${fold.count} sub thread${fold.count === 1 ? "" : "s"}`}
          aria-expanded={fold.open}
          className={cn(ACTION, "text-muted-foreground")}
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
          className={cn(FLOAT_ACTION, fold ? "right-13" : "right-8")}
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
          <div className="px-2 pt-1.5 pb-1">{card}</div>
          <DropdownMenuSeparator />
          {renderMenuItems(items, { Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
})
