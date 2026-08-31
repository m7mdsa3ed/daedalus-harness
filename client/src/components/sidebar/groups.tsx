/* ── Folders and foldable tiers ── the group primitives the sidebar stacks. */
import * as React from "react"
import { ChevronRight, FolderIcon, PanelsTopLeft, Plus } from "lucide-react"
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
import type { Actions } from "@/lib/actions"
import { currentThreadId, projectPath } from "@/lib/router"
import { type SessionMeta } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { ACTION, GROUP, GROUP_LABEL, NEST, PROJECT_PAGE_SIZE, ROW, TIER } from "./scale"
import { ThreadList } from "./thread-list"
import type { ThreadStatus } from "./thread-row"

/* Which groups are folded, on this device. One list for every foldable thing —
   a project folder is keyed by its id, Trash by a name no project can have —
   so the sidebar has one fold memory rather than one per kind of group. */
const COLLAPSED_KEY = "ui.collapsedProjects"

function collapsedGroups(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

function rememberFold(key: string, open: boolean, defaultOpen: boolean) {
  /* Only the *departure* from the default is stored, so a group that defaults
     closed (Trash) does not need a row in the list to stay closed — and one
     that defaults open does not need one to stay open. */
  const collapsed = collapsedGroups().filter((id) => id !== key)
  if (open !== defaultOpen) collapsed.push(key)
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
  } catch {
    // A forgotten fold is not worth throwing out of a click handler.
  }
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
  actions,
  status,
}: {
  id: string
  name: string
  logoUrl?: string
  sessions: SessionMeta[]
  /** Absent for "Other" — a project that no longer exists cannot host one. */
  onNewThread?: () => void
  /** Opens the project's own page. Absent for "Other", for the same reason. */
  onOpenProject?: () => void
  actions: Actions
  status: (session: SessionMeta) => ThreadStatus
}) {
  const [open, setOpen] = React.useState(() => !collapsedGroups().includes(id))
  const toggle = (next: boolean) => {
    setOpen(next)
    rememberFold(id, next, true)
  }
  const location = useLocation()
  const activeThreadId = currentThreadId(location.pathname, location.search)
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
                 under the overview button otherwise. */
              className={cn(ROW, "text-sidebar-foreground/90", onOpenProject && "pr-14")}
            />
          }
        >
          {/* Chevron leads, as in a file tree: it is the fold control, and
              leading keeps the trailing corner free for the count and the
              hover +. In the icon rail only the folder survives. */}
          <ChevronRight
            aria-hidden
            className={cn(
              "text-muted-foreground transition-transform duration-200 group-data-[collapsible=icon]:hidden",
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
          {sessions.length > 0 && (
            <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums transition-opacity group-hover/menu-item:opacity-0 group-data-[collapsible=icon]:hidden">
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
        <CollapsibleContent className="harness-collapse group-data-[collapsible=icon]:hidden">
          <div className={NEST}>
            {sessions.length === 0 ? (
              <p className="flex h-8 items-center px-2 text-[11px] text-muted-foreground">
                {onNewThread ? "No threads yet" : "Empty"}
              </p>
            ) : (
              <ThreadList
                sessions={sessions}
                actions={actions}
                status={status}
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

/** A group-header control: the ✎ and + that sit beside a tier's label. One
    class rather than one per group, because two tiers whose header buttons are
    a pixel apart is exactly what the spacing scale exists to prevent. */
export const HEADER_BUTTON =
  "grid size-4 place-items-center rounded-sm text-muted-foreground transition-colors hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

/** A foldable sidebar tier. Open/closed is remembered per key. */
export function FoldableGroup({
  groupKey,
  label,
  icon,
  count,
  defaultOpen = true,
  nested = false,
  action,
  children,
}: {
  groupKey: string
  label: string
  icon?: React.ReactNode
  /** Printed next to the label when the number is something you act on. */
  count?: number
  defaultOpen?: boolean
  /** A tier inside another tier — Routines and Scheduled inside Automations.
      It drops the inter-tier margin (the parent's own label is already the gap)
      and quiets the label, so the outer group reads as the heading and the two
      inner ones as its halves rather than as three peers. Its fold is still its
      own: the halves are folded independently and remembered independently,
      which is what stops one long list from burying the other. */
  nested?: boolean
  /** A control that belongs to the group itself, not to a row in it — the
      Scheduled group's "+ new". Rendered only on hover, in the slot just
      before the chevron (where the count sits, which yields to it exactly as
      a project folder's count yields to its hover +), so the chevron itself
      stays put and behaves like every other group's. It cannot live inside
      the label, because the label is the fold trigger and a button in a
      button folds and fires at once. */
  action?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(
    () => collapsedGroups().includes(groupKey) !== defaultOpen
  )

  const toggle = (next: boolean) => {
    setOpen(next)
    rememberFold(groupKey, next, defaultOpen)
  }

  return (
    <Collapsible open={open} onOpenChange={toggle}>
      <SidebarGroup className={cn(nested ? "mt-0.5" : TIER, GROUP)}>
        {/* The header row is the hover group, not the label: the action is
            the label's sibling (see above), and a `group-hover` on the label
            alone never reached it. */}
        <div className="group/label relative">
          {action && (
            /* right = label px-2 + chevron size-4 + label gap-1.5. */
            <div className="absolute top-1.5 right-[30px] z-10 flex opacity-0 transition-opacity duration-150 group-hover/label:opacity-100 focus-within:opacity-100 group-data-[collapsible=icon]:hidden">
              {action}
            </div>
          )}
          <CollapsibleTrigger
            render={
              <SidebarGroupLabel
                className={cn(
                  GROUP_LABEL,
                  "hover:text-sidebar-foreground/70",
                  nested && "font-semibold tracking-normal text-sidebar-foreground/60 normal-case"
                )}
              />
            }
          >
            {icon}
            <span className="truncate">{label}</span>
            {count != null && (
              <span
                className={cn(
                  "ml-auto tabular-nums opacity-70 transition-opacity duration-150",
                  action && "group-hover/label:opacity-0 group-focus-within/label:opacity-0"
                )}
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
