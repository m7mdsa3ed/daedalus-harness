/* ── The memoized thread list ── rows plus the hoisted handlers they share. */
import * as React from "react"
import { ChevronRight, Loader2, WorkflowIcon } from "lucide-react"
import { useNavigate } from "react-router"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { useThreadRowActions } from "@/components/thread-menu"
import { threadPath } from "@/lib/router"
import { useActiveChat } from "@/lib/workspace/open-threads"
import { useLayoutOptions } from "@/lib/layout-options"
import { activityAt, type SessionMeta } from "@/lib/settings"
import { periodLabel } from "@/lib/time"
import { cn } from "@/lib/utils"
import { NEST } from "./scale"
import { useSidebarEnv } from "./env"
import { ThreadRow, type ThreadRowHandlers } from "./thread-row"
import { useFold, useFolded } from "./fold"
import { useFocusedRow, useWindowedRows } from "@/lib/windowed-rows"

type ThreadFold = React.ComponentProps<typeof ThreadRow>["fold"]

/** Where a row sits in the (possibly windowed) list — see `lib/windowed-rows.ts`. */
interface RowSlot {
  index: number
  before: number
  measure: (el: Element | null) => void
  setSize?: number
}

type ListItem =
  | { kind: "heading"; key: string; label: string }
  | { kind: "row"; key: string; session: SessionMeta; subs?: SessionMeta[] }
  | { kind: "subs"; key: string; parent: SessionMeta; subs: SessionMeta[] }

/** A thread over its sub threads, foldable by the chevron on its row; the fold
    is remembered on this device beside the project folders'. Open by default.
    The sub threads themselves are the list's next item (`subs`), so a windowed
    list can measure and skip them like any other row. */
function FamilyRow({
  parent,
  count,
  row,
  slot,
}: {
  parent: SessionMeta
  count: number
  row: (session: SessionMeta, fold?: ThreadFold, slot?: RowSlot) => React.ReactNode
  slot: RowSlot
}) {
  const [open, toggle] = useFold(`thread:${parent.id}`, true)
  const fold = React.useMemo(() => ({ open, count, toggle }), [open, count, toggle])
  return row(parent, fold, slot)
}

/** What a sub thread block draws: an ask or a step with no run as a row of its
    own, a workflow run's steps as one foldable group at the place its first
    step stands. */
type SubEntry =
  | { kind: "thread"; session: SessionMeta }
  | { kind: "run"; id: string; name: string; steps: SessionMeta[] }

function subEntries(subs: SessionMeta[]): SubEntry[] {
  const out: SubEntry[] = []
  const runs = new Map<string, Extract<SubEntry, { kind: "run" }>>()
  for (const session of subs) {
    if (session.childKind !== "workflow" || !session.childRunId) {
      out.push({ kind: "thread", session })
      continue
    }
    let run = runs.get(session.childRunId)
    if (!run) {
      run = { kind: "run", id: session.childRunId, name: session.childRunName || "Workflow", steps: [] }
      runs.set(session.childRunId, run)
      out.push(run)
    }
    run.steps.push(session)
  }
  return out
}

/** One workflow run: its steps folded under a single row, shut by default
    because a fan-out is a dozen threads nobody reads one by one. The fold is
    remembered beside the others (`fold.ts`). The row reads the worst of its
    steps — amber for one waiting on you, a spinner while any runs, red when
    one failed — so a shut group still says when it needs you. */
