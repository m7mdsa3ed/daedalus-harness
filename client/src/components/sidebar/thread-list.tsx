/* ── The memoized thread list ── rows plus the hoisted handlers they share. */
import * as React from "react"
import { ChevronRight } from "lucide-react"
import { toast } from "sonner"
import { useLocation, useNavigate } from "react-router"
import { reportError } from "@/lib/errors"
import { SidebarMenu, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { useConfirm } from "@/components/confirm-dialog"
import type { Actions } from "@/lib/actions"
import { currentThreadId, threadPath } from "@/lib/router"
import { markNewTab } from "@/lib/session-tabs"
import { usePins } from "@/lib/pins"
import { type SessionMeta } from "@/lib/settings"
import { periodLabel } from "@/lib/time"
import { cn } from "@/lib/utils"
import { MENU } from "./scale"
import { ThreadRow, type ThreadStatus } from "./thread-row"

/* Memoized (the whole list, and each row below): the sidebar re-renders per
   streamed token, and with stable session objects, an identity-stable status
   callback and the hoisted callbacks below, a token leaves every prop here
   untouched — so the rows do not re-render at all. */
export const ThreadList = React.memo(function ThreadList({
  sessions,
  actions,
  status,
  trash = false,
  limit,
  grouped = false,
}: {
  sessions: SessionMeta[]
  actions: Actions
  status: (session: SessionMeta) => ThreadStatus
  /** Rendering the Trash: these threads are deleted, so the row restores
      instead of opening and the menu offers the two ways back out. */
  trash?: boolean
  /** Show this many rows and a "Show more" toggle under them. For the long
      tail — a folder with last winter's threads in it — not for Pinned or
      Recents, which are short by construction. */
  limit?: number
  /** Print a period heading — Today, Yesterday, Previous 7 days, … — above
      each run of rows that falls in it. The list is already newest-first, so
      the buckets come out in order and grouping is one pass over the rows
      that are actually visible: the limit still counts threads, not headings,
      and "Show more" cannot reveal a heading with nothing under it. */
  grouped?: boolean
}) {
  /* Expansion is deliberately not persisted: the reveal answers "is what I am
     looking for down there?" and the answer resets the next visit. */
  const [expanded, setExpanded] = React.useState(false)
  const visible = limit && !expanded ? sessions.slice(0, limit) : sessions
  const hidden = sessions.length - visible.length
  const location = useLocation()
  const navigate = useNavigate()
  const activeThreadId = currentThreadId(location.pathname, location.search)
  const confirm = useConfirm()
  const pins = usePins()
  const pinSet = React.useMemo(() => new Set(pins), [pins])
  const { isMobile, setOpenMobile } = useSidebar()

  /* Delete stops the agent and moves the thread to Trash. Recoverable, but not
     free — the process dies and a running turn dies with it — so it asks, and
     the toast still offers the one-click way back. Wrapped in useCallback (as
     are the three below) so the memoized rows see the same handler across
     renders. */
  const remove = React.useCallback(async (session: SessionMeta) => {
    /* A draft was never started: no process to stop, no server row, and nothing
       for Trash to hold. Discarding it is the whole operation. */
    if (session.draft) {
      if (
        !(await confirm({
          title: "Discard this thread?",
          description:
            "It was never started, so there is no agent to stop and nothing to restore afterwards.",
          confirmLabel: "Discard",
          destructive: true,
        }))
      )
        return
      if (activeThreadId === session.id) void navigate("/")
      void actions.deleteThread(session.id)
      return
    }
    if (
      !(await confirm({
        title: `Delete "${session.title}"?`,
        description:
          "The agent process is stopped and the thread moves to Trash, where it can be restored.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return
    // Leave the route first: a deleted thread has no page to show.
    if (activeThreadId === session.id) void navigate("/")
    actions
      .deleteThread(session.id)
      .then(() =>
        toast("Moved to Trash", {
          description: session.title,
          action: {
            label: "Undo",
            onClick: () => {
              actions
                .restoreThread(session.id)
                .catch((err) => reportError(err, "Couldn't restore the thread"))
            },
          },
        })
      )
      .catch((err) => reportError(err, "Couldn't delete the thread"))
  }, [confirm, activeThreadId, navigate, actions])

  const restore = React.useCallback((session: SessionMeta) => {
    actions.restoreThread(session.id).catch((err) => reportError(err, "Couldn't restore the thread"))
  }, [actions])

  const purge = React.useCallback(async (session: SessionMeta) => {
    if (
      !(await confirm({
        title: `Delete "${session.title}" forever?`,
        description:
          "The harness forgets this thread. Only the agent's own transcript file would still have the conversation.",
        confirmLabel: "Delete forever",
        destructive: true,
      }))
    )
      return
    actions.purgeThread(session.id).catch((err) => reportError(err, "Couldn't delete the thread"))
  }, [confirm, actions])

  const open = React.useCallback((session: SessionMeta, newTab = false) => {
    if (isMobile) setOpenMobile(false)
    if (newTab) markNewTab()
    void navigate(threadPath(session.id))
  }, [isMobile, setOpenMobile, navigate])

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

  return (
    <SidebarMenu ref={listRef} onKeyDown={onListKeyDown} className={MENU}>
      {visible.map((session, index) => {
        const label = grouped ? periodLabel(session.createdAt) : null
        const heading =
          label && (index === 0 || label !== periodLabel(visible[index - 1]!.createdAt))
        return (
          <React.Fragment key={session.id}>
            {heading && (
              /* Not a SidebarGroupLabel: this sits *inside* a menu, between
                 rows, so it is a list item with no control in it — quieter and
                 smaller than a tier's title, which is a fold trigger and the
                 heading of the whole folder. `aria-hidden` would lose the only
                 thing that says which period a row belongs to, so it stays
                 readable and simply is not focusable. */
              <li
                data-slot="sidebar-menu-item"
                data-sidebar="menu-item"
                className="mt-1.5 flex h-6 items-center px-2 text-[10px] font-semibold tracking-[0.06em] text-muted-foreground/80 uppercase first:mt-0"
              >
                <span className="truncate">{label}</span>
              </li>
            )}
            <ThreadRow
              session={session}
              state={trash ? "idle" : status(session)}
              trash={trash}
              active={activeThreadId === session.id}
              pinned={pinSet.has(session.id)}
              onOpen={open}
              onDelete={remove}
              onRestore={restore}
              onPurge={purge}
            />
          </React.Fragment>
        )
      })}
      {/* One toggle row, styled as a quieter thread row rather than a button —
          it expands the index you are already scanning. */}
      {hidden > 0 && (
        <SidebarMenuItem>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-data-[collapsible=icon]:hidden"
          >
            <ChevronRight
              aria-hidden
              className={cn("size-4 shrink-0 transition-transform duration-200", expanded && "rotate-90")}
            />
            <span>{expanded ? "Show less" : `Show ${hidden} more`}</span>
          </button>
        </SidebarMenuItem>
      )}
    </SidebarMenu>
  )
})
