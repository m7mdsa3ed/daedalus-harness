/* ── Folders and foldable tiers ── the group primitives the sidebar stacks. */
import * as React from "react"
import { ChevronRight, FolderIcon, Loader2, PanelsTopLeft, Plus } from "lucide-react"
import { useLocation } from "react-router"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenuAction,
  SidebarMenuButton,
} from "@/components/ui/sidebar"
import { ProjectIcon } from "@/components/entity-icon"
import { createLocalStore } from "@/lib/local-store"
import { projectPath } from "@/lib/router"
import { useActiveChat } from "@/lib/workspace/open-threads"
import { type SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { ACTION, GROUP, GROUP_LABEL, NEST, PROJECT_PAGE_SIZE, ROW, TIER } from "./scale"
import { useSidebarEnv } from "./env"
import { ThreadList } from "./thread-list"

/* Which groups are folded, on this device. One list for every foldable thing —
   a project folder is keyed by its id, Trash by a name no project can have —
   so the sidebar has one fold memory rather than one per kind of group. */
const COLLAPSED_KEY = "ui.collapsedProjects"

const collapsedStore = createLocalStore<string[]>(
  COLLAPSED_KEY,
  (raw) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []),
  []
)

/* Reactive across every instance (and tab): a fold written here is what each
   other reader of the key sees, with no re-read of localStorage per toggle. */
function useFold(key: string, defaultOpen: boolean): [boolean, (open: boolean) => void] {
  const open = React.useSyncExternalStore(
    collapsedStore.subscribe,
    () => collapsedStore.get().includes(key) !== defaultOpen
  )
  const setOpen = React.useCallback(
    (next: boolean) => {
      /* Only the *departure* from the default is stored, so a group that defaults
         closed (Trash) does not need a row in the list to stay closed — and one
         that defaults open does not need one to stay open. */
      const collapsed = collapsedStore.get().filter((id) => id !== key)
      if (next !== defaultOpen) collapsed.push(key)
      collapsedStore.set(collapsed)
    },
    [key, defaultOpen]
  )
  return [open, setOpen]
}

/** A project as a folder row: chevron, name, thread count; its threads
    indented under it when open, and a + on hover that starts a thread in it.
    Fold state is remembered under the project's id — the same key the older
    project groups used, so nothing anyone folded comes back open. */
