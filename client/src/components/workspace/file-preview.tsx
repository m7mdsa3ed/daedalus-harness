/* ── A project file, drawn in the Preview panel ──
   What a mention or a file link opens. Read through the project's own routes
   (`/file` for text, `/file-raw` for bytes), so it reaches only what those
   routes let it reach. Drawn by extension (`previewKind`):

   - an image is an <img>, which renders even an SVG inertly;
   - a video is the browser's own player on a blob;
   - a PDF is the browser's own viewer on a blob — not sandboxed, because
     Chrome refuses to draw a PDF in a sandboxed frame, and a PDF runs no page
     script;
   - HTML is `srcDoc` in a frame with scripts but **no same-origin**, like the
     web preview. It is the one file, so what it links to relatively does not
     load; a dev server is the way to see the page whole;
   - Word and Excel (`lib/office-preview.ts`) are converted to a page in an
     empty-sandbox frame; PowerPoint is drawn as slides in a scriptless frame;
   - CSV/TSV is a table in the same empty-sandbox frame;
   - markdown is `MarkdownDocument`, the transcript's own pass with heading
     ids and in-panel anchor links; anything else is highlighted
     text, or a line saying why there is none.

   A text file can be edited where it is drawn: the pencil swaps the viewer for
   `FileEditor` (Monaco), and an unsaved edit is shown here too rather than the
   stale text on disk. The viewer follows the disk — an event on its path
   re-reads the file silently, so a file an agent is writing does not need a
   reload. */
import * as React from "react"
import { ArrowLeftIcon, CopyIcon, FileIcon, PencilIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Empty } from "@/components/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { CodeLinesSkeleton } from "@/components/ui/skeletons"
import { Highlighted } from "@/components/tool-parts"
import { MarkdownDocument } from "@/components/prose"
import { copyText } from "@/components/step-row"
import { FileEditor } from "@/components/workspace/file-editor"
import { PanelToolbar } from "@/components/workspace/primitives"
import { ErrorNote } from "@/components/error-note"
import { captureError, type InlineError } from "@/lib/errors"
import { previewKind } from "@/lib/file-preview"
import { csvHtml, officeHtml, renderSlides } from "@/lib/office-preview"
import { isDirty, useDraft } from "@/lib/workspace/edit-drafts"
import { readFile, readFileBytes, type WorkspaceFile } from "@/lib/workspace/fs-api"
import { watchProject } from "@/lib/workspace/watch"

const VIDEO_MIME: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogv: "video/ogg" }

type Loaded =
  | { state: "loading" }
  | { state: "error"; error: InlineError | null }
  | { state: "text"; file: WorkspaceFile }
  | { state: "url"; url: string }
  | { state: "office"; html: string }
  | { state: "slides"; data: ArrayBuffer }

export function FilePreview({
  projectId,
  path,
  onBack,
  leading,
  editing = false,
  onEditingChange,
  line,
}: {
  projectId: string
  path: string
  /** Back to the page the panel was showing; absent when there is none. */
  onBack?: () => void
  /** Drawn first in the toolbar, ahead of the file's own mark — the Preview
      panel's explorer toggle. */
  leading?: React.ReactNode
  /** The file is open in the editor rather than the viewer. */
  editing?: boolean
  /** Absent where nothing can be edited; the pencil is not drawn. */
  onEditingChange?: (editing: boolean) => void
  /** A line to land on when the editor opens. */
  line?: number
}) {
  const kind = previewKind(path)
  const [loaded, setLoaded] = React.useState<Loaded>({ state: "loading" })
  /* Bumped by the watch stream: a re-read that keeps what is on screen until
     the new text lands, where a path change starts from the skeleton. */
  const [reads, setReads] = React.useState(0)
  const draft = useDraft(projectId, path)
  const shown = React.useRef("")

  React.useEffect(() => {
    if (editing) return
    const controller = new AbortController()
    let url: string | null = null
    if (shown.current !== `${projectId}\0${path}`) {
      shown.current = `${projectId}\0${path}`
      setLoaded({ state: "loading" })
    }
    const bytes = bytesKind(kind)
    ;(bytes
      ? readFileBytes(projectId, path, controller.signal).then(async (data): Promise<Loaded> => {
          if (kind === "office") {
            const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
            const buf = data.slice().buffer
            return ext === "pptx" ? { state: "slides", data: buf } : { state: "office", html: await officeHtml(buf, ext) }
          }
          /* Bytes carry no type. A raster image is sniffed; an SVG, a PDF and a
             video are not, so those are named. */
          const type =
            kind === "pdf" ? "application/pdf"
            : kind === "video" ? VIDEO_MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "video/mp4"
            : /\.svg$/i.test(path) ? "image/svg+xml"
            : ""
          url = URL.createObjectURL(new Blob([data as BlobPart], { type }))
          return { state: "url", url }
        })
      : readFile(projectId, path, controller.signal).then((file): Loaded => ({ state: "text", file }))
    ).then(setLoaded, (err) => {
      if (!controller.signal.aborted) setLoaded({ state: "error", error: captureError(err, "Couldn't open the file") })
    })
    return () => {
      controller.abort()
      if (url) URL.revokeObjectURL(url)
    }
  }, [projectId, path, kind, reads, editing])

  /* The disk moving under the viewer. Only a text file is followed: re-reading
     a video or a PDF on every write to it would restart the player. */
  React.useEffect(() => {
    if (editing || bytesKind(kind)) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = watchProject(projectId, (batch) => {
      if (!batch.overflow && !batch.events.some((event) => event.path === path)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setReads((n) => n + 1), 250)
    })
    return () => {
      if (timer) clearTimeout(timer)
      stop()
    }
  }, [projectId, path, kind, editing])

  const name = path.slice(path.lastIndexOf("/") + 1)
  const editable = !!onEditingChange && !bytesKind(kind)
  const unsaved = isDirty(draft)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar>
        {leading}
        {onBack && (
          <Button size="icon-xs" variant="ghost" aria-label="Back to the page" title="Back to the page" onClick={onBack}>
            <ArrowLeftIcon />
          </Button>
        )}
        <FileIcon className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-sm" title={path}>
          <span className="text-foreground">{name}</span>
          {name !== path && <span className="ml-2 text-muted-foreground">{path.slice(0, -name.length - 1)}</span>}
        </span>
        {unsaved && !editing && <span className="shrink-0 text-xs text-warning">Unsaved edits</span>}
        <Button size="icon-xs" variant="ghost" aria-label="Copy path" title="Copy path" onClick={() => void copyText(path)}>
          <CopyIcon />
        </Button>
        {editable && (
          <Button
            size="icon-xs"
            variant={editing ? "secondary" : "ghost"}
            aria-pressed={editing}
            aria-label={editing ? "Back to the viewer" : "Edit this file"}
            title={editing ? "Back to the viewer" : "Edit this file"}
            onClick={() => onEditingChange(!editing)}
          >
            <PencilIcon />
          </Button>
        )}
      </PanelToolbar>
      <div className={editing ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-auto bg-muted/50"}>
        {editing ? (
          <FileEditor projectId={projectId} path={path} line={line} />
        ) : (
          <Body
            kind={kind}
            loaded={unsaved && draft && loaded.state === "text" ? { state: "text", file: { ...loaded.file, content: draft.text } } : loaded}
            name={name}
            ext={name.slice(name.lastIndexOf(".") + 1)}
          />
        )}
      </div>
    </div>
  )
}

