/* Another project. Picking one inserts its cwd as an absolute `@path`, so it is
   an ordinary mention from there on — `server/src/mentions.ts` links any path
   that exists. Projects lead the files, so they are kept few. */
import { Boxes } from "lucide-react"
import { ProjectIcon } from "@/components/entity-icon"
import { useProjects } from "@/lib/queries/catalog"
import type { Project } from "@/lib/settings"
import type { MentionSource } from "../types"

export interface ProjectMatch {
  type: "project"
  id: string
  name: string
  cwd: string
  logoUrl?: string
}

const LIMIT = 5

export const projectsSource: MentionSource<ProjectMatch, Project[]> = {
  id: "project",
  useData: () => useProjects(),
  available: () => true,
  /* A query with a `/` in it is a path being typed, never a project's name. */
  search(query, ctx, projects) {
    if (query.includes("/")) return []
    const q = query.toLowerCase()
    return projects
      .filter((p) => p.id !== ctx.projectId && `${p.name} ${p.cwd}`.toLowerCase().includes(q))
      .slice(0, LIMIT)
      .map((p) => ({ type: "project" as const, id: p.id, name: p.name, cwd: p.cwd, logoUrl: p.logoUrl }))
  },
  key: (match) => match.id,
  insert: (match) => ({ type: "text", text: `@${match.cwd}`, open: false }),
  face: () => null,
  row: (match) => ({
    icon: Boxes,
    mark: <ProjectIcon project={match} className="size-4" />,
    label: match.name,
    aside: match.cwd,
    badge: "project",
  }),
}
