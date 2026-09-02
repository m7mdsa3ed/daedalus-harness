/* The rows more than one page draws: a thread, a full-text hit, a project. Each
   is a `PaletteItem` builder rather than a component, so the same row can be
   ranked by `ItemList` on the root page and drawn in declared order by the
   search page without either of them knowing how the other orders things. */
import * as React from "react"
import { MessageSquareIcon } from "lucide-react"

import { AgentIcon, ProjectIcon } from "@/components/entity-icon"
import { snippetParts, type SearchResult } from "@/lib/search"
import { activityAt, type Project, type SessionMeta } from "@/lib/settings"
import { shortAge } from "@/lib/time"
import type { PaletteItem, PaletteMeta } from "./list"

/** Where a thread lives and when it last moved — the pair that tells one
    thread from another with the same title. The project comes with its mark
    when the store knows it; a search hit only knows the name. */
function threadMeta(
  project: { name: string; logoUrl?: string | null } | string,
  at?: number
): PaletteMeta[] {
  const meta: PaletteMeta[] =
    typeof project === "string"
      ? [{ label: project, icon: <ProjectIcon project={{ name: project }} className="size-3.5" /> }]
      : [{ label: project.name, icon: <ProjectIcon project={project} className="size-3.5" /> }]
  if (at) meta.push({ label: shortAge(at), dim: true })
  return meta
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
  /** The project row when the store has it, else its name. */
  project: Project | string
  running: boolean
  onSelect: () => void
  always?: boolean
}): PaletteItem {
  const projectName = typeof project === "string" ? project : project.name
  return {
    id: `thread:${session.id}`,
    group,
    title: session.title,
    keywords: `thread ${projectName} ${session.id}`,
    always,
    icon: <AgentIcon agentId={session.agentId} className="size-5" />,
    running,
    muted: session.exited && !running,
    badges: session.lastTurnError ? [{ label: "Failed", tone: "danger" }] : undefined,
    meta: threadMeta(project, activityAt(session)),
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
    icon: <MessageSquareIcon />,
    subtitle: snippetParts(hit.snippet).map((part, i) =>
      part.match ? (
        <span key={i} className="font-semibold text-foreground">
          {part.text}
        </span>
      ) : (
        <React.Fragment key={i}>{part.text}</React.Fragment>
      )
    ),
    meta: threadMeta(hit.projectName || "Other", hit.at),
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
  const meta: PaletteMeta[] = [{ label: project.cwd, mono: true }]
  if (lastActivity) meta.push({ label: shortAge(lastActivity), dim: true })
  return {
    id: `project:${project.id}`,
    group,
    title: project.name,
    keywords: `project workspace ${project.cwd}`,
    always,
    icon: <ProjectIcon project={project} className="size-5" />,
    badges: badge ? [{ label: badge, tone: "primary" }] : undefined,
    meta,
    onSelect,
  }
}
