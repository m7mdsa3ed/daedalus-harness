/* ── The memoized thread list ── rows plus the hoisted handlers they share. */
import * as React from "react"
import { ChevronRight } from "lucide-react"
import { useNavigate } from "react-router"
import { SidebarMenu, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { useThreadRowActions } from "@/components/thread-menu"
import { threadPath } from "@/lib/router"
import { focusOpenChat, useActiveChat } from "@/lib/workspace/open-threads"
import { activityAt, type SessionMeta } from "@/lib/settings"
import { periodLabel } from "@/lib/time"
import { cn } from "@/lib/utils"
import { MENU } from "./scale"
import { useSidebarEnv } from "./env"
import { ThreadRow, type ThreadRowHandlers } from "./thread-row"

/* Memoized (the whole list, and each row below): the sidebar re-renders per
   streamed token, and with stable session objects, an identity-stable status
   callback and the hoisted callbacks below, a token leaves every prop here
   untouched — so the rows do not re-render at all. */
export const ThreadList = React.memo(function ThreadList({
  sessions,
  trash = false,
  limit,
  grouped = false,
  onClose,
  revealActive = false,
}: {
  sessions: SessionMeta[]
  onClose?: (session: SessionMeta) => void
  /** Keep the active row in view for the dock's Opened tier. */
  revealActive?: boolean
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
  const navigate = useNavigate()
  const activeThreadId = useActiveChat()
  const { actions, status, pinSet, held, unread, projectNames } = useSidebarEnv()
  const { isMobile, setOpenMobile } = useSidebar()

  /* Delete stops the agent and moves the thread to Trash. Recoverable, but not
     free — the process dies and a running turn dies with it — so it asks, and
     the toast still offers the one-click way back. The three handlers are the
     header menu's too (components/thread-menu), which is why they are a hook
     rather than three closures here; memoized inside it, so the memoized rows
     see the same handler across renders. */
  const { rename, remove, restore, purge, pin, removeWorktree } = useThreadRowActions(actions, {
    activeThreadId,
    onLeave: () => void navigate("/"),
  })

  const open = React.useCallback((session: SessionMeta) => {
    if (isMobile) setOpenMobile(false)
    if (focusOpenChat(session.id)) return
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
      onRemoveWorktree: removeWorktree,
      onClose,
    }),
    [open, rename, remove, restore, purge, pin, removeWorktree, onClose]
  )

  /* Arrow keys walk focus between the rows of this list. A local handler that
     preventDefaults, which is use-hotkey's documented contract for a local
     owner beating a global binding — though ↑/↓ are only otherwise bound on
     the composer textarea, so nothing conflicts. The rows are ordinary
     focusable buttons (Tab still enters and leaves the list as before); no
     roving tabindex, on purpose. */
  const listRef = React.useRef<HTMLUListElement>(null)
  React.useEffect(() => {
    if (
      !revealActive ||
      !activeThreadId ||
      !sessions.some((session) => session.id === activeThreadId)
    )
      return
    const frame = requestAnimationFrame(() => {
      const row = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>("[data-thread-id]") ?? []
      ).find((candidate) => candidate.dataset.threadId === activeThreadId)
      row?.scrollIntoView({ block: "nearest", inline: "nearest" })
    })
    return () => cancelAnimationFrame(frame)
  }, [activeThreadId, revealActive, sessions])

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

  let previousLabel: string | null = null
  return (
    <SidebarMenu ref={listRef} onKeyDown={onListKeyDown} className={MENU}>
      {visible.map((session) => {
        const label = grouped ? periodLabel(activityAt(session)) : null
        const heading = label && label !== previousLabel
        previousLabel = label
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
              held={held.has(session.id)}
              unread={unread.has(session.id)}
              showProject={!grouped}
              project={projectNames.get(session.projectId) ?? "Other"}
              handlers={handlers}
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
