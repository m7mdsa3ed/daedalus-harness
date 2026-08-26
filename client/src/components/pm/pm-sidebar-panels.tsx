/* eslint-disable react-refresh/only-export-components */
/* ── The PM sidebar panel ──
   The shell's sidebar body while a /tasks or /b/ route is open (see the
   `panels` record in app-shell). Three shelves of the same cupboard:

     Active     what `GET /api/boards` lists — already in the store, so free
     Templates  ?templates=1
     Archive    ?archived=1

   Only Active is in the store: `refreshBoards` deliberately does not let the
   other shelves overwrite the live list, so the two folds fetch their own rows
   the first time they are opened and keep them locally. They stay folded across
   reloads, like the sidebar's project groups.

   This file also holds the two things the PM pages need but cannot be handed:
   they are rendered by <Routes> with no props, so `usePmActions` rebuilds the
   same Actions object over the active server, and `BoardDot` lives here because
   all three PM entry points draw it and this is the one module of the three
   that is not lazily loaded. */
import * as React from "react"
import { useLocation, useNavigate } from "react-router"
import { ChevronRight, Inbox, LayoutGrid, Plus, SquareKanban } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useActions, type Actions } from "@/lib/actions"
import { reportError } from "@/lib/errors"
import type { BoardSummary } from "@/lib/pm/types"
import { boardPath, currentBoardId, newBoardPath, tasksPath } from "@/lib/router"
import { loadSettings, type ServerSettings } from "@/lib/settings"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

/** Same captions as the thread sidebar — one voice for the whole panel. */
const GROUP_LABEL =
  "h-6 gap-1.5 px-2 text-[10px] font-semibold tracking-[0.08em] uppercase text-sidebar-foreground/45 [&>svg]:size-3"

/**
 * The Actions object for components the router renders without props. The
 * active server cannot change without a full reload (see ServerSwitcher), so
 * reading it once per mount is the whole story.
 */
export function usePmActions(): Actions {
  const settings = React.useMemo(() => loadSettings() as ServerSettings, [])
  return useActions(settings)
}

/** A board's colour, or the muted ring when it has none. */
export function BoardDot({ color, className }: { color: string | null; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2.5 shrink-0 rounded-full bg-muted-foreground/40", className)}
      style={color ? { backgroundColor: color } : undefined}
    />
  )
}

export function PmSidebarPanel({ actions }: { actions: Actions }) {
  const { state } = useStore()
  const location = useLocation()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const activeBoardId = currentBoardId(location.pathname)

  const go = (path: string) => {
    if (isMobile) setOpenMobile(false)
    void navigate(path)
  }

  // The live shelf. Templates are boards too, but they belong to their own fold.
  const active = state.boards.filter(
    (board) => !board.templateFor && !board.archivedAt && !board.deletedAt
  )

  return (
    <>
      <SidebarGroup className="px-2 py-1">
        <SidebarGroupLabel className={GROUP_LABEL}>Create</SidebarGroupLabel>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="New board" onClick={() => go(newBoardPath())}>
                <Plus className="size-4" />
                <span>New board</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="px-2 py-0">
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="All boards"
                isActive={!activeBoardId && location.pathname.startsWith("/tasks")}
                onClick={() => go(tasksPath())}
              >
                <LayoutGrid className="size-4" />
                <span>All boards</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            {/* The notifications inbox is a later milestone; the row is here so
                the panel's shape does not move under people when it lands. */}
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Inbox — coming soon" disabled>
                <Inbox className="size-4" />
                <span>Inbox</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      <SidebarGroup className="mt-2 px-2 py-0">
        <SidebarGroupLabel className={GROUP_LABEL}>
          <span className="truncate">Boards</span>
          <span className="ml-auto tabular-nums opacity-70">{active.length}</span>
        </SidebarGroupLabel>
        <SidebarGroupContent>
          {active.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
              No boards yet.
            </p>
          ) : (
            <BoardRows boards={active} activeBoardId={activeBoardId} onOpen={go} />
          )}
        </SidebarGroupContent>
      </SidebarGroup>

      <Shelf
        id="templates"
        label="Templates"
        actions={actions}
        shelf={{ templates: true }}
        activeBoardId={activeBoardId}
        onOpen={go}
      />
      <Shelf
        id="archive"
        label="Archive"
        actions={actions}
        shelf={{ archived: true }}
        activeBoardId={activeBoardId}
        onOpen={go}
      />
    </>
  )
}

function BoardRows({
  boards,
  activeBoardId,
  onOpen,
  muted = false,
}: {
  boards: BoardSummary[]
  activeBoardId: string | null
  onOpen: (path: string) => void
  muted?: boolean
}) {
  return (
    <SidebarMenu>
      {boards.map((board) => (
        <SidebarMenuItem key={board.id}>
          <SidebarMenuButton
            tooltip={board.name}
            isActive={board.id === activeBoardId}
            onClick={() => onOpen(boardPath(board.id))}
          >
            <SquareKanban className={cn("size-4", muted && "opacity-50")} />
            <span className={cn("truncate", muted && "text-muted-foreground")}>{board.name}</span>
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60 group-data-[collapsible=icon]:hidden">
              {board.keyPrefix}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}

const SHELF_KEY = "ui.pm.openShelves"

function openShelves(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SHELF_KEY) ?? "[]") as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

/** A fold whose rows are not in the store — fetched the first time it opens. */
function Shelf({
  id,
  label,
  actions,
  shelf,
  activeBoardId,
  onOpen,
}: {
  id: string
  label: string
  actions: Actions
  shelf: { archived?: boolean; templates?: boolean }
  activeBoardId: string | null
  onOpen: (path: string) => void
}) {
  const [open, setOpen] = React.useState(() => openShelves().includes(id))
  const [boards, setBoards] = React.useState<BoardSummary[] | null>(null)

  React.useEffect(() => {
    if (!open || boards) return
    let cancelled = false
    actions
      .refreshBoards(shelf)
      .then((rows) => {
        if (!cancelled) setBoards(rows)
      })
      .catch((err) => reportError(err, `Couldn't load ${label.toLowerCase()}`))
    return () => {
      cancelled = true
    }
    // `shelf` is a literal at the call site; the fold's identity is `id`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, boards, actions, id, label])

  const toggle = (next: boolean) => {
    setOpen(next)
    const rest = openShelves().filter((entry) => entry !== id)
    if (next) rest.push(id)
    try {
      localStorage.setItem(SHELF_KEY, JSON.stringify(rest))
    } catch {
      // A forgotten fold is not worth throwing out of a click handler.
    }
  }

  return (
    <Collapsible open={open} onOpenChange={toggle}>
      <SidebarGroup className="mt-2 px-2 py-0">
        <CollapsibleTrigger
          render={
            <SidebarGroupLabel className={cn(GROUP_LABEL, "hover:text-sidebar-foreground/70")} />
          }
        >
          <span className="truncate">{label}</span>
          <ChevronRight
            aria-hidden
            className={cn("ml-auto shrink-0 transition-transform duration-200", open && "rotate-90")}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="harness-collapse">
          <SidebarGroupContent>
            {boards === null ? (
              <p className="px-2 py-3 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                Loading…
              </p>
            ) : boards.length === 0 ? (
              <p className="px-2 py-3 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                Nothing here.
              </p>
            ) : (
              <BoardRows
                boards={boards}
                activeBoardId={activeBoardId}
                onOpen={onOpen}
                muted
              />
            )}
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}
