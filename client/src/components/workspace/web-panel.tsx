/* ── Preview ──
   The panel a project file or a file's diff opens in: a mention, a file link
   or a source-control row. It is a viewer and nothing else - there is no
   address bar, no embedded page and no browser. A file is drawn by
   `FilePreview` (by extension, through the project's own routes), a diff by
   `DiffTab`. A descriptor with neither is not restored (`parsePanel`). */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"

import { PanelToolbar } from "@/components/workspace/primitives"
import { useProjects } from "@/lib/queries/catalog"
import { FilePreview } from "@/components/workspace/file-preview"
import type { WebDiff } from "@/lib/workspace/panels"
import { DiffTab } from "@/components/workspace/diff-tab"

type WebPanelParams = { projectId: string; viewId: string; file?: string; diff?: WebDiff }

export function WebPanel({ api, params }: IDockviewPanelProps<WebPanelParams>) {
  const { projectId, file, diff } = params
  const project = useProjects().find((candidate) => candidate.id === projectId)

  React.useEffect(() => {
    const shown = diff?.path ?? file
    api.setTitle(shown ? shown.slice(shown.lastIndexOf("/") + 1) : project ? `Preview — ${project.name}` : "Preview")
  }, [api, file, diff, project])

  if (diff)
    return (
      <div className="flex h-full min-h-0 flex-col pt-[var(--dock-content-overlap,var(--app-header-h))]">
        <PanelToolbar>
          <span className="truncate font-mono text-xs text-muted-foreground">{diff.path}</span>
        </PanelToolbar>
        <div className="min-h-0 flex-1">
          <DiffTab projectId={projectId} path={diff.path} left={diff.left} right={diff.right} repo={diff.repo} active />
        </div>
      </div>
    )

  if (file) return <FilePreview projectId={projectId} path={file} />

  return null
}
