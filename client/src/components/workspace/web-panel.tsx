/* ── Preview ──
   The panel a project file or a file's diff opens in: a mention, a file link
   or a source-control row. It is a file viewer and editor and nothing else -
   there is no address bar, no embedded page and no browser. A file is drawn by
   `FilePreview` (by extension, through the project's own routes), a diff by
   `DiffTab`.

   Beside it — in a *thread's* dock, never in an outer tab — is the project's
   working tree (`ProjectFiles`), which is what makes the panel somewhere to
   *navigate* rather than a window onto one path: a click there repoints this
   same panel at another file (the descriptor is the state, through
   `api.updateParameters`), so the file and the diff are places inside one panel
   rather than panels of their own — the same bargain `panelId` already makes by
   naming the project and not the file. A Preview with neither a file nor a diff
   is the explorer alone, which is what the thread's `+ → Files` opens.

   The tree stands beside the file in either dock. It used to be a thread's
   alone, which left a Preview opened from a source-control row or a mention in
   an outer tab a window onto one path with nowhere to go; the project's files
   are the project's, not the thread's. The tree is the reader's to hide.

   **The panel holds open files, not one.** `tabs` in the descriptor are the
   files it has open and `file` the one in front, so a restored layout comes
   back with them; a click in the tree opens a file as a tab (or goes to it),
   and a diff is a place beside them that is left by picking a file. The order
   things were looked at in is the panel's own history (`lib/workspace/
   preview-nav.ts`): back and forward walk it, and it is not saved. A file
   renamed or deleted from the tree moves or closes its tab, its history entry
   and its unsaved edit together — they are this panel's state, so this panel
   does it, on the tree's say-so.

   **An unsaved edit is held outside the editor** (`lib/workspace/edit-drafts`),
   so a tab switch loses nothing, and closing the panel — or a tab — asks first.

   What fits beside the preview is measured on the *panel*, never the window,
   because a preview squeezed beside a terminal is narrow for the same reason a
   phone is — the rule the file library's explorer uses for its own panes. Below
   the width a tree needs, the panel does not give up: it becomes two screens,
   the tree and then the file, and the toolbar's toggle is the way back to the
   tree. A phone had no files at all before that, on the one gesture that asks
   for them. */
import * as React from "react"
import type { IDockviewPanelProps } from "dockview-react"
import { ArrowLeftIcon, ArrowRightIcon, FileIcon, PanelLeftIcon, XIcon } from "lucide-react"

import { useConfirm } from "@/components/confirm-dialog"
import { Empty } from "@/components/empty"
import { Button } from "@/components/ui/button"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { PanelToolbar } from "@/components/workspace/primitives"
import { useElementWidth } from "@/hooks/use-element-width"
import { previewPrefs, setPreviewPrefs, TREE_WIDTH } from "@/lib/preview-prefs"
import { useProjects } from "@/lib/queries/catalog"
import { cn } from "@/lib/utils"
import { dropDrafts, getDraft, isDirty, moveDrafts, useDirtyPaths } from "@/lib/workspace/edit-drafts"
import {
  EMPTY_HISTORY,
  addTab,
  canGoBack,
  canGoForward,
  closeTab,
  dropFromHistory,
  dropTabs,
  goBack,
  goForward,
  historyPath,
  remap,
  remapHistory,
  tabLabels,
  visit,
  within,
  type PreviewHistory,
} from "@/lib/workspace/preview-nav"
import { FilePreview } from "@/components/workspace/file-preview"
import { useDock } from "@/components/workspace/dock-context"
import { panelId, type WebDiff } from "@/lib/workspace/panels"
import { DiffTab } from "@/components/workspace/diff-tab"
import { ProjectFiles } from "@/components/workspace/project-tree"

type WebPanelParams = { projectId: string; viewId: string; file?: string; diff?: WebDiff; tabs?: string[] }

/** Below this the panel has no room for a tree *beside* the file: the tree's
    own minimum (160) plus a preview worth reading. Under it the tree takes the
    panel whole instead of not being drawn. */
const TREE_MIN_WIDTH = 420

