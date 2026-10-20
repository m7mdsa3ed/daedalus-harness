/* ── The memoized thread list ── rows plus the hoisted handlers they share. */
import * as React from "react"
import { ChevronRight } from "lucide-react"
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
import { useFold } from "./fold"

type ThreadFold = React.ComponentProps<typeof ThreadRow>["fold"]

/** A thread over its sub threads, foldable by the chevron on its row; the fold
    is remembered on this device beside the project folders'. Open by default. */
function ThreadFamily({
  parent,
  subs,
  row,
}: {
  parent: SessionMeta
  subs: SessionMeta[]
  row: (session: SessionMeta, fold?: ThreadFold) => React.ReactNode
}) {
  const [open, toggle] = useFold(`thread:${parent.id}`, true)
  const fold = React.useMemo(() => ({ open, count: subs.length, toggle }), [open, subs.length, toggle])
  return (
    <>
      {row(parent, fold)}
      {open && (
        /* The indent is the item's, never the menu's: the menu is `w-full`, so
           a margin on it pushed the rows (and their ⋯) past the parent's edge. */
        <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className={NEST}>
          <SidebarMenu>
            {subs.map((child) => (
              <React.Fragment key={child.id}>{row(child)}</React.Fragment>
            ))}
          </SidebarMenu>
        </li>
      )}
    </>
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
  const visible = limit && !expanded ? sessions.slice(0, limit) : sessions
  const hidden = sessions.length - visible.length
  /* The row's dress is read here and handed down as plain props, so a row stays
     memoized on narrow props instead of subscribing to the store itself. */
  const options = useLayoutOptions()
  const headings = grouped && options.sidebarPeriodHeadings && options.sidebarSort !== "title"
  const periodAt = options.sidebarSort === "created" ? (session: SessionMeta) => session.createdAt : activityAt
  const navigate = useNavigate()
  const activeThreadId = useActiveChat()
  const { actions, status, pinSet, projectNames, children } = useSidebarEnv()
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

  const row = (session: SessionMeta, fold?: ThreadFold) => (
    <ThreadRow
      session={session}
      state={trash ? "idle" : status(session)}
      trash={trash}
      pinned={pinSet.has(session.id)}
      showProject={showProject ?? !grouped}
      agentIcon={options.sidebarAgentIcon}
      showAge={options.sidebarShowAge}
      projectLabel={options.sidebarShowProject}
      project={projectNames.get(session.projectId) ?? "Other"}
      handlers={handlers}
      fold={fold}
    />
  )

  let previousLabel: string | null = null
  return (
    <SidebarMenu ref={listRef} onKeyDown={onListKeyDown}>
      {visible.map((session) => {
        const label = headings ? periodLabel(periodAt(session)) : null
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
                className="mt-2 flex h-8 items-center px-3 text-xs font-medium text-sidebar-foreground/70 first:mt-0"
              >
                <span className="truncate">{label}</span>
              </li>
            )}
            {/* Its sub threads (asks, workflow steps), indented under it. Not
                in the trash: a deleted parent took its children with it. */}
            {!trash && children.has(session.id) ? (
              <ThreadFamily parent={session} subs={children.get(session.id)!} row={row} />
            ) : (
              row(session)
            )}
          </React.Fragment>
        )
      })}
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
