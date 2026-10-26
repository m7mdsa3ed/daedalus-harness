/* ── Looking at a library file ──
   The preview lives where the details pane is (`PreviewPanel`): select a file
   and it is drawn there, each kind in the viewer it deserves, with its own
   toolbar —

   - an image zooms (wheel, +/−, fit, 1:1, double-click) and pans (drag), over
     a checkerboard, light or dark ground, and says its pixel size;
   - video and audio are the browser's own players;
   - a PDF is the browser's own viewer on a blob;
   - Word, Excel and PowerPoint go through the same converters the workspace
     Preview panel uses (`lib/office-preview.ts`, `Slides`), into frames that
     can run nothing;
   - Markdown, HTML and CSV draw rendered or as source; source and any other
     text is highlighted, with wrap and copy.

   The panel grows in two steps: full width (the whole explorer — ← and →
   step, a filmstrip shows where you are, Esc comes back) and full screen (the
   browser's Fullscreen API on the panel itself, from either size). */
import * as React from "react"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  ImageIcon,
  MaximizeIcon,
  MinimizeIcon,
  MinusIcon,
  PanelRightIcon,
  PlusIcon,
  ShrinkIcon,
  WrapTextIcon,
  XIcon,
} from "lucide-react"

import { ErrorNote } from "@/components/error-note"
import { Thumb } from "@/components/files/file-items"
import { mimeIcon } from "@/components/files/mime-icon"
import { copyText } from "@/components/step-row"
import { Highlighted } from "@/components/tool-parts"
import { MarkdownDocument } from "@/components/prose"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { CodeLinesSkeleton } from "@/components/ui/skeletons"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Slides } from "@/components/workspace/file-preview"
import { PanelToolbar } from "@/components/workspace/primitives"
import { formatBytes } from "@/lib/attachments"
import { captureError, reportError } from "@/lib/errors"
import { previewKind as kindByName } from "@/lib/file-preview"
import {
  formatDate,
  isTextLike,
  kindLabel,
  useFileActions,
  useFileBlob,
  type FileRecord,
  type PathStep,
} from "@/lib/files"
import { csvHtml, officeHtml } from "@/lib/office-preview"
import { cn } from "@/lib/utils"

/** Text past this is not read for a preview — a log file can be the whole limit. */
const TEXT_MAX = 1024 * 1024
/** Converting an Office file is done in the page; past this it is a long freeze. */
const OFFICE_MAX = 20 * 1024 * 1024
/** What the details pane shows of a text file. */

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "office" | "csv" | "markdown" | "html" | "text"

export function previewKind(file: FileRecord): PreviewKind | null {
  if (file.kind !== "file") return null
  if (file.mimeType.startsWith("image/")) return "image"
  if (file.mimeType.startsWith("video/")) return "video"
  if (file.mimeType.startsWith("audio/")) return "audio"
  if (file.mimeType === "application/pdf") return "pdf"
  const byName = kindByName(file.name)
  if (byName === "image" || byName === "pdf") return byName
  if (byName === "office") return file.size <= OFFICE_MAX ? "office" : null
  if (file.size > TEXT_MAX) return null
  if (byName === "csv" || byName === "markdown" || byName === "html") return byName
  return isTextLike(file) ? "text" : null
}

const extOf = (name: string) => name.slice(name.lastIndexOf(".") + 1).toLowerCase()
const isTextual = (kind: PreviewKind | null) =>
  kind === "text" || kind === "markdown" || kind === "html" || kind === "csv"

/* ── Bits every viewer's toolbar is made of ── */

function Bar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-10 shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1 text-sm text-muted-foreground", className)}>
      {children}
    </div>
  )
}

function Tool({ active, ...props }: React.ComponentProps<typeof Button> & { active?: boolean }) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={active ? "secondary" : "ghost"}
      aria-pressed={active}
      {...props}
    />
  )
}

/** Two or three named states, as one control: Rendered / Source, a background.
    A ToggleGroup, not the kit's `Segmented` (whose name it used to shadow). */