export function WebPanel({ api, params }: IDockviewPanelProps<WebPanelParams>) {
  const { projectId, file, diff } = params
  /* What the descriptor holds is what the panel shows: a file pointed at from
     outside (a mention, a second click on a source-control row) arrives as
     `file` alone and becomes a tab here. */
  const tabs = React.useMemo(() => (file ? addTab(params.tabs ?? [], file) : (params.tabs ?? [])), [params.tabs, file])
  const project = useProjects().find((candidate) => candidate.id === projectId)
  const prefs = previewPrefs.use()
  const dock = useDock()
  const confirm = useConfirm()
  const dirty = useDirtyPaths(projectId)
  const [root, width] = useElementWidth<HTMLDivElement>()
  const [history, setHistory] = React.useState<PreviewHistory>(EMPTY_HISTORY)
  const [editing, setEditing] = React.useState<ReadonlySet<string>>(new Set())
  const [line, setLine] = React.useState<{ path: string; line: number } | null>(null)
  /** The tree's width as the divider last left it, kept when it is let go. */
  const treeWidth = React.useRef(prefs.width)

  React.useEffect(() => {
    const shown = diff?.path ?? file
    api.setTitle(
      shown
        ? shown.slice(shown.lastIndexOf("/") + 1)
        : project
          ? `Files — ${project.name}`
          : "Files"
    )
  }, [api, file, diff, project])

  /* Every place the panel reaches is a visit, whatever door it came in by —
     except back and forward, which move along the history and so must not add
     to it. */
  const walking = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!file) return
    if (walking.current !== null) {
      const expected = walking.current
      walking.current = null
      if (expected === file) return
    }
    setHistory((h) => visit(h, file))
  }, [file])

  /* The descriptor IS where the panel is pointed, so opening a file from the
     tree is one write to the same store a restored layout reads. */
  const write = React.useCallback(
    (patch: Partial<WebPanelParams>) => api.updateParameters({ ...params, ...patch }),
    [api, params]
  )
  const open = React.useCallback(
    (path: string, at?: number) => {
      if (at !== undefined) setLine({ path, line: at })
      write({ file: path, diff: undefined, tabs: addTab(tabs, path) })
    },
    [write, tabs]
  )
  /** Back to the tree, on a panel too narrow to hold both: the same one write,
      pointed at nothing, which is also what `Files` opens. */
  const showTreeAgain = React.useCallback(() => write({ file: undefined, diff: undefined }), [write])

  const go = (next: PreviewHistory) => {
    const path = historyPath(next)
    if (!path) return
    walking.current = path
    setHistory(next)
    write({ file: path, diff: undefined, tabs: addTab(tabs, path) })
  }

  /** Close a tab, asking first when it holds an edit nobody saved. */
  const close = React.useCallback(
    async (path: string) => {
      if (isDirty(getDraft(projectId, path))) {
        const ok = await confirm({
          title: `Close ${path.slice(path.lastIndexOf("/") + 1)}?`,
          description: "It has unsaved changes, and closing it throws them away.",
          confirmLabel: "Discard changes",
          destructive: true,
        })
        if (!ok) return
        dropDrafts(projectId, path)
      }
      const next = closeTab(tabs, file, path)
      setEditing((set) => new Set([...set].filter((p) => p !== path)))
      write({ tabs: next.tabs, file: next.file, diff: next.file ? undefined : diff })
    },
    [confirm, projectId, tabs, file, diff, write]
  )

  /* The tree renamed or deleted something: what this panel holds under it
     follows or goes. */
  const renamed = React.useCallback(
    (from: string, to: string) => {
      moveDrafts(projectId, from, to)
      setHistory((h) => remapHistory(h, from, to))
      setEditing((set) => new Set([...set].map((p) => remap(p, from, to))))
      write({
        tabs: tabs.map((tab) => remap(tab, from, to)),
        file: file ? remap(file, from, to) : undefined,
        diff: diff && within(diff.path, from) ? undefined : diff,
      })
    },
    [projectId, tabs, file, diff, write]
  )
  const deleted = React.useCallback(
    (path: string) => {
      const gone = (p: string) => within(p, path)
      dropDrafts(projectId, path)
      setHistory((h) => dropFromHistory(h, gone))
      setEditing((set) => new Set([...set].filter((p) => !gone(p))))
      const next = dropTabs(tabs, file, gone)
      write({ tabs: next.tabs, file: next.file, diff: diff && gone(diff.path) ? undefined : diff })
    },
    [projectId, tabs, file, diff, write]
  )

  /* Closing the whole panel with edits unsaved asks once, for all of them. */
  const heldDirty = React.useRef(dirty)
  heldDirty.current = dirty.filter((path) => tabs.includes(path))
  React.useEffect(
    () =>
      dock.registerCloseGuard(panelId({ kind: "web", projectId, viewId: params.viewId }), async () => {
        const unsaved = heldDirty.current
        if (unsaved.length === 0) return true
        const ok = await confirm({
          title: unsaved.length === 1 ? "Close with an unsaved file?" : `Close with ${unsaved.length} unsaved files?`,
          description: `${unsaved.map((p) => p.slice(p.lastIndexOf("/") + 1)).join(", ")} ${unsaved.length === 1 ? "has" : "have"} changes that are not saved.`,
          confirmLabel: "Discard changes",
          destructive: true,
        })
        if (ok) for (const path of unsaved) dropDrafts(projectId, path)
        return ok
      }),
    [dock, confirm, projectId, params.viewId]
  )

  const wide = width >= TREE_MIN_WIDTH
  /** A phone, or a preview docked beside a terminal: the tree and the file are
      two screens inside one panel, never one beside the other — so the narrow
      panel ignores the hide-the-tree preference, which is about a pane. */
  const narrow = !wide
  const showing = diff?.path ?? file
  const treeScreen = narrow && !showing
  /* Back on the tree, the file just left is still the row the tree marks, even
     though the descriptor has been pointed at nothing — a ref, because it is a
     hand-off between two screens of this panel and not a fact to restore. */
  const lastOpen = React.useRef<string | undefined>(undefined)
  React.useLayoutEffect(() => {
    if (showing) lastOpen.current = showing
  }, [showing])
  const marked = showing ?? (narrow ? lastOpen.current : undefined)

  const toggle = wide ? (
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
  ) : narrow ? (
    /* Narrow, the tree is the other screen rather than a pane beside this one,
       so the same mark navigates instead of hiding. */
    <Button
      type="button"
      size="icon-xs"
      variant={showing ? "secondary" : "ghost"}
      aria-pressed={!showing}
      title="Files"
      aria-label="Files"
      onClick={showTreeAgain}
    >
      <PanelLeftIcon />
    </Button>
  ) : null

  const nav = (
    <>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!canGoBack(history)}
        title="Back"
        aria-label="Back"
        onClick={() => go(goBack(history))}
      >
        <ArrowLeftIcon />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!canGoForward(history)}
        title="Forward"
        aria-label="Forward"
        onClick={() => go(goForward(history))}
      >
        <ArrowRightIcon />
      </Button>
    </>
  )
  const leading = (
    <>
      {toggle}
      {nav}
    </>
  )
  const editingFile = !!file && editing.has(file)

  const body = diff ? (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        {leading}
        <span className="truncate font-mono text-xs text-muted-foreground">{diff.path}</span>
      </PanelToolbar>
      <div className="min-h-0 flex-1">
        <DiffTab projectId={projectId} path={diff.path} left={diff.left} right={diff.right} repo={diff.repo} active />
      </div>
    </div>
  ) : file ? (
    <FilePreview
      projectId={projectId}
      path={file}
      leading={leading}
      editing={editingFile}
      onEditingChange={(on) =>
        setEditing((set) => {
          const next = new Set(set)
          if (on) next.add(file)
          else next.delete(file)
          return next
        })
      }
      line={line?.path === file ? line.line : undefined}
    />
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        {leading}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {project ? `Files — ${project.name}` : "Files"}
        </span>
      </PanelToolbar>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Empty size="sm" icon={FileIcon}>
          {prefs.explorer ? "Pick a file in the tree to preview it." : "The file tree is hidden. Show it to browse this project."}
        </Empty>
      </div>
    </div>
  )

  const strip = tabs.length > 0 && (
    <div role="tablist" aria-label="Open files" className="flex shrink-0 overflow-x-auto border-b bg-muted/30">
      {tabLabels(tabs).map((tab) => {
        const active = !diff && tab.path === file
        const unsaved = dirty.includes(tab.path)
        return (
          <div
            key={tab.path}
            role="tab"
            aria-selected={active}
            title={tab.path}
            className={cn(
              "group/tab flex h-8 shrink-0 items-center gap-1 border-r pl-2.5 pr-1 text-xs",
              active ? "bg-background font-medium" : "text-muted-foreground hover:bg-muted/60"
            )}
          >
            <button type="button" className="flex min-w-0 max-w-40 items-center gap-1.5 outline-none" onClick={() => open(tab.path)}>
              <span className="truncate">{tab.name}</span>
              {tab.hint && <span className="truncate text-[11px] text-muted-foreground">{tab.hint}</span>}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.name}`}
              title={unsaved ? "Close - has unsaved changes" : "Close"}
              className="flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-muted"
              onClick={() => void close(tab.path)}
            >
              {unsaved ? <span className="size-1.5 rounded-full bg-warning group-hover/tab:hidden" /> : null}
              <XIcon className={cn("size-3", unsaved && "hidden group-hover/tab:block")} />
            </button>
          </div>
        )
      })}
    </div>
  )

  const content = (
    <div className="flex h-full min-h-0 flex-col">
      {strip}
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  )

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col pt-[var(--dock-content-overlap,var(--app-header-h))]">
      {treeScreen ? (
        /* One screen, the whole panel: the tree's own header is the toolbar, so
           there is nothing above it to repeat the word "Files". */
        <div className="min-h-0 flex-1">
          <ProjectFiles projectId={projectId} selected={marked} onOpen={open} onRenamed={renamed} onDeleted={deleted} />
        </div>
      ) : wide && prefs.explorer ? (
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
            <ProjectFiles projectId={projectId} selected={marked} onOpen={open} onRenamed={renamed} onDeleted={deleted} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="preview" minSize={240}>
            {content}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="min-h-0 flex-1">{content}</div>
      )}
    </div>
  )
}
