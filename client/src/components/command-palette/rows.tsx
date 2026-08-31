/* The rows more than one page draws: a thread, a full-text hit, a project. Each
   is a `PaletteItem` builder rather than a component, so the same row can be
   ranked by `ItemList` on the root page and drawn in declared order by the
   search page without either of them knowing how the other orders things. */
import * as React from "react"
import { FolderIcon, MessageSquareIcon } from "lucide-react"

import { ProjectIcon } from "@/components/entity-icon"
import { snippetParts, type SearchResult } from "@/lib/search"
import { activityAt, type Project, type SessionMeta } from "@/lib/settings"
import { shortAge } from "@/lib/time"
import { cn } from "@/lib/utils"
import type { PaletteItem } from "./list"

/** Project + age, the pair that tells one thread from another with the same
    title. */
function Meta({ project, at }: { project: string; at?: number }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
      <FolderIcon className="size-3" />
      {project}
      {at ? <span className="tabular-nums opacity-70">· {shortAge(at)}</span> : null}
    </span>
  )
}

export function threadItem({
  session,
  group,
  project,
  running,
  onSelect,
  always,
}: {
  session: SessionMeta
  group: string
  project: string
  running: boolean
  onSelect: () => void
  always?: boolean
}): PaletteItem {
  return {
    id: `thread:${session.id}`,
    group,
    title: session.title,
    keywords: `thread ${project} ${session.id}`,
    always,
    icon: <MessageSquareIcon className={session.exited ? "opacity-50" : undefined} />,
    render: (
      <span className={cn("truncate", running && "harness-shimmer text-primary")}>
        {session.title}
      </span>
    ),
    trailing: <Meta project={project} at={activityAt(session)} />,
    onSelect,
  }
}

/** One full-text hit: the thread's title over the snippet with its matches
    emphasised — decoded from marker codepoints into spans, never markup. */
export function messageItem(hit: SearchResult, onSelect: () => void): PaletteItem {
  return {
    id: `message:${hit.sessionId}:${hit.seq}`,
    group: "Messages",
    title: hit.title,
    // Ranked by the server's own FTS score; nothing here re-sorts it.
    always: true,
    className: "items-start",
    icon: <MessageSquareIcon className="mt-0.5" />,
    render: (
      <span className="min-w-0 flex-1">
        <span className="block truncate">{hit.title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {snippetParts(hit.snippet).map((part, i) =>
            part.match ? (
              <span key={i} className="font-semibold text-foreground">
                {part.text}
              </span>
            ) : (
              <React.Fragment key={i}>{part.text}</React.Fragment>
            )
          )}
        </span>
      </span>
    ),
    trailing: <Meta project={hit.projectName || "Other"} at={hit.at} />,
    onSelect,
  }
}

export function projectItem({
  project,
  group,
  onSelect,
  badge,
  lastActivity,
  always,
}: {
  project: Project
  group: string
  onSelect: () => void
  /** "Last used", on the project a bare New thread would have picked. */
  badge?: string
  lastActivity?: number
  always?: boolean
}): PaletteItem {
  return {
    id: `project:${project.id}`,
    group,
    title: project.name,
    keywords: `project workspace ${project.cwd}`,
    always,
    icon: <ProjectIcon project={project} className="size-4" />,
    render: (
      <>
        <span className="truncate">{project.name}</span>
        {badge && (
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
            {badge}
          </span>
        )}
      </>
    ),
    trailing: (
      <span className="ml-auto flex min-w-0 shrink items-center gap-2 text-[11px] text-muted-foreground">
        <span className="truncate font-mono">{project.cwd}</span>
        {lastActivity ? (
          <span className="shrink-0 tabular-nums opacity-70">{shortAge(lastActivity)}</span>
        ) : null}
      </span>
    ),
    onSelect,
  }
}