export function ProjectFolder({
  id,
  name,
  logoUrl,
  sessions,
  onNewThread,
  onOpenProject,
}: {
  id: string
  name: string
  logoUrl?: string
  sessions: SessionMeta[]
  /** Absent for "Other" — a project that no longer exists cannot host one. */
  onNewThread?: () => void
  /** Opens the project's own page. Absent for "Other", for the same reason. */
  onOpenProject?: () => void
}) {
  const [open, toggle] = useFold(id, true)
  /* Rollups: what the folder holds that is moving or asking, said on the
     folder itself so a closed one is still a reading. Same words as the
     filter ("Needs you" is waiting *and* failed). */
  const { status } = useSidebarEnv()
  let running = 0
  let needsYou = 0
  for (const session of sessions) {
    const state = status(session)
    if (state === "running") running++
    else if (state === "waiting" || state === "failed") needsYou++
  }
  const location = useLocation()
  const activeThreadId = useActiveChat()
  const holdsActive = sessions.some((session) => session.id === activeThreadId)
  /* The project's own page is *about* this folder, so the folder is where you
     are — open or closed, unlike the thread case below. */
  const onProjectPage = location.pathname === projectPath(id)

  /* The folder's hover group must NOT enclose its threads: a thread row's ⋯
     and the folder's + both show on `group-hover/menu-item`, and a named
     group matches *any* ancestor, so a folder that was itself the
     `SidebarMenuItem` lit up every child's ⋯ (and its own +) the moment the
     pointer entered the folder. The outer <li> is therefore a plain list
     item and the group is a div around just the folder's own row, with the
     nested list a sibling of that div. */
  return (
    <li data-slot="sidebar-menu-item" data-sidebar="menu-item" className="relative">
      <Collapsible open={open} onOpenChange={toggle}>
        <div className="group/menu-item relative">
        <CollapsibleTrigger
          render={
            <SidebarMenuButton
              size="sm"
              tooltip={name}
              /* The folder takes the active tint only while closed over the
                 routed thread — a pointer to where you are that the row
                 itself, being hidden, cannot give. */
              isActive={onProjectPage || (!open && holdsActive)}
              /* Two hover controls need twice the gutter the primitive
                 reserves for one — the count sits inside it and would land
                 under the overview button otherwise.

                 `!` because the primitive's own `pr-8` arrives from a
                 `group-has-data-[sidebar=menu-action]/menu-item:` variant, which
                 is a two-class specificity and beat a plain `pr-14`: the row
                 reserved 32px, one control's width, and the overview icon at
                 `right-8` (32–52px) sat exactly on the count. The same `!` the
                 scale's `FLOAT_ROW` and `ACTION` already carry, for the same
                 reason. */
              className={cn(
                ROW,
                /* A folder is a heading over rows, not a row: heavier type and
                   a faint ground of its own, so a column of them reads apart
                   from the two-line threads beneath. */
                "bg-sidebar-accent/30 font-semibold text-sidebar-foreground",
                onOpenProject && "pr-14!"
              )}
            />
          }
        >
          {/* Chevron leads, as in a file tree: it is the fold control, and
              leading keeps the trailing corner free for the count and the
              hover +. */}
          <ChevronRight
            aria-hidden
            className={cn(
              "text-muted-foreground transition-transform duration-200",
              open && "rotate-90"
            )}
          />
          {/* The project's mark — the same one the pickers and the settings
              list draw, so a project is recognisable by its picture wherever
              it is named. "Other" has no project to draw. */}
          {onNewThread ? (
            <ProjectIcon project={{ name, logoUrl }} className="size-4" />
          ) : (
            <FolderIcon className="text-muted-foreground" />
          )}
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {!open && needsYou > 0 && (
            <span
              title={`${needsYou} need${needsYou === 1 ? "s" : ""} you`}
              className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-700 tabular-nums dark:text-amber-400"
            >
              {needsYou}
            </span>
          )}
          {!open && running > 0 && (
            <span
              title={`${running} running`}
              className="flex shrink-0 items-center gap-0.5 text-[10px] font-medium text-muted-foreground tabular-nums"
            >
              <Loader2 aria-hidden className="size-2.5! animate-spin" />
              {running}
            </span>
          )}
          {sessions.length > 0 && (
            <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums transition-opacity group-hover/menu-item:opacity-0">
              {sessions.length}
            </span>
          )}
        </CollapsibleTrigger>
        {/* The folder's own row opens and closes it — a click on the name is a
            fold, as in every file tree — so the way *into* the project is a
            control of its own, beside the +. */}
        {onOpenProject && (
          <SidebarMenuAction
            showOnHover
            title={`Open ${name}`}
            onClick={onOpenProject}
            className={cn(ACTION, "right-8")}
          >
            <PanelsTopLeft />
            <span className="sr-only">Open {name}</span>
          </SidebarMenuAction>
        )}
        {onNewThread && (
          <SidebarMenuAction
            showOnHover
            title={`New thread in ${name}`}
            onClick={onNewThread}
            className={ACTION}
          >
            <Plus />
            <span className="sr-only">New thread in {name}</span>
          </SidebarMenuAction>
        )}
        </div>
        <CollapsibleContent className="harness-collapse">
          <div className={NEST}>
            {sessions.length === 0 ? (
              <p className="flex h-8 items-center px-2 text-[11px] text-muted-foreground">
                {onNewThread ? "No threads yet" : "Empty"}
              </p>
            ) : (
              <ThreadList
                sessions={sessions}
                limit={PROJECT_PAGE_SIZE}
                /* A folder is the whole history of one project, so it reads by
                   period — Today, Yesterday, Previous 7 days — the way the
                   flat tiers above it do not need to, being short by
                   construction. */
                grouped
              />
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/** A foldable sidebar tier. Open/closed is remembered per key. */
export function FoldableGroup({
  groupKey,
  label,
  icon,
  count,
  defaultOpen = true,
  expandOn,
  children,
}: {
  groupKey: string
  label: string
  icon?: React.ReactNode
  /** Printed next to the label when the number is something you act on. */
  count?: number
  defaultOpen?: boolean
  /** Open the tier when this key changes, without changing its saved fold preference. */
  expandOn?: string | null
  children: React.ReactNode
}) {
  const [stored, setFold] = useFold(groupKey, defaultOpen)
  /* expandOn opens the tier for now without touching the saved preference. */
  const [forced, setForced] = React.useState(false)
  const open = stored || forced
  const previousExpandOn = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (expandOn && expandOn !== previousExpandOn.current) setForced(true)
    previousExpandOn.current = expandOn ?? null
  }, [expandOn])

  const toggle = (next: boolean) => {
    setForced(false)
    setFold(next)
  }

  return (
    <Collapsible open={open} onOpenChange={toggle}>
      <SidebarGroup className={cn(TIER, GROUP)}>
        <div className="relative">
          <CollapsibleTrigger
            render={
              <SidebarGroupLabel
                className={cn(GROUP_LABEL, "hover:text-sidebar-foreground/70")}
              />
            }
          >
            {icon}
            <span className="truncate">{label}</span>
            {count != null && (
              <span
                className="ml-auto tabular-nums opacity-70"
              >
                {count}
              </span>
            )}
            <ChevronRight
              aria-hidden
              className={cn(
                "shrink-0 transition-transform duration-200",
                count == null && "ml-auto",
                open && "rotate-90"
              )}
            />
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent className="harness-collapse">
          <SidebarGroupContent>{children}</SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  )
}
