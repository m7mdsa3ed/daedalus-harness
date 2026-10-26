/* ── Sections and foldable tiers ── the group primitives the sidebar stacks. */
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
import { PROJECT_PAGE_SIZE, SECTION_BODY } from "./scale"
import { Badge } from "@/components/ui/badge"
import { useSidebarEnv } from "./env"
import { ThreadList } from "./thread-list"
import { useFold } from "./fold"

/** A project, as a section of the flat list rather than a folder: a heading
    with the project's own mark, its name and how much of it is moving, over its
    threads — one level, indented no more than a row's own text. "By project"
    used to draw one foldable folder per project with its threads beneath it,
    which made a long list a tree three deep (project → thread → its sub
    threads) and buried every project after the first behind one already open.
    A section says the same thing on one level: the name is the heading, and
    what is under it is what is in it.

    The heading keeps what the folder row carried — the rollups, the + for a new
    thread here, the way into the project's page, the hover card and the drag
    payload — because those were the folder's and are still what a project
    needs. What it does not keep is a fold: a section is always open, and what
    bounds it is its body's own scroll (`SECTION_BODY`).

    Spec: a project's set of threads is *not* listed here — the list under the
    heading is the project's own threads, newest activity first, and offers
    "Show more" past `PROJECT_PAGE_SIZE` exactly as a folder did. */
export function ProjectSection({
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
  /** Where the project lives — the heading's hover card names it. Absent for
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
  /* Rollups: what the project holds that is moving or asking, said on the
     heading so a section scrolled to the top is still a reading. Same words as
     the filter ("Needs you" is waiting *and* failed). */
  const { status } = useSidebarEnv()
  let running = 0
  let needsYou = 0
  for (const session of sessions) {
    const state = status(session)
    if (state === "running") running++
    else if (state === "waiting" || state === "failed") needsYou++
  }
  const location = useLocation()
  /* The project's own page is *about* this section, so the heading is where you
     are while you are on it. */
  const onProjectPage = location.pathname === projectPath(id)
  const isMobile = useIsMobile()
  const page = onOpenProject ? projectPath(id) : null
  /* A heading is not a control that folds, so the two things the project stands
     for — a thread started here, and the page itself — are its hover controls
     and its right-click (long press) rows, the same two shapes every
     place-shaped row in the chrome offers (`open-in-menu`). */
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

  /* Hovering a heading says what its one line cannot: where the project lives,
     what it holds and when it last spoke. */
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

  const heading = (
    <SidebarMenuButton
      tooltip={name}
      isActive={onProjectPage}
      /* Dragged into the dock, the heading is the page it opens: a tab on the
         strip it lands on, or a column beside that group. */
      draggable={!!page && !isMobile}
      onDragStart={!page || isMobile ? undefined : (event) => startRouteDrag(event, page)}
      /* Two hover controls need twice the gutter the primitive reserves for
         one. `!` because the primitive's own `pr-8` arrives from a
         `group-has-…/menu-item:` variant, a two-class specificity that beats a
         plain `pr-14`. */
      className={cn(
        /* A heading over rows, not a row: medium weight and the label's own
           quiet colour, so a column of them reads as the sections it is. */
        "font-medium",
        onOpenProject && "pr-14!"
      )}
    >
      {/* The project's mark leads — the same one the pickers and the settings
          list draw, so a project is recognisable by its picture wherever it is
          named. "Other" has no project to draw. */}
      {onNewThread ? (
        <ProjectIcon project={{ name, logoUrl }} className="size-4" />
      ) : (
        <FolderIcon className="text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {/* The words ride along for a screen reader only: the number is a tally
          beside a mark, and the hover card says both in full. */}
      {needsYou > 0 && (
        <Badge className="bg-warning/10 text-warning tabular-nums">
          {needsYou}
          <span className="sr-only"> need you</span>
        </Badge>
      )}
      {running > 0 && (
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
    </SidebarMenuButton>
  )

  return (
    <SidebarGroup data-project-section={id}>
      {/* The group's own `p-2` is the section's gutter; the heading and its
          rows share it, so the rows line up under the name rather than under
          the mark — one level, and the indentation says "these belong to that
          heading" without a rail, a chevron or a second list. */}
      <div className="group/menu-item relative">
        {/* The card wraps the right-click menu rather than the other way round:
            `ItemContextMenu` merges its handlers onto its single child through
            `render`, and a hover-card root renders no DOM to merge onto. */}
        <HoverCard>
          <ItemContextMenu items={menu}>
            {isMobile ? heading : <HoverCardTrigger delay={400} closeDelay={120} render={heading} />}
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
        {onOpenProject && (
          <SidebarMenuAction showOnHover title={`Open ${name}`} onClick={onOpenProject} className="right-7">
            <PanelsTopLeft />
            <span className="sr-only">Open {name}</span>
          </SidebarMenuAction>
        )}
        {onNewThread && (
          <SidebarMenuAction showOnHover title={`New thread in ${name}`} onClick={onNewThread}>
            <Plus />
            <span className="sr-only">New thread in {name}</span>
          </SidebarMenuAction>
        )}
      </div>
      <SidebarGroupContent>
        {sessions.length === 0 ? (
          <p className="flex h-9 items-center px-3 text-xs text-muted-foreground">
            {onNewThread ? "No threads yet" : "Empty"}
          </p>
        ) : (
          <div className={SECTION_BODY}>
            <ThreadList
              sessions={sessions}
              limit={PROJECT_PAGE_SIZE}
              /* One level, and the level is the project: the heading above says
                 whose threads these are, so a period heading inside would be a
                 second tier in a list that is filed by project, and the rows
                 would repeat the name they already sit under. The flat list
                 groups by period because it has no heading to file under; this
                 one does. */
              showProject={false}
            />
          </div>
        )}
      </SidebarGroupContent>
    </SidebarGroup>
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
