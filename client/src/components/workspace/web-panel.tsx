/* ── Preview ──
   The panel a project file or a file's diff opens in: a mention, a file link
   or a source-control row. It is a viewer and nothing else - there is no
   address bar, no embedded page and no browser. A file is drawn by
   `FilePreview` (by extension, through the project's own routes), a diff by
   `DiffTab`.

   Beside it is the project's working tree (`ProjectFiles`), which is what makes
   the panel somewhere to *navigate* rather than a window onto one path: a click
   there repoints this panel at another file, so the file and the diff are
   places inside one panel rather than panels of their own — the same bargain
   `panelId` already makes by naming the project and not the file.

   The tree is the reader's to hide, and it is not drawn at all where the panel
   is too narrow to hold one: the same rule the file library's explorer uses for
   its own panes. Both callers of that rule measure the *panel*, never the
   window, because a preview squeezed beside a terminal is narrow for the same
   reason a phone is. A descriptor with neither a file nor a diff is legal now
   and is the explorer alone (`parsePanel`). */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import { FileIcon, PanelLeftIcon } from "lucide-react"

import { Empty } from "@/components/empty"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { PanelToolbar } from "@/components/workspace/primitives"
import { useElementWidth } from "@/hooks/use-element-width"
import { previewPrefs, setPreviewPrefs, TREE_WIDTH } from "@/lib/preview-prefs"
import { useProjects } from "@/lib/queries/catalog"
import { FilePreview } from "@/components/workspace/file-preview"
import type { WebDiff } from "@/lib/workspace/panels"
import { DiffTab } from "@/components/workspace/diff-tab"
import { ProjectFiles } from "@/components/workspace/project-tree"

type WebPanelParams = { projectId: string; viewId: string; file?: string; diff?: WebDiff }

/** Below this the panel has no room for a tree beside the file: the tree's own
    minimum (160) plus a preview worth reading. Measured on the panel, never on
    the window — a preview squeezed beside a terminal is narrow for the same
    reason a phone is. */
const TREE_MIN_WIDTH = 420

export function WebPanel({ api, params }: IDockviewPanelProps<WebPanelParams>) {
  const { projectId, file, diff } = params
  const project = useProjects().find((candidate) => candidate.id === projectId)
  const prefs = previewPrefs.use()
  const [root, width] = useElementWidth<HTMLDivElement>()
  /** The tree's width as the divider last left it, kept when it is let go. */
  const treeWidth = React.useRef(prefs.width)

  React.useEffect(() => {
    const shown = diff?.path ?? file
    api.setTitle(shown ? shown.slice(shown.lastIndexOf("/") + 1) : project ? `Preview — ${project.name}` : "Preview")
  }, [api, file, diff, project])

  /* The descriptor IS where the panel is pointed, so opening a file from the
     tree is one write to the same store a restored layout reads. */
  const open = React.useCallback(
    (path: string) => api.updateParameters({ ...params, file: path, diff: undefined }),
    [api, params]
  )

  const roomForTree = width >= TREE_MIN_WIDTH
  const showTree = prefs.explorer && roomForTree
  const toggle = roomForTree ? (
    <Button
      type="button"
      size="icon-xs"
      variant={prefs.explorer ? "secondary" : "ghost"}
      aria-pressed={prefs.explorer}
      title={prefs.explorer ? "Hide the files" : "Show the files"}
      aria-label={prefs.explorer ? "Hide the files" : "Show the files"}
      onClick={() => setPreviewPrefs({ explorer: !prefs.explorer })}
    >
      <PanelLeftIcon />
    </Button>
  ) : null

  const body = diff ? (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        {toggle}
        <span className="truncate font-mono text-xs text-muted-foreground">{diff.path}</span>
      </PanelToolbar>
      <div className="min-h-0 flex-1">
        <DiffTab projectId={projectId} path={diff.path} left={diff.left} right={diff.right} repo={diff.repo} active />
      </div>
    </div>
  ) : file ? (
    <FilePreview projectId={projectId} path={file} leading={toggle} />
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        {toggle}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {project ? `Preview — ${project.name}` : "Preview"}
        </span>
      </PanelToolbar>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty size="sm" icon={FileIcon}>
          {!roomForTree
            ? "This panel is too narrow for the file tree. Open a file from a mention, or widen it."
            : prefs.explorer
              ? "Pick a file in the tree to preview it."
              : "The file tree is hidden. Show it to browse this project."}
        </Empty>
      </div>
    </div>
  )

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col pt-[var(--dock-content-overlap,var(--app-header-h))]">
      {showTree ? (
        /* The divider's width is kept per device: how wide a pane is belongs to
           the reader, not to the conversation or to a layout saved elsewhere. */
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
          onLayoutChanged={(_layout, meta) => {
            if (meta.isUserInteraction) setPreviewPrefs({ width: treeWidth.current })
          }}
        >
          <ResizablePanel
            id="explorer"
            defaultSize={prefs.width}
            minSize={TREE_WIDTH.min}
            maxSize={TREE_WIDTH.max}
            onResize={(size) => (treeWidth.current = Math.round(size.inPixels))}
          >
            <ProjectFiles projectId={projectId} selected={diff?.path ?? file} onOpen={open} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="preview" minSize={240}>
            {body}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-h-0 flex-1">{body}</div>
      )}
    </div>
  )
}
