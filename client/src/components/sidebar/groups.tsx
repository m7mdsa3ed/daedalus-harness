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
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { ReadingCard, readingStamp } from "./thread-info-card"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { openInItems } from "@/components/open-in-menu"
import { useIsMobile } from "@/hooks/use-device"
import { projectPath } from "@/lib/router"
import { startRouteDrag } from "@/lib/workspace/route-drag"
import { activityAt, type SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { NEST, PROJECT_PAGE_SIZE } from "./scale"
import { Badge } from "@/components/ui/badge"
import { useSidebarEnv } from "./env"
import { ThreadList } from "./thread-list"
import { useFold } from "./fold"

/** A project as a folder row: chevron, name, thread count; its threads
    indented under it when open, and a + on hover that starts a thread in it.
    Fold state is remembered under the project's id — the same key the older
    project groups used, so nothing anyone folded comes back open. */
export function ProjectFolder({
  id,
  name,
  logoUrl,
  cwd,
  description,
  sessions,
  onNewThread,
  onOpenProject,
}: {
  id: string
  name: string
  logoUrl?: string
  /** Where the project lives — the folder's hover card names it. Absent for
      "Other", which stands for projects the catalog no longer has. */
  cwd?: string
  /** The project's own note, when it has one. */
  description?: string | null
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
  /* The project's own page is *about* this folder, so the folder is where you
     are — open or closed, unlike the thread case below. */
  const onProjectPage = location.pathname === projectPath(id)
  const isMobile = useIsMobile()
  const page = onOpenProject ? projectPath(id) : null
  /* A folder's own click is a fold, so the two things it stands for — a thread
     started here, and the page itself — live beside it: one hover control each,
     and the same rows here, where a right-click (or a long press) is the way in
     on a narrow screen that has no hover. The last two shapes are the ones every
     place-shaped row in the chrome offers (`open-in-menu`): a tab of its own,
     and a column beside this one. */
  const menu: MenuItemSpec[] = [
    ...(onNewThread
      ? ([{ label: "New thread here", icon: <Plus />, onClick: () => onNewThread() }] satisfies MenuItemSpec[])
      : []),
    ...(page
      ? ([
          { label: "Open page", icon: <PanelsTopLeft />, onClick: () => onOpenProject?.() },
          { type: "separator" },
          ...openInItems(page, { beside: !isMobile }),
        ] satisfies MenuItemSpec[])
      : []),
  ]

  /* Hovering a folder says what the folder's one line cannot: where the
     project lives, what it holds and when it last spoke. The name alone was a
     repeat of the row, so the pointer had nothing to offer. */
  const lastActive = sessions.reduce((at, session) => Math.max(at, activityAt(session)), 0)
  const readingRows: [string, React.ReactNode][] = []
  if (description)
    readingRows.push([
      "Notes",
      <span key="notes" title={description}>
        {description}
      </span>,
    ])
  if (cwd)
    readingRows.push([
      "Path",
      <span key="path" className="font-mono text-xs" title={cwd}>
        {cwd}
      </span>,
    ])
  readingRows.push(["Threads", sessions.length === 0 ? "None yet" : String(sessions.length)])
  if (running > 0) readingRows.push(["Running", String(running)])
  if (needsYou > 0) readingRows.push(["Needs you", String(needsYou)])
  if (lastActive) readingRows.push(["Last active", readingStamp(lastActive)])
  const reading = (
    <ReadingCard
      title={
        <span className="flex items-center gap-1.5">
          {onNewThread ? (
            <ProjectIcon project={{ name, logoUrl }} className="size-4" />
          ) : (
            <FolderIcon className="size-4 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">{name}</span>
        </span>
      }
      rows={readingRows}
    />
  )

  const folderRow = (
    <CollapsibleTrigger
      render={
        <SidebarMenuButton
          tooltip={name}
          isActive={onProjectPage}
          /* Dragged into the dock, the folder is the page it opens: a tab on
             the strip it lands on, or a column beside that group. */
          draggable={!!page && !isMobile}
          onDragStart={
            !page || isMobile ? undefined : (event) => startRouteDrag(event, page)
          }
          /* Two hover controls need twice the gutter the primitive
             reserves for one. `!` because the primitive's own `pr-8`
             arrives from a `group-has-…/menu-item:` variant, a two-class
             specificity that beats a plain `pr-14`. */
          className={cn(
            /* A folder is a heading over rows, not a row: medium weight,
               so a column of them reads apart from the threads beneath. */
            "font-medium",
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
      {/* The words ride along for a screen reader only: the number is a
          tally beside a mark, and the hover card says both in full — the
          badge's own `title` was a second tooltip on a row that now has a
          card, two popovers in the same corner of the screen. */}
      {!open && needsYou > 0 && (
        <Badge className="bg-warning/10 text-warning tabular-nums">
          {needsYou}
          <span className="sr-only"> need you</span>
        </Badge>
      )}
      {!open && running > 0 && (
        <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground tabular-nums">
          <Loader2 aria-hidden className="size-3! animate-spin" />
          {running}
          <span className="sr-only"> running</span>
        </span>
      )}
      {sessions.length > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums transition-opacity group-hover/menu-item:opacity-0">
          {sessions.length}
        </span>
      )}
    </CollapsibleTrigger>
  )

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
        {/* The card wraps the right-click menu rather than the other way round:
            `ItemContextMenu` merges its handlers onto its single child through
            `render`, and a hover-card root renders no DOM to merge onto. */}
        <HoverCard>
          <ItemContextMenu items={menu}>
            {isMobile ? folderRow : <HoverCardTrigger delay={400} closeDelay={120} render={folderRow} />}
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
        {/* The folder's own row opens and closes it — a click on the name is a
            fold, as in every file tree — so the way *into* the project is a
            control of its own, beside the +. */}
        {onOpenProject && (
          <SidebarMenuAction
            showOnHover
            title={`Open ${name}`}
            onClick={onOpenProject}
            className="right-7"
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
          >
            <Plus />
            <span className="sr-only">New thread in {name}</span>
          </SidebarMenuAction>
        )}
        </div>
        <CollapsibleContent className="harness-collapse">
          <div className={NEST}>
            {sessions.length === 0 ? (
              <p className="flex h-9 items-center px-3 text-xs text-muted-foreground">
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
      <SidebarGroup>
        <div className="relative">
          <CollapsibleTrigger
            render={
              <SidebarGroupLabel className="gap-2 rounded-lg hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" />
            }
          >
            {icon}
            <span className="truncate">{label}</span>
            {count != null && (
              <span
                className="ml-auto tabular-nums"
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
