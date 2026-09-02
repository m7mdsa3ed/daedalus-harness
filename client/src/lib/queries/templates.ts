/* The starters (`GET /api/templates`) and the one write that uses them —
   scaffolding a project from a template. The templates are a catalog read
   like any other; the create is a mutation that patches the projects list
   with the row the server answered and then invalidates it, so the draft
   thread that follows can find its project in the cache before the refetch
   lands (`createSession` reads the catalog, not the response). */
import { useQueryClient } from "@tanstack/react-query"

import { api, type Project, type Template } from "@/lib/settings"
import { useServer } from "@/lib/server-context"
import { projectsKey, templatesKey } from "./keys"
import { useApiMutation, useApiQuery } from "./helpers"

const EMPTY: Template[] = []

export function useTemplates() {
  const settings = useServer()
  const query = useApiQuery<Template[]>(templatesKey(settings), "/api/templates", {
    staleTime: 5 * 60_000,
  })
  return {
    templates: (query.data ?? EMPTY).slice().sort((a, b) => a.sortOrder - b.sortOrder),
    isPending: query.isPending,
    error: query.error,
    refetch: query.refetch,
  }
}

export interface CreateFromTemplateInput {
  /** A starter's id, or null for an empty project the agent builds the stack
      of itself (the row comes back with `templateId: "scratch"` and no dev
      command; the server senses one after the first turn). */
  templateId: string | null
  /** With `templateId` null: the stack the prompt named, for the project's
      AGENTS.md. */
  stack?: string
  name: string
  /** Absolute directory the project is created under; the server's
      `appsDir` when left out. */
  parent?: string
  description?: string
}

export function useCreateFromTemplate() {
  const settings = useServer()
  const qc = useQueryClient()
  return useApiMutation<CreateFromTemplateInput, { project: Project }>(
    [projectsKey(settings)],
    (conn, input) =>
      api<{ project: Project }>(conn, "/api/projects/from-template", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    ({ project }) =>
      qc.setQueryData<Project[]>(projectsKey(settings), (list) =>
        list && !list.some((row) => row.id === project.id) ? [...list, project] : (list ?? [project])
      )
  )
}
