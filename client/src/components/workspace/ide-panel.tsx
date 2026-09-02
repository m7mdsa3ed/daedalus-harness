/* ── The IDE panel ──
   One panel for the editor, the explorer, search and source control, because
   they are one product: VS Code's own workbench, running in this page
   (`lib/ide/boot.ts`), over the harness's workspace and git routes.

   There is exactly one workbench per page — its services are global and
   initialize once — so this component owns a mount point and nothing else.
   The element it shows is built by `startIde` and outlives every instance of
   this component: closing the tab parks it, reopening re-attaches it, and the
   editors, the dirty buffers and the explorer's scroll survive both. That is
   also why the panel is a singleton in the registry.

   `lib/ide/boot` is reached through a dynamic import and never a static one:
   it pulls in the whole workbench, some fourteen megabytes of it, and a
   static import would put that in the app's entry chunk — every reader who
   only reads transcripts would download VS Code. The import is what makes it
   a chunk of its own, which is also the chunk the service worker skips.

   The descriptor carries only the project. What is *open* inside the
   workbench is the workbench's own state, not the dock's — a file, a diff and
   a turn's changes are all requests (`lib/ide/open.ts`), so they focus this
   one panel instead of opening a second. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"

import { PanelEmptyState } from "@/components/workspace/primitives"
import { useProjects } from "@/lib/queries/catalog"
import { describeError } from "@/lib/errors"
import { setIdeProjects } from "@/lib/ide/projects"
import { useTheme } from "@/lib/theme"

export function IdePanel({ api, params }: IDockviewPanelProps<{ projectId: string }>) {
  const { projectId } = params
  const projects = useProjects()
  const project = projects.find((entry) => entry.id === projectId)
  const mount = React.useRef<HTMLDivElement>(null)
  const [error, setError] = React.useState<string | null>(null)
  const { resolved } = useTheme()

  /* The provider resolves an absolute path to a project, and it runs outside
     React — so the list is pushed to it rather than read from the cache. */
  React.useEffect(() => {
    setIdeProjects(projects)
  }, [projects])

  React.useEffect(() => {
    api.setTitle(project ? `${project.name} — IDE` : "IDE")
  }, [api, project])

  React.useEffect(() => {
    if (!project) return
    let live = true
    let attached: HTMLElement | null = null
    void import("@/lib/ide/boot")
      .then(({ openIdeProject, startIde }) => {
        const host = mount.current
        if (!live || !host) return
        const { element, ready } = startIde(project)
        attached = element
        host.appendChild(element)
        return ready.then(() => {
          if (live) return openIdeProject(project)
        })
      })
      .catch((err: unknown) => {
        if (live) setError(describeError(err).title)
      })
    return () => {
      live = false
      /* Parked, not destroyed: the element goes back to its detached holder
         and every editor in it stays exactly as it was. */
      attached?.remove()
    }
  }, [project])

  /* The workbench measures its container only on a *window* resize — that
     is the one signal VS Code's layout listens for, since in its own page the
     window is the container. Here the container is a dock panel, which the
     dock resizes freely (a split, a drag on the sash, the sidebar opening)
     without the window moving at all. So a size change on the mount point is
     reported as one, and the workbench re-measures. Nothing else sizes it: the
     workbench sets its own width and height in pixels from what it measures,
     which is why a stale measurement reads as the panel being too narrow. */
  React.useEffect(() => {
    const host = mount.current
    if (!host) return
    const observer = new ResizeObserver(() => {
      window.dispatchEvent(new Event("resize"))
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  /* Only ever *follows* the app — it never boots the workbench, so a reader
     who has not opened the IDE does not download it by changing theme. */
  React.useEffect(() => {
    void import("@/lib/ide/boot").then(({ ideStarted, setIdeDark }) => {
      if (ideStarted()) void setIdeDark(resolved === "dark")
    })
  }, [resolved])

  if (!project)
    return <PanelEmptyState>This project is no longer available.</PanelEmptyState>
  if (error) return <PanelEmptyState>{error}</PanelEmptyState>

  return <div ref={mount} className="relative h-full w-full overflow-hidden" />
}
