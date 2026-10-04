/* ── One thread, one line ── the row, its actions, and its menus. */
import * as React from "react"
import { GitBranchIcon, MoreVertical, X } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
import { ItemContextMenu, renderMenuItems } from "@/components/item-context-menu"
import { AgentIcon, ProjectIcon } from "@/components/entity-icon"
import { DiffCount } from "@/components/composer/changes-indicator"
import { ChatPanelIcon } from "@/components/workspace/panel-kinds"
import { threadMenuItems, trashMenuItems } from "@/components/thread-menu"
import { activityAt, type SessionMeta } from "@/lib/settings"
import { shortAge } from "@/lib/time"
import { useAgents, useProfiles, useProjects } from "@/lib/queries/catalog"
import { useGitSummary } from "@/lib/queries/git-summary"
import { useStoreSelect } from "@/lib/store"
import type { ThreadActivity } from "@/lib/thread/phase"
import { cn } from "@/lib/utils"
import { FLOAT_ACTION, FLOAT_ROW, ROW_TWO_LINE } from "./scale"

/* The reading a row shows comes from `lib/thread/phase.ts` and is shared with
   the dock tabs and the project page. It used to be declared here as
   `"idle" | "running" | "waiting"`, derived from `turnActive` alone and unable
   to see the connection at all — so a thread whose socket had died thirty
   seconds ago, and was working through its reconnect ladder, read "Idle" in
   every list on screen. It also collided by name with the connection status in
   the store, which made both hard to grep for. */
export type ThreadStatus = ThreadActivity

