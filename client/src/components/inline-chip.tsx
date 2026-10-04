/* ── The inline chip ──
   One face for the three things that ride inside a message's text — a long
   paste, a quote, an `@` mention — drawn the same in the composer's box and in
   the sent bubble, so what you typed is what you see once it has gone. A tinted
   pill that sits in the line of text, never a card or a bordered block.

   The composer wraps it in a Tiptap node view and adds a ✕; the transcript
   draws it bare. The faces (`useMentionFace`, `quoteFace`) and the previews
   live here too, so the two sides cannot drift apart. */
import * as React from "react"
import { AtSignIcon, FileTextIcon, type LucideIcon } from "lucide-react"

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { CopyButton } from "@/components/ui/copy-button"
import { ProjectIcon } from "@/components/entity-icon"
import { useProjects } from "@/lib/queries/catalog"
import { cn } from "@/lib/utils"

/** The pill. `trailing` narrows the end inset for a control drawn after the face.
 *
 * `items-baseline`, not `items-center`: an inline-flex container with nothing
 * baseline-aligned takes its baseline from the *bottom edge* of its first item,
 * so a chip leading with an icon (or a project's mark) sat a few pixels off the
 * text it rides in — `align-baseline` had nothing true to align to. Aligning the
 * face's own label puts the pill's text on the line's baseline; a control drawn
 * after the face (`trailing`) centres itself back with `self-center`. */
export function chipClass(opts: { selected?: boolean; trailing?: boolean } = {}) {
  return cn(
    "mx-px inline-flex max-w-[min(20rem,100%)] items-baseline gap-0.5 rounded-md bg-foreground/[0.06] py-px ps-1.5 align-baseline text-[0.9em] leading-snug text-foreground not-prose transition-colors hover:bg-foreground/[0.1]",
    opts.trailing ? "pe-0.5" : "pe-1.5",
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
        <PopoverContent className="w-[min(32rem,calc(100vw-2rem))] p-0">{preview}</PopoverContent>
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

export const linesLabel = (lines: number) =>
  `${lines.toLocaleString()} line${lines === 1 ? "" : "s"}`

/** The popover under a paste or quote chip: a caption, a Copy, the body. */
export function ChipPreview({ caption, text }: { caption?: string; text: string }) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span>{caption}</span>
        <CopyButton text={text} />
      </div>
      <pre className="max-h-72 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
        {text}
      </pre>
    </>
  )
}
