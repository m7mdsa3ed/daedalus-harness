import { useProjects } from "@/lib/queries/catalog"
/* The transcript's links, built once and shared.
   `ChatPanel` is no longer the only thing that renders a transcript — the
   agents panel draws the same subagent rails, with the same file chips and the
   same sources in them — so the openers live here rather than inside the panel
   that happened to need them first. Two copies would be two answers to "which
   panel does a file open in".

   Null when the thread has no project: without a cwd there is nothing to make
   an agent's absolute path relative to, and `ThreadLinksProvider` renders plain
   text for null, which is the honest fallback. */
import * as React from "react"

import { useDock } from "@/components/workspace/dock"
import { useSessionMeta, useStoreSelect } from "@/lib/store"
import { markReveal } from "@/lib/workspace/reveal"
import { toRelative, type ThreadLinks } from "@/lib/workspace/thread-links"

/** One Browser panel for every source followed out of a transcript, so the
    tenth link read does not leave ten tabs behind. */
const SOURCES_VIEW_ID = "sources"

export function useThreadLinksFor(sessionId: string): ThreadLinks | null {
  const dock = useDock()
  const meta = useSessionMeta(sessionId)
  const projectId = meta?.projectId
  /* The cwd string itself, not the project row: a string is compared by value,
     so this is quiet even across a `projects` refresh that rebuilt the rows
     without changing any directory. */
  const projects = useProjects()
  const cwd = projects.find((project) => project.id === projectId)?.cwd

  return React.useMemo<ThreadLinks | null>(() => {
    if (!projectId) return null
    return {
      projectId,
      /* Everything opened *from* a transcript asks for the side, because the
         thread is what you are reading it against — a file the agent named, a
         diff of what it wrote, a page it cited. On a phone that is a tab in
         front of the thread instead, and once the editor has a group of its own
         the next file lands in it: both are `openPanel`'s call, not this one's
         (see SPLIT_MIN_WIDTH). */
      openFile: (path, line, endLine) => {
        const relative = toRelative(path, cwd)
        if (line) markReveal(projectId, relative, line, { endLine })
        dock.openPanel({ kind: "editor", projectId, path: relative }, { direction: "right" })
      },
      openDiff: (path) => {
        dock.openPanel(
          { kind: "editor", projectId, path: toRelative(path, cwd), comparison: "head" },
          { direction: "right" }
        )
      },
      openUrl: (url) => {
        /* External trust, always — a page an agent found on the web is not the
           project's own dev server, and trust in this dock only ever drops. */
        dock.openPanel(
          { kind: "web", trust: "external", viewId: SOURCES_VIEW_ID, url },
          { direction: "right" }
        )
      },
    }
  }, [cwd, dock, projectId])
}