function RunGroup({
  run,
  row,
}: {
  run: Extract<SubEntry, { kind: "run" }>
  row: (session: SessionMeta) => React.ReactNode
}) {
  const [open, toggle] = useFold(`run:${run.id}`, false)
  const { status } = useSidebarEnv()
  const states = run.steps.map((step) => status(step))
  const waiting = states.includes("waiting")
  const running = states.includes("running")
  const failed = states.includes("failed")
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        data-run-group
        onClick={() => toggle(!open)}
        aria-expanded={open}
        title={`${open ? "Hide" : "Show"} ${run.steps.length} workflow step${run.steps.length === 1 ? "" : "s"}`}
        className={cn(
          "pr-3!",
          waiting && "bg-warning/10 hover:bg-warning/15",
          !waiting && failed && "bg-destructive/10 hover:bg-destructive/15"
        )}
      >
        <WorkflowIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="sr-only">Workflow: </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            waiting && "text-warning",
            !waiting && failed && "text-destructive",
            !waiting && running && "harness-shimmer [animation-duration:3.2s]!"
          )}
        >
          {run.name}
        </span>
        {running && <Loader2 aria-hidden className="size-3! shrink-0 animate-spin text-muted-foreground" />}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{run.steps.length}</span>
        <ChevronRight
          aria-hidden
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-200", open && "rotate-90")}
        />
      </SidebarMenuButton>
      {open && (
        <ul className={NEST} data-nest data-sidebar="menu">
          {run.steps.map((step) => (
            <React.Fragment key={step.id}>{row(step)}</React.Fragment>
          ))}
        </ul>
      )}
    </SidebarMenuItem>
  )
}

/* Memoized (the whole list, and each row below): the sidebar re-renders per
   streamed token, and with stable session objects, an identity-stable status
   callback and the hoisted callbacks below, a token leaves every prop here
   untouched — so the rows do not re-render at all. */