function ViewToggle<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: React.ReactNode; title?: string }[]
  onChange: (value: T) => void
}) {
  return (
    <ToggleGroup size="sm" spacing={0} variant="outline" value={[value]} onValueChange={(next) => next[0] && onChange(next[0] as T)}>
      {options.map((option) => (
        <ToggleGroupItem key={option.value} value={option.value} title={option.title}>
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

const CHECKER =
  "bg-[conic-gradient(var(--muted)_25%,transparent_0_50%,var(--muted)_0_75%,transparent_0)] bg-[length:16px_16px]"
type Ground = "checker" | "light" | "dark"
const GROUND: Record<Ground, string> = { checker: CHECKER, light: "bg-white", dark: "bg-neutral-950" }

/* ── Image: zoom and pan ── */

const ZOOM_MIN = 0.05
const ZOOM_MAX = 16

function ImageViewer({ url, name }: { url: string; name: string }) {
  const box = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState({ w: 0, h: 0 })
  const [natural, setNatural] = React.useState<{ w: number; h: number } | null>(null)
  /** `fit` follows the box; a number is a scale the reader chose. */
  const [zoom, setZoom] = React.useState<"fit" | number>("fit")
  const [pan, setPan] = React.useState({ x: 0, y: 0 })
  const [ground, setGround] = React.useState<Ground>("checker")
  const drag = React.useRef<{ x: number; y: number; px: number; py: number } | null>(null)

  React.useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const fit = natural && size.w ? Math.min(1, (size.w - 32) / natural.w, (size.h - 32) / natural.h) : 1
  const scale = zoom === "fit" ? fit : zoom
  const zoomTo = (next: number | "fit") => {
    setZoom(next === "fit" ? "fit" : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)))
    if (next === "fit") setPan({ x: 0, y: 0 })
  }
  const zoomBy = (factor: number) => zoomTo(scale * factor)

  /* + − 0 1 while the preview holds the focus — not the listing beside it,
     whose type-ahead wants every letter and digit. */
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const panel = box.current?.closest("[data-preview-root]")
      if (!panel || !(e.target instanceof Node) || !panel.contains(e.target)) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === "+" || e.key === "=") zoomBy(1.25)
      else if (e.key === "-" || e.key === "_") zoomBy(0.8)
      else if (e.key === "0") zoomTo("fit")
      else if (e.key === "1") zoomTo(1)
      else return
      e.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Bar>
        <Tool title="Zoom out (−)" onClick={() => zoomBy(0.8)}>
          <MinusIcon />
        </Tool>
        <Button type="button" variant="ghost" size="sm" title="Actual size (1)" onClick={() => zoomTo(1)} className="w-14 tabular-nums">
          {Math.round(scale * 100)}%
        </Button>
        <Tool title="Zoom in (+)" onClick={() => zoomBy(1.25)}>
          <PlusIcon />
        </Tool>
        <Tool title="Fit to the window (0)" active={zoom === "fit"} onClick={() => zoomTo("fit")}>
          <ShrinkIcon />
        </Tool>
        <Separator orientation="vertical" className="mx-1 h-4" />
        <ViewToggle
          value={ground}
          onChange={setGround}
          options={[
            { value: "checker", label: <ImageIcon className="size-3.5" />, title: "Transparency grid" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
        <span className="ml-auto tabular-nums">{natural && `${natural.w} × ${natural.h} px`}</span>
      </Bar>
      <div
        ref={box}
        className={cn("relative min-h-0 flex-1 touch-none overflow-hidden", GROUND[ground], "cursor-grab active:cursor-grabbing")}
        onWheel={(e) => zoomBy(Math.pow(1.0015, -e.deltaY))}
        onDoubleClick={() => zoomTo(zoom === "fit" ? 1 : "fit")}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }
        }}
        onPointerMove={(e) => {
          const start = drag.current
          if (start) setPan({ x: start.px + e.clientX - start.x, y: start.py + e.clientY - start.y })
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <img
          src={url}
          alt={name}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className="absolute top-1/2 left-1/2 max-w-none select-none"
          style={{
            width: natural ? natural.w * scale : undefined,
            transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
            imageRendering: scale >= 3 ? "pixelated" : undefined,
          }}
        />
      </div>
    </div>
  )
}

/* ── Text, and the formats that are text underneath ── */

function TextViewer({ file, text, kind }: { file: FileRecord; text: string; kind: PreviewKind }) {
  const rendered = kind === "markdown" || kind === "html" || kind === "csv"
  const [mode, setMode] = React.useState<"rendered" | "source">(rendered ? "rendered" : "source")
  const [wrap, setWrap] = React.useState(kind === "markdown")
  const ext = extOf(file.name)
  const lines = React.useMemo(() => text.split("\n").length, [text])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Bar>
        {rendered && (
          <ViewToggle
            value={mode}
            onChange={setMode}
            options={[
              { value: "rendered", label: kind === "csv" ? "Table" : "Rendered" },
              { value: "source", label: "Source" },
            ]}
          />
        )}
        {mode === "source" && (
          <Tool title={wrap ? "Don’t wrap lines" : "Wrap long lines"} active={wrap} onClick={() => setWrap(!wrap)}>
            <WrapTextIcon />
          </Tool>
        )}
        <Tool title="Copy the text" onClick={() => copyText(text)}>
          <CopyIcon />
        </Tool>
        <span className="ml-auto tabular-nums">
          {lines.toLocaleString()} {lines === 1 ? "line" : "lines"}
          {ext && ext !== file.name.toLowerCase() ? ` · ${ext}` : ""}
        </span>
      </Bar>
      <div className="min-h-0 flex-1 overflow-auto">
        {mode === "rendered" && kind === "markdown" ? (
          <MarkdownDocument text={text} className="mx-auto max-w-3xl p-6" />
        ) : mode === "rendered" && kind === "html" ? (
          <iframe
            srcDoc={text}
            title={file.name}
            // Scripts yes, the app's origin no — the same bargain as the web preview.
            sandbox="allow-scripts allow-forms allow-popups"
            referrerPolicy="no-referrer"
            className="size-full border-0 bg-white"
          />
        ) : mode === "rendered" && kind === "csv" ? (
          <iframe srcDoc={csvHtml(text, ext === "tsv")} title={file.name} sandbox="" className="size-full border-0 bg-white" />
        ) : (
          <Highlighted
            code={text}
            language={ext}
            className={cn("p-3", wrap ? "[&_pre]:break-words [&_pre]:whitespace-pre-wrap" : "[&_pre]:whitespace-pre")}
          />
        )}
      </div>
    </div>
  )
}

/* ── Word, Excel, PowerPoint ── */

function OfficeViewer({ file, blob }: { file: FileRecord; blob: Blob }) {
  const ext = extOf(file.name)
  const [state, setState] = React.useState<
    { state: "loading" } | { state: "html"; html: string } | { state: "slides"; data: ArrayBuffer } | { state: "error"; error: ReturnType<typeof captureError> }
  >({ state: "loading" })
  React.useEffect(() => {
    let dead = false
    setState({ state: "loading" })
    blob
      .arrayBuffer()
      .then(async (data) => (ext === "pptx" ? { state: "slides" as const, data } : { state: "html" as const, html: await officeHtml(data, ext) }))
      .then(
        (next) => !dead && setState(next),
        (err) => !dead && setState({ state: "error", error: captureError(err, "Couldn't open the document") })
      )
    return () => {
      dead = true
    }
  }, [blob, ext])
  if (state.state === "loading")
    return (
      <Centered className="p-2.5">
        <Skeleton className="size-full max-h-64 max-w-md rounded-xl" />
      </Centered>
    )
  if (state.state === "error") return <ErrorNote error={state.error} className="m-4" />
  if (state.state === "slides") return <Slides data={state.data} name={file.name} />
  // Empty sandbox: no scripts, no origin — a document's content can do nothing.
  return <iframe srcDoc={state.html} title={file.name} sandbox="" className="size-full border-0 bg-white" />
}

function Centered({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex min-h-0 flex-1 items-center justify-center", className)}>{children}</div>
}

function NoPreview({ file, reason, large }: { file: FileRecord; reason: string; large?: boolean }) {
  const Icon = mimeIcon(file.mimeType)
  return (
    <Centered className="flex-col gap-2 p-6 text-center text-muted-foreground">
      <Icon className={large ? "size-16" : "size-10"} strokeWidth={1.25} />
      <span className="text-sm">{reason}</span>
    </Centered>
  )
}

/** The file drawn, each kind in its own viewer with its own toolbar. */
export function FilePreview({ file, className }: { file: FileRecord; className?: string }) {
  const kind = previewKind(file)
  const blob = useFileBlob(file, { text: isTextual(kind), enabled: kind !== null })
  let body: React.ReactNode
  if (kind === null)
    body = (
      <NoPreview
        file={file}
        large
        reason={file.size > TEXT_MAX && isTextLike(file) ? "Too large to preview" : "No preview for this kind of file"}
      />
    )
  else if (blob.error) body = <ErrorNote error={captureError(blob.error, "Couldn't load a preview")} className="m-3" />
  else if (blob.loading || !blob.url)
    body = isTextual(kind) ? (
      <CodeLinesSkeleton />
    ) : (
      <Centered className="p-2.5">
        <Skeleton className="size-full max-h-64 max-w-md rounded-xl" />
      </Centered>
    )
  else
    body =
      kind === "image" ? (
        <ImageViewer key={blob.url} url={blob.url} name={file.name} />
      ) : kind === "video" ? (
        <Centered className="bg-black">
          <video src={blob.url} controls className="max-h-full max-w-full" />
        </Centered>
      ) : kind === "audio" ? (
        <Centered className="flex-col gap-6 p-6">
          <NoPreview file={file} reason={file.name} large />
          <audio src={blob.url} controls className="w-full max-w-xl" />
        </Centered>
      ) : kind === "pdf" ? (
        <iframe src={blob.url} title={file.name} className="size-full border-0 bg-white" />
      ) : kind === "office" ? (
        <OfficeViewer file={file} blob={blob.blob!} />
      ) : (
        <TextViewer key={file.id} file={file} text={blob.text ?? ""} kind={kind} />
      )
  return <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden", className)}>{body}</div>
}

/* ── Facts about a selection ── */

export function FileFacts({ file, location }: { file: FileRecord; location?: PathStep[] }) {
  const rows: [string, string][] = [
    ["Kind", kindLabel(file)],
    file.kind === "file"
      ? ["Size", formatBytes(file.size)]
      : ["Contains", `${file.childCount ?? 0} ${file.childCount === 1 ? "item" : "items"}`],
    ...(location ? ([["Where", location.map((s) => s.name).join(" / ") || "Library"]] as [string, string][]) : []),
    ["Modified", formatDate(file.updatedAt)],
    ["Created", formatDate(file.createdAt)],
  ]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate text-right tabular-nums" title={value}>
            {value}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

/** The side pane when no single file is selected: a folder's facts, a count
    for several, the folder on screen for none. A single file gets the
    `PreviewPanel` instead. */
export function FileDetails({
  selected,
  folderName,
  folderCount,
  location,
  actions,
}: {
  selected: FileRecord[]
  folderName: string
  folderCount: number
  /** Where a single selection sits, when it is not the folder on screen (a search hit). */
  location?: PathStep[]
  actions?: React.ReactNode
}) {
  if (selected.length > 1) {
    const files = selected.filter((f) => f.kind === "file")
    return (
      <div className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-3 gap-1.5">
          {selected.slice(0, 9).map((item) => (
            <Thumb key={item.id} item={item} crop className="aspect-square rounded-lg bg-muted" />
          ))}
        </div>
        <p className="text-sm font-medium">{selected.length} items selected</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Folders</dt>
          <dd className="text-right tabular-nums">{selected.length - files.length}</dd>
          <dt className="text-muted-foreground">Files</dt>
          <dd className="text-right tabular-nums">{files.length}</dd>
          <dt className="text-muted-foreground">Total size</dt>
          <dd className="text-right tabular-nums">{formatBytes(files.reduce((sum, f) => sum + f.size, 0))}</dd>
        </dl>
        {actions}
      </div>
    )
  }
  const item = selected[0]
  const Icon = mimeIcon(item?.mimeType ?? "inode/directory")
  if (!item) {
    return (
      <div className="flex flex-col items-center gap-2 p-6 text-center text-muted-foreground">
        <Icon className="size-10 text-primary/70" strokeWidth={1.25} />
        <p className="text-sm font-medium text-foreground">{folderName}</p>
        <p className="text-sm">
          {folderCount} {folderCount === 1 ? "item" : "items"} · select a file to preview it here
        </p>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex aspect-[4/3] items-center justify-center rounded-xl bg-muted">
        <Icon className="size-12 text-primary/70" strokeWidth={1.25} fill="currentColor" fillOpacity={0.15} />
      </div>
      <p className="text-sm font-medium break-all">{item.name}</p>
      <FileFacts file={item} location={location} />
      {actions}
    </div>
  )
}

/* ── The preview panel ── */

/** Types a browser tab shows without running anything. Not SVG: an SVG document runs scripts. */
const INERT = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|video\/|audio\/|text\/plain)/

export type PreviewSize = "pane" | "wide"

/** One file, previewed where the details pane is (`pane`) or across the
    whole explorer (`wide`); either can go full screen. ← and → step through
    `files` (the listing's, in its order) — stepping is the explorer's
    selection moving, so the listing follows. */
export function PreviewPanel({
  file,
  files,
  size,
  onSize,
  onStep,
  onDownload,
  location,
  actions,
}: {
  file: FileRecord
  files: FileRecord[]
  size: PreviewSize
  onSize: (size: PreviewSize) => void
  onStep: (file: FileRecord) => void
  onDownload: (file: FileRecord) => void
  location?: PathStep[]
  /** The explorer's verbs for this file (Choose, Rename, Delete…). */
  actions?: React.ReactNode
}) {
  const root = React.useRef<HTMLDivElement>(null)
  const fileActions = useFileActions()
  const [fullscreen, setFullscreen] = React.useState(false)
  const wide = size === "wide"
  const index = files.findIndex((f) => f.id === file.id)
  const step = (by: number) => {
    const next = files[index + by]
    if (next) onStep(next)
  }

  React.useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === root.current && root.current !== null)
    document.addEventListener("fullscreenchange", sync)
    return () => document.removeEventListener("fullscreenchange", sync)
  }, [])
  React.useEffect(() => {
    if (wide) root.current?.focus({ preventScroll: true })
  }, [wide])
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void root.current?.requestFullscreen().catch((err) => reportError(err, "Couldn't go full screen"))
  }

  /* A blob URL has the app's origin, so only types that run nothing open as
     themselves; HTML, SVG and the rest open as plain text, or an uploaded page
     could read the token. */
  const openInTab = async () => {
    const win = window.open("", "_blank") // now, inside the click, or it is a blocked popup
    try {
      const bytes = await fileActions.fetchFile(file)
      const type = INERT.test(file.mimeType) ? file.mimeType : "text/plain;charset=utf-8"
      const url = URL.createObjectURL(new Blob([bytes], { type }))
      if (win) win.location.href = url
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      win?.close()
      reportError(err, "Couldn't open that file")
    }
  }

  return (
    <section
      ref={root}
      data-preview-root
      aria-label={`Preview of ${file.name}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
        if (e.key === "ArrowLeft" && !e.altKey) step(-1)
        else if (e.key === "ArrowRight" && !e.altKey) step(1)
        /* Escape out of full screen is the browser's; out of full width is ours. */
        else if (e.key === "Escape" && wide && !fullscreen) onSize("pane")
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
      className="flex size-full min-h-0 flex-col bg-background outline-none"
    >
      <PanelToolbar>
        <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium" title={file.name}>
          {file.name}
        </span>
        {files.length > 1 && (
          <>
            <span className="hidden px-1 text-sm text-muted-foreground tabular-nums @min-[24rem]:inline">
              {index + 1}/{files.length}
            </span>
            <Button type="button" variant="ghost" size="icon-sm" title="Previous file (←)" disabled={index <= 0} onClick={() => step(-1)}>
              <ChevronLeftIcon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
             
              title="Next file (→)"
              disabled={index < 0 || index >= files.length - 1}
              onClick={() => step(1)}
            >
              <ChevronRightIcon />
            </Button>
          </>
        )}
        <Button type="button" variant="ghost" size="icon-sm" title="Open in a new tab" onClick={() => void openInTab()}>
          <ExternalLinkIcon />
        </Button>
        <Button type="button" variant="ghost" size="icon-sm" title="Download" onClick={() => onDownload(file)}>
          <DownloadIcon />
        </Button>
        <div className="mx-0.5 h-4 w-px bg-border" />
        {!fullscreen && (
          <Button
            type="button"
            variant={wide ? "secondary" : "ghost"}
            size="icon-sm"
           
            title={wide ? "Back to the side panel (Esc)" : "Full width (Space)"}
            aria-pressed={wide}
            onClick={() => onSize(wide ? "pane" : "wide")}
          >
            {wide ? <PanelRightIcon /> : <Columns2Icon />}
          </Button>
        )}
        <Button
          type="button"
          variant={fullscreen ? "secondary" : "ghost"}
          size="icon-sm"
         
          title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
          aria-pressed={fullscreen}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
        </Button>
        {wide && !fullscreen && (
          <Button type="button" variant="ghost" size="icon-sm" title="Close the preview (Esc)" onClick={() => onSize("pane")}>
            <XIcon />
          </Button>
        )}
      </PanelToolbar>

      <div className="group/stage relative flex min-h-0 flex-1 flex-col">
        <FilePreview key={file.id} file={file} />
        {/* Big side arrows over a wide stage, for a pointer that is not near the header. */}
        {(wide || fullscreen) && index > 0 && (
          <Button
            type="button"
            variant="secondary"
            size="icon-lg"
            tabIndex={-1}
            aria-hidden
            onClick={() => step(-1)}
            className="absolute top-1/2 left-3 hidden -translate-y-1/2 opacity-0 transition-opacity group-hover/stage:opacity-100 pointer-fine:inline-flex"
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        )}
        {(wide || fullscreen) && index >= 0 && index < files.length - 1 && (
          <Button
            type="button"
            variant="secondary"
            size="icon-lg"
            tabIndex={-1}
            aria-hidden
            onClick={() => step(1)}
            className="absolute top-1/2 right-3 hidden -translate-y-1/2 opacity-0 transition-opacity group-hover/stage:opacity-100 pointer-fine:inline-flex"
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        )}
      </div>

      {(wide || fullscreen) && files.length > 1 && (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto border-t p-2" role="listbox" aria-label="Files in this folder">
          {files.map((f) => (
            <button
              key={f.id}
              type="button"
              role="option"
              aria-selected={f.id === file.id}
              title={f.name}
              ref={(el) => {
                if (el && f.id === file.id) el.scrollIntoView({ block: "nearest", inline: "nearest" })
              }}
              onClick={() => onStep(f)}
              className={cn(
                "size-14 shrink-0 overflow-hidden rounded-lg border-2 bg-muted",
                f.id === file.id ? "border-primary" : "border-transparent opacity-70 hover:opacity-100"
              )}
            >
              <Thumb item={f} crop className="size-full" />
            </button>
          ))}
        </div>
      )}

      {!fullscreen && (
        <details className="group/facts shrink-0 border-t" open={!wide}>
          <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon className="size-3.5 transition-transform group-open/facts:rotate-90" />
            {kindLabel(file)} · {formatBytes(file.size)}
          </summary>
          <div className="flex flex-col gap-3 px-3 pb-3">
            <FileFacts file={file} location={location} />
            {actions}
          </div>
        </details>
      )}
    </section>
  )
}