/** The kinds read as bytes — drawn by the browser or by a converter, never edited. */
const bytesKind = (kind: ReturnType<typeof previewKind>) =>
  kind === "image" || kind === "video" || kind === "pdf" || kind === "office"

function Body({ kind, loaded, name, ext }: { kind: ReturnType<typeof previewKind>; loaded: Loaded; name: string; ext: string }) {
  if (loaded.state === "loading")
    return kind === "image" || kind === "video" || kind === "pdf" || kind === "office" ? (
      <div className="flex min-h-full items-center justify-center p-2.5">
        <Skeleton className="h-64 w-full max-w-md rounded-xl" />
      </div>
    ) : (
      <CodeLinesSkeleton />
    )
  if (loaded.state === "error") return <ErrorNote error={loaded.error} className="m-2.5" />
  if (loaded.state === "slides") return <Slides data={loaded.data} name={name} />
  if (loaded.state === "office")
    // Empty sandbox: no scripts, no origin — a document's content can do nothing.
    return <iframe srcDoc={loaded.html} title={name} sandbox="" className="h-full w-full border-0 bg-white" />
  if (loaded.state === "url" && kind === "video")
    return (
      <div className="flex min-h-full items-center justify-center bg-black">
        <video src={loaded.url} controls className="max-h-full max-w-full" />
      </div>
    )
  if (loaded.state === "url")
    return kind === "image" ? (
      <div className="flex min-h-full items-center justify-center p-4">
        <img src={loaded.url} alt={name} className="max-h-full max-w-full object-contain" />
      </div>
    ) : (
      <iframe src={loaded.url} title={name} className="h-full w-full border-0" />
    )

  const { file } = loaded
  if (file.content === undefined)
    return (
      <div className="p-2.5">
        <Empty size="sm">{file.tooLarge ? "This file is too large to preview." : "This is a binary file, so there is nothing to show."}</Empty>
      </div>
    )
  if (kind === "html")
    return (
      <iframe
        srcDoc={file.content}
        title={name}
        className="h-full w-full border-0 bg-white"
        // Scripts yes, the app's origin no — the same bargain as the web preview.
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
      />
    )
  if (kind === "csv")
    return <iframe srcDoc={csvHtml(file.content, /\.tsv$/i.test(name))} title={name} sandbox="" className="h-full w-full border-0 bg-white" />
  if (kind === "markdown") return <MarkdownDocument text={file.content} className="mx-auto max-w-3xl p-6" />
  return <Highlighted code={file.content} language={ext} className="p-3" />
}

/* Slides are drawn by `pptx-preview` into a live DOM, so the frame is
   `allow-same-origin` (the parent can reach in) and nothing else — no scripts
   run inside it, and the app's CSS does not reach the slides. Sized to the
   panel once; a resize is a re-open. */
export function Slides({ data, name }: { data: ArrayBuffer; name: string }) {
  const ref = React.useRef<HTMLIFrameElement>(null)
  const [error, setError] = React.useState<InlineError | null>(null)
  // A fresh frame's document is swapped in after mount in some browsers, so draw on its load.
  const [ready, setReady] = React.useState(false)
  React.useEffect(() => {
    if (!ready) return
    const frame = ref.current
    const body = frame?.contentDocument?.body
    if (!frame || !body) return
    body.style.cssText = "margin:0;padding:16px;background:#f3f4f6"
    let stop: (() => void) | undefined
    let dead = false
    renderSlides(body, data, Math.max(320, frame.clientWidth - 32)).then(
      (fn) => (dead ? fn() : (stop = fn)),
      (err) => !dead && setError(captureError(err, "Couldn't draw the slides")),
    )
    return () => {
      dead = true
      stop?.()
    }
  }, [data, ready])
  return (
    <>
      {error && <ErrorNote error={error} className="m-2.5" />}
      <iframe ref={ref} srcDoc="<!doctype html>" onLoad={() => setReady(true)} title={name} sandbox="allow-same-origin" className="h-full w-full border-0" />
    </>
  )
}