export const ThreadList = React.memo(function ThreadList({
  sessions,
  trash = false,
  limit,
  grouped = false,
  showProject,
  onClose,
}: {
  sessions: SessionMeta[]
  onClose?: (session: SessionMeta) => void
  /** Rendering the Trash: these threads are deleted, so the row restores
      instead of opening and the menu offers the two ways back out. */
  trash?: boolean
  /** Show this many rows and a "Show more" toggle under them. For the long
      tail — a folder with last winter's threads in it — not for Pinned or
      Recents, which are short by construction. */
  limit?: number
  /** Print a period heading — Today, Yesterday, Previous 7 days, … — above
      each run of rows that falls in it. The list is already newest-first, so
      the buckets come out in order (sorting by title, or the reader's
      "Period headings" switch, prints none) and grouping is one pass over the rows
      that are actually visible: the limit still counts threads, not headings,
      and "Show more" cannot reveal a heading with nothing under it. */
  grouped?: boolean
  /** Name the project on each row. Defaults to the opposite of `grouped`: a
      folder's own list would only repeat the folder, a flat list needs it. */
  showProject?: boolean
}) {
  /* Expansion is deliberately not persisted: the reveal answers "is what I am
     looking for down there?" and the answer resets the next visit. */
  const [expanded, setExpanded] = React.useState(false)
  const visible = React.useMemo(
    () => (limit && !expanded ? sessions.slice(0, limit) : sessions),
    [sessions, limit, expanded]
  )
  const hidden = sessions.length - visible.length
  /* The row's dress is read here and handed down as plain props, so a row stays
     memoized on narrow props instead of subscribing to the store itself. */
  const options = useLayoutOptions()
  const headings = grouped && options.sidebarPeriodHeadings && options.sidebarSort !== "title"
  const byCreated = options.sidebarSort === "created"
  const navigate = useNavigate()
  const activeThreadId = useActiveChat()
  const { actions, status, pinSet, projectNames, children, unread } = useSidebarEnv()
  const { isMobile, setOpenMobile } = useSidebar()

  /* Delete stops the agent and moves the thread to Trash. Recoverable, but not
     free — the process dies and a running turn dies with it — so it asks, and
     the toast still offers the one-click way back. The three handlers are the
     header menu's too (components/thread-menu), which is why they are a hook
     rather than three closures here; memoized inside it, so the memoized rows
     see the same handler across renders. */
  const { rename, remove, restore, purge, pin, hide, removeWorktree } = useThreadRowActions(actions, {
    activeThreadId,
    onLeave: () => void navigate("/"),
  })

  const open = React.useCallback((session: SessionMeta) => {
    if (isMobile) setOpenMobile(false)
    void navigate(threadPath(session.id))
  }, [isMobile, setOpenMobile, navigate])

  const handlers = React.useMemo<ThreadRowHandlers>(
    () => ({
      onOpen: open,
      onRename: rename,
      onDelete: remove,
      onRestore: restore,
      onPurge: purge,
      onPin: pin,
      onHide: hide,
      onRemoveWorktree: removeWorktree,
      onClose,
    }),
    [open, rename, remove, restore, purge, pin, hide, removeWorktree, onClose]
  )

  /* Arrow keys walk focus between the rows of this list. A local handler that
     preventDefaults, which is use-hotkey's documented contract for a local
     owner beating a global binding — though ↑/↓ are only otherwise bound on
     the composer textarea, so nothing conflicts. The rows are ordinary
     focusable buttons (Tab still enters and leaves the list as before); no
     roving tabindex, on purpose. */
  const listRef = React.useRef<HTMLUListElement>(null)

  const onListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const root = listRef.current
    if (!root) return
    const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-sidebar="menu-button"]'))
    const index = rows.indexOf(document.activeElement as HTMLElement)
    if (index === -1 || rows.length < 2) return
    event.preventDefault()
    rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length]?.focus()
  }

  const row = (session: SessionMeta, fold?: ThreadFold, slot?: RowSlot) => {
    /* A sub thread wears its own pair of switches (Settings › Appearance ›
       Sub threads); the rest of the dress is the list's. */
    const sub = !!session.parentSessionId && !trash
    return (
    <ThreadRow
      session={session}
      state={trash ? "idle" : status(session)}
      trash={trash}
      unread={!trash && unread.has(session.id)}
      pinned={pinSet.has(session.id)}
      showProject={showProject ?? !grouped}
      agentIcon={sub ? options.sidebarSubAgentIcon : options.sidebarAgentIcon}
      showAge={sub ? options.sidebarSubAge : options.sidebarShowAge}
      projectLabel={options.sidebarShowProject}
      project={projectNames.get(session.projectId) ?? "Other"}
      handlers={handlers}
      fold={fold}
      index={slot?.index}
      before={slot?.before}
      setSize={slot?.setSize}
      measure={slot?.measure}
    />
    )
  }

  /* The list as flat items — period headings, rows, and each open family's sub
     threads as one item after its parent — so a windowed slice still knows
     which heading a row is under and what its neighbours are. */
  const folded = useFolded()
  /* "Active" keeps what is doing something or needs you — and the thread in
     front of you, so the one you opened never vanishes from under the caret. */
  const subMode = options.sidebarSubThreads
  const visibleSubs = React.useCallback(
    (subs: SessionMeta[] | undefined) => {
      if (!subs || subMode === "all") return subs
      if (subMode === "off") return undefined
      const live = subs.filter((sub) => {
        const state = status(sub)
        return sub.id === activeThreadId || state === "running" || state === "waiting" || state === "failed"
      })
      return live.length ? live : undefined
    },
    [subMode, status, activeThreadId]
  )
  const items = React.useMemo(() => {
    const out: ListItem[] = []
    const seen = new Set<string>()
    let previous: string | null = null
    for (const session of visible) {
      if (headings) {
        const label = periodLabel(byCreated ? session.createdAt : activityAt(session))
        if (label !== previous) {
          out.push({ kind: "heading", key: seen.has(label) ? `h:${label}:${session.id}` : `h:${label}`, label })
          seen.add(label)
        }
        previous = label
      }
      /* Its sub threads (asks, workflow steps), indented under it. Not in the
         trash: a deleted parent took its children with it. */
      const subs = !trash ? visibleSubs(children.get(session.id)) : undefined
      out.push({ kind: "row", key: session.id, session, subs })
      if (subs && !folded.includes(`thread:${session.id}`)) {
        out.push({ kind: "subs", key: `s:${session.id}`, parent: session, subs })
      }
    }
    return out
  }, [visible, headings, byCreated, children, folded, trash, visibleSubs])

  /* Focus is pinned (with its focusable neighbours, the first and the last
     row) so the focused row never unmounts under the caret and the DOM walk
     above always finds the row it moves to, wrap included. A heading holds no
     button, so the pins step over headings. */
  const [focus, onListFocus] = useFocusedRow(items.length, (i) => items[i].key)
  const nearest = (from: number, step: 1 | -1) => {
    for (let i = from; i >= 0 && i < items.length; i += step) if (items[i].kind !== "heading") return i
    return undefined
  }
  const w = useWindowedRows({
    count: items.length,
    threshold: 100,
    list: listRef,
    scroller: () => listRef.current?.closest<HTMLElement>('[data-sidebar="content"]') ?? null,
    estimateSize: (i) => {
      const item = items[i]
      /* 36px rows (24 compact); a sub-thread block is its rows, their gaps
         (4px, 2 compact) and NEST's py-1 (py-0.5). */
      const rowH = options.sidebarCompact ? 24 : 36
      const gap = options.sidebarCompact ? 2 : 4
      return item.kind === "heading"
        ? i ? 40 : 32
        : item.kind === "subs"
          ? subEntries(item.subs).length * (rowH + gap) + gap
          : rowH
    },
    getItemKey: (i) => items[i].key,
    gap: 4,
    measured: true,
    pin: [
      nearest(0, 1),
      nearest(items.length - 1, -1),
      focus == null ? undefined : nearest(focus - 1, -1),
      focus,
      focus == null ? undefined : nearest(focus + 1, 1),
    ],
  })
  const setSize = w.windowed ? items.length : undefined

  return (
    <SidebarMenu ref={listRef} onKeyDown={onListKeyDown} onFocus={onListFocus}>
      {w.rows.map(({ index, key, before }) => {
        const item = items[index]
        const place = {
          ref: w.measure,
          "data-index": index,
          style: before ? { marginTop: before } : undefined,
          "aria-setsize": setSize,
          "aria-posinset": setSize != null ? index + 1 : undefined,
        }
        if (item.kind === "heading") {
          return (
            /* Not a SidebarGroupLabel: this sits *inside* a menu, between
               rows, so it is a list item with no control in it — quieter and
               smaller than a tier's title, which is a fold trigger and the
               heading of the whole folder. `aria-hidden` would lose the only
               thing that says which period a row belongs to, so it stays
               readable and simply is not focusable. Padding, not a margin, for
               the air above it: a windowed list measures border boxes, and
               `first:` would match whichever row the window starts at. */
            <li
              key={key}
              {...place}
              data-slot="sidebar-menu-item"
              data-sidebar="menu-item"
              className={cn(
                "flex items-center px-3 text-xs font-medium text-sidebar-foreground/70",
                index === 0 ? "h-8" : "h-10 pt-2"
              )}
            >
              <span className="truncate">{item.label}</span>
            </li>
          )
        }
        if (item.kind === "subs") {
          return (
            /* The indent is the item's, never the menu's: the menu is `w-full`, so
               a margin on it pushed the rows (and their ⋯) past the parent's edge. */
            <li key={key} {...place} data-slot="sidebar-menu-item" data-sidebar="menu-item" data-nest className={NEST}>
              <SidebarMenu>
                {subEntries(item.subs).map((entry) =>
                  entry.kind === "run" ? (
                    <RunGroup key={`run:${entry.id}`} run={entry} row={row} />
                  ) : (
                    <React.Fragment key={entry.session.id}>{row(entry.session)}</React.Fragment>
                  )
                )}
              </SidebarMenu>
            </li>
          )
        }
        const slot: RowSlot = { index, before, measure: w.measure, setSize }
        return item.subs ? (
          <FamilyRow key={key} parent={item.session} count={item.subs.length} row={row} slot={slot} />
        ) : (
          <React.Fragment key={key}>{row(item.session, undefined, slot)}</React.Fragment>
        )
      })}
      {w.after > 0 && <li aria-hidden style={{ height: w.after }} />}
      {/* One toggle row, styled as a quieter thread row rather than a button —
          it expands the index you are already scanning. */}
      {hidden > 0 && (
        <SidebarMenuItem>
          <SidebarMenuButton
            onClick={() => setExpanded((value) => !value)}
            className="text-muted-foreground group-data-[collapsible=icon]:hidden"
          >
            <ChevronRight
              aria-hidden
              className={cn("transition-transform duration-200", expanded && "rotate-90")}
            />
            <span>{expanded ? "Show less" : `Show ${hidden} more`}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      )}
    </SidebarMenu>
  )
})