/** One thread, two lines: the title with its status badge, over the project and
    when the thread last spoke. Nothing else on the row. The actions live in the
    ⋯ that floats over the title on hover and in the right-click (long-press, on
    a phone) context menu — the same list, built once.

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
  showProject,
  onOpen,
  onRename,
  onDelete,
  onRestore,
  onPurge,
  onPin,
  onRemoveWorktree,
  onClose,
}: {
  session: SessionMeta
  state: ThreadStatus
  trash: boolean
  active: boolean
  pinned: boolean
  /** Whether the row names its project. Under a project's own folder it would
      only repeat the folder, so it wears the agent's mark alone. */
  showProject: boolean
  onOpen: (session: SessionMeta) => void
  onRename: (session: SessionMeta) => void
  onDelete: (session: SessionMeta) => void
  onRestore: (session: SessionMeta) => void
  onPurge: (session: SessionMeta) => void
  onPin: (session: SessionMeta) => void
  onRemoveWorktree?: (session: SessionMeta) => void
  onClose?: (session: SessionMeta) => void
}) {
  /* One list feeds both the ⋯ menu and the right-click menu. */
  const items = React.useMemo(
    () =>
      trash
        ? trashMenuItems(session, onRestore, onPurge, onRemoveWorktree)
        : threadMenuItems(session, pinned, {
            onRename,
            onDelete,
            onPin,
            onRemoveWorktree,
          }),
    [session, trash, pinned, onOpen, onRename, onDelete, onRestore, onPurge, onPin, onRemoveWorktree]
  )
  /* The device hook, not `useSidebar()`: a context read re-renders past
     `memo`, so every row in the list re-rendered on each sidebar toggle. */
  const isMobile = useIsMobile()
  /* The second line's first half. A project the catalog has not landed yet reads
     "Other", the same word the orphan folder uses. */
  const project = useProjects().find((p) => p.id === session.projectId)?.name ?? "Other"
  /* The checkout's branch and uncommitted lines — the same readings the footer's
     changes pill gives, for a thread you are not looking at. A worktree thread
     knows its branch before the poll lands. */
  const git = useGitSummary(session.id, !trash && !session.draft)
  const branch = git?.branch ?? session.worktree?.branch ?? null

  /* ── Two lines ──
     The title owns the first line and the status is *beside* it, because the
     status is about the title; the second line says where the thread runs and
     when it last spoke. One line could hold neither once a title was long, and
     the project — which the ⋯ card was the only place to find — is on every row
     here, which is what a list holding several projects needs. */
  const row = (
    <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
      {/* A running turn is the title itself shimmering — the pale band that the
          working line and a live thought already use — rather than a badge
          beside it: the row *is* the thing in motion. A reconcile pulse is the
          opposite: something happening *to* the thread, not in it. */}
      <span
        className={cn(
          "col-start-1 row-start-1 truncate",
          (session.exited || trash) && "text-muted-foreground",
          trash && "line-through",
          state === "running" && "harness-shimmer",
          (state === "reconnecting" || state === "offline") && "animate-pulse"
        )}
      >
        {session.title}
      </span>
      {/* The ⋯ floats over this cell (`FLOAT_ACTION`, `right-1`, a 20px box), so
          a badge clears its footprint — covering a 6px dot on hover was fine,
          covering the two words that say what is wrong with the thread is not.
          `pr-6` is the ⋯'s 24px; a row with no badge reserves nothing, so its
          title still runs to the edge as it did. */}
      <span
        className={cn(
          "col-start-2 row-start-1 flex shrink-0 items-center gap-1.5",
          (state === "waiting" || state === "failed") && "pr-6"
        )}
      >
        <ThreadStateBadge state={state} />
        {(state === "reconnecting" || state === "offline") && (
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-muted-foreground/60" />
        )}
      </span>
      {/* The second line: where it runs, and when it last spoke — the two facts a
          title cannot carry and the ⋯ card was the only place to read. */}
      <span className="col-span-2 row-start-2 flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground">
        {/* The tab strip's own mark — agent over project — so a row and the tab
            it opens are visibly the same thread. Project folders drop the project. */}
        <span aria-hidden title={showProject ? project : undefined} className="shrink-0">
          {showProject ? (
            <ChatPanelIcon agentId={session.agentId} projectId={session.projectId} className="size-3.5" />
          ) : (
            <AgentIcon agentId={session.agentId} className="size-3.5" />
          )}
        </span>
        {/* An aside is flagged on the row: a thread started from a passage of
            another (`asideQuote`), whose card names that thread. */}
        {session.asideQuote && (
          <span className="shrink-0 rounded-sm bg-primary/10 px-1 text-primary" title={`Aside on: ${session.asideQuote}`}>
            Aside
          </span>
        )}
        {/* The branch takes the project's words: the mark says which project,
            and a second line has room for one name. A thread that is in no
            repository keeps the project's. */}
        {branch ? (
          <span className="flex min-w-0 items-center gap-1" title={`Branch: ${branch}`}>
            <GitBranchIcon aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
        ) : (
          showProject && <span className="truncate">{project}</span>
        )}
        {git && git.additions + git.deletions > 0 && (
          <DiffCount added={git.additions} removed={git.deletions} />
        )}
        <span aria-hidden className="opacity-50">
          ·
        </span>
        <span className="shrink-0 tabular-nums">{shortAge(activityAt(session))}</span>
      </span>
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
          isActive={active}
          onClick={() => onOpen(session)}
          /* A finger resting on the row must not raise the browser's own
             callout or native context menu — the one context menu is Base
             UI's, opened on long press. */
          onContextMenu={(event) => {
            if (isMobile) event.preventDefault()
          }}
          className={cn(
            ROW_TWO_LINE,
            FLOAT_ROW,
            onClose && "pr-14!",
            isMobile && "select-none [-webkit-touch-callout:none]"
          )}
        >
          {row}
        </SidebarMenuButton>
      </ItemContextMenu>
      {onClose && (
        <SidebarMenuAction
          showOnHover
          title={`Close ${session.title}`}
          aria-label={`Close ${session.title}`}
          className={cn(FLOAT_ACTION, "right-8")}
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
            <SidebarMenuAction showOnHover title={`Actions for ${session.title}`} className={FLOAT_ACTION}>
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
          className="w-72 max-w-[calc(100vw-1rem)]"
        >
          <div className="px-2 pt-1.5 pb-1">{card}</div>
          <DropdownMenuSeparator />
          {renderMenuItems(items, { Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
})

/** ── The status, as a word rather than a dot ──
    A dot was the whole ornament while the row was one line: there was room for a
    mark and none for a word, and colour was the only thing a 6px disc could
    say. Two lines changed the arithmetic — the second line exists, and a badge
    in the first line's trailing slot costs the title nothing the dot did not
    already cost it — so the two states addressed to the reader say what they
    are. That matters most for `failed`, which was a red dot for "work that
    stopped" and read as decoration on a row whose title gave no hint of it.

    Only the two *asks* get a badge. Running is the title's shimmer, and the
    connection states are a pulse on the title plus a dot, because a label that
    changes every few seconds is noise on every row of a working list. */
function ThreadStateBadge({ state }: { state: ThreadStatus }) {
  if (state === "waiting") {
    return (
      <Badge
        variant="outline"
        title="Waiting on your answer"
        className="h-4 gap-0 border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
      >
        Needs you
      </Badge>
    )
  }
  if (state === "failed") {
    return (
      <Badge variant="destructive" title="The last turn failed" className="h-4 px-1.5 text-[10px]">
        Error
      </Badge>
    )
  }
  return null
}

/** What the row does not say: the thread's status, who runs it and where,
    and when it began. It rides on the ⋯ menu, above the actions. */
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
  const asideOfTitle = useStoreSelect((s) =>
    session.asideQuote && session.forkedFromSessionId
      ? s.sessions.find((row) => row.id === session.forkedFromSessionId)?.title
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
  if (session.asideQuote) {
    rows.push(["Aside of", asideOfTitle ?? "a thread no longer held"])
    rows.push(["On", <span key="on" title={session.asideQuote}>“{session.asideQuote}”</span>])
  }
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