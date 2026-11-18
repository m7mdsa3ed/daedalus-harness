/* ── The inline chip ──
   One face for the three things that ride inside a message's text — a long
   paste, a quote, an `@` mention — drawn the same in the composer's box and in
   the sent bubble, so what you typed is what you see once it has gone. A tinted
   pill that sits in the line of text, never a card or a bordered block.

   The composer wraps it in a Tiptap node view and adds a ✕; the transcript
   draws it bare. The faces (`useMentionFace`, `quoteFace`) and the previews
   live here too, so the two sides cannot drift apart. */
import * as React from "react"
import { AtSignIcon, FileTextIcon, LinkIcon, SquareCheckIcon, type LucideIcon } from "lucide-react"
import { TASK_KEY } from "@/lib/task-mentions"
import { useKindFace } from "@/lib/mentions"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CopyButton } from "@/components/ui/copy-button"
import { ProjectIcon } from "@/components/entity-icon"
import { useProjects } from "@/lib/queries/catalog"
import { useLinkPreview } from "@/lib/queries/surfaces"
import { cn } from "@/lib/utils"

/** The pill. `trailing` narrows the end inset for a control drawn after the face.
 *
 * `items-baseline`, not `items-center`: an inline-flex container with nothing
 * baseline-aligned takes its baseline from the *bottom edge* of its first item,
 * so a chip leading with an icon (or a project's mark) sat a few pixels off the
 * text it rides in — `align-baseline` had nothing true to align to. Aligning the
 * face's own label puts the pill's text on the line's baseline; a control drawn
 * after the face (`trailing`) centres itself back with `self-center`.
 *
 * `quote` widens the end margin: a quote leads its line with no space typed
 * after it, so the 1px every chip keeps ran it straight into the words asked
 * about it. */
export function chipClass(
  opts: { selected?: boolean; trailing?: boolean; link?: boolean; quote?: boolean } = {}
) {
  return cn(
    "chip mx-px inline-flex items-baseline gap-0.5 rounded-pill bg-secondary py-px ps-1.5 align-baseline text-[0.9em] leading-snug text-foreground not-prose transition-colors hover:bg-muted",
    opts.link ? "max-w-[min(16rem,100%)]" : "max-w-[min(20rem,100%)]",
    opts.trailing ? "pe-0.5" : "pe-1.5",
    opts.quote && "me-2",
    opts.selected && "bg-primary/15 hover:bg-primary/15"
  )
}

export interface ChipFace {
  icon: LucideIcon
  /** A picture drawn in the icon's place — a project's logo. */
  mark?: React.ReactNode
  label: string
  aside?: string
}

/**
 * What is inside the pill: the mark, the label, a fact beside it. With a
 * `preview` the face opens it; with `onClick` it is a button; otherwise text.
 */
export function ChipBody({
  icon: Icon,
  mark,
  label,
  aside,
  preview,
  onClick,
}: ChipFace & { preview?: React.ReactNode; onClick?: () => void }) {
  const face = (
    <>
      {mark ?? <Icon aria-hidden className="size-3.5 shrink-0 self-center text-primary/80" />}
      <span className="truncate">{label}</span>
      {aside && <span className="shrink-0 text-muted-foreground">{aside}</span>}
    </>
  )
  /* Baseline, so the label is the item the pill's own baseline comes from (the
     icon centres itself). */
  const faceClass = "inline-flex min-w-0 items-baseline gap-1 [&_svg]:pointer-events-none"
  if (preview) {
    return (
      <Popover>
        <PopoverTrigger
          render={<button type="button" className={faceClass} aria-label={`Preview ${label}`} />}
        >
          {face}
        </PopoverTrigger>
        <PopoverContent className="w-[min(32rem,calc(var(--float-w)-2rem))] p-0">{preview}</PopoverContent>
      </Popover>
    )
  }
  if (onClick) {
    return (
      <button type="button" className={faceClass} onClick={onClick}>
        {face}
      </button>
    )
  }
  return <span className={faceClass}>{face}</span>
}

/* A mention names its last segment; a path that is a project's directory names
   the project, with its logo, because that is what the person picked. */
export function useMentionFace(path: string): ChipFace {
  const trimmed = path.replace(/\/+$/, "")
  const project = useProjects().find((p) => p.cwd.replace(/\/+$/, "") === trimmed)
  // A typed reference (`@thread:abc`) wears its source's face (lib/mentions/).
  const kind = useKindFace(path)
  if (kind) return kind
  // A board task (`@DAE-12`, file-mentions.tsx) is named by its key.
  if (TASK_KEY.test(path)) return { icon: SquareCheckIcon, label: path }
  if (project) {
    return {
      icon: AtSignIcon,
      /* `self-center`: the label carries the chip's baseline (see `chipClass`). */
      mark: <ProjectIcon project={project} className="size-3.5 self-center" />,
      label: project.name,
    }
  }
  const base = trimmed.split("/").pop() || path
  return { icon: base.includes(".") ? FileTextIcon : AtSignIcon, label: base }
}

/** A quote's label: its first line, and how many more there are. */
export function quoteFace(text: string): { label: string; aside?: string } {
  const lines = text.split("\n")
  const first = lines.find((line) => line.trim()) ?? ""
  return { label: first || "Quote", aside: lines.length > 1 ? `+${lines.length - 1}` : undefined }
}

/** A link's hostname — the chip says this until the page's title arrives, and
    what it falls back to when the page answers with none. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url
  } catch {
    return url
  }
}

/* A link says what it *is* once the page answers: the title as the label, the
   host as the aside, the page's own image in the icon's place (the slot a
   project's logo uses). Until then — and for a page that answers with nothing —
   it is the host, with a chain-link glyph. The page is fetched by the server
   (`link-preview.ts`), so the browser asks the link's host nothing. */
export function useLinkFace(url: string): ChipFace {
  const preview = useLinkPreview(url).data
  const host = linkHost(url)
  const title = preview?.title?.trim()
  return {
    icon: LinkIcon,
    ...(preview?.image
      ? { mark: <img src={preview.image} alt="" aria-hidden className="size-3.5 self-center rounded-sm object-contain" /> }
      : {}),
    label: title || host,
    aside: title ? host : undefined,
  }
}

export const linesLabel = (lines: number) =>
  `${lines.toLocaleString()} line${lines === 1 ? "" : "s"}`

/* The transcript's own markdown pass, reached on demand. `components/prose.tsx`
   imports this module (`LinkChip`) and `thread-items/user-chips.tsx` (the chip
   registry), so a static import here would close the cycle; scheduling it keeps
   the popover out of it, and costs nothing in practice — a bubble on screen has
   already loaded the module. */
const Markdown = React.lazy(() =>
  import("@/components/prose").then((module) => ({ default: module.Prose }))
)

/* The body verbatim: still the answer for a quote or a block of what the agent
   was sent, where the characters are the point. */
const raw = (text: string) => (
  <pre className="max-h-72 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
    {text}
  </pre>
)

/** The popover under a paste or quote chip: a caption, a Copy, the body.
 *
 * `markdown` reads the body the way the thread reads one — a pasted brief is a
 * document, and its headings, lists, tables and fences are what it said. The
 * Copy still hands over the characters as they were pasted. */
export function ChipPreview({
  caption,
  text,
  markdown = false,
  actions,
}: {
  caption?: string
  text: string
  markdown?: boolean
  /** Controls beside the Copy — the composer's "Expand" on a parked paste. */
  actions?: React.ReactNode
}) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span>{caption}</span>
        <span className="flex shrink-0 items-center gap-1">
          {actions}
          <CopyButton text={text} />
        </span>
      </div>
      {markdown ? (
        /* The raw body is the fallback, so the popover is never empty while the
           pass loads — and it is what was drawn there before it existed. */
        <React.Suspense fallback={raw(text)}>
          <Markdown text={text} className="max-h-72 overflow-auto p-3" />
        </React.Suspense>
      ) : (
        raw(text)
      )}
    </>
  )
}

/* A link's chip, drawn bare — the transcript's face for one, and the box's
   node view wraps the same face with its ✕. The whole pill is the link, so the
   `a` here is the chip and carries the target every other markdown link gets. */
export function LinkChip({ url, text }: { url: string; text?: string }) {
  const face = useLinkFace(url)
  /* An authored label (`[docs](https://…)`) keeps its words; a *bare* URL —
     GFM autolinks it and the anchor's own text is the URL — takes the page's
     title, and the host until it answers. */
  const authored = text?.trim()
  const label = authored && authored !== url ? authored : face.label
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      title={url}
      className={cn(chipClass({ link: true }), "no-underline hover:no-underline [&_*]:no-underline")}
    >
      <ChipBody {...face} label={label} />
    </a>
  )
}
