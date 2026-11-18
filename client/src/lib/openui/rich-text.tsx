/* ── The text a component's string may carry ──
   A model writes `**Urgent**`, `` `cff8137` `` and `[Ticket](https://…)` by
   habit, and a component that draws its strings as plain characters shows the
   asterisks and the address instead. So the content props of the library draw
   inline markdown — and they draw it with `InlineMarkdown` from
   `components/prose.tsx`, the same react-markdown + remark-gfm pass every
   answer in the transcript goes through. One way a `**bold**` is read, in a
   cell and in the paragraph above it.

   The differences from prose are two, and both are this file's reason to
   exist: `LinkAnchor` opens an address the reader can see and never resolves a
   page title over the network (`MarkdownLink` does, on purpose, for an answer),
   and the type comes from the component's own scale rather than `.prose`. */
import * as React from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { cn } from "@/lib/utils"
import { InlineMarkdown, MARKDOWN_COMPONENTS } from "@/components/prose"
import { CELL_STATES, TONE_CHIP, TONES } from "@/lib/openui/kit"

/** A URL a generated view may draw. Only `http(s)`: `javascript:` and `data:`
    documents are addresses a page the thread read could have talked the model
    into, and a view has no fetch to offer either way. */
export function linkTarget(href: string | undefined): URL | null {
  if (!href) return null
  try {
    const url = new URL(href)
    return url.protocol === "http:" || url.protocol === "https:" ? url : null
  } catch {
    return null
  }
}

/** One anchor, so every link in a view is coloured and opens the same way.
    `underline` is for a link inside a sentence, where the words have to say
    where they go; a list row's name carries an arrow instead, because a
    two-line heading with a rule under every line reads as emphasised prose. */
export function LinkAnchor({
  url,
  children,
  className,
  underline = true,
}: {
  url: URL
  children: React.ReactNode
  className?: string
  underline?: boolean
}) {
  return (
    <a
      href={url.href}
      target="_blank"
      rel="noreferrer noopener"
      title={url.href}
      className={cn(
        "min-w-0 rounded-sm font-medium break-words text-primary outline-none",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        underline && "underline underline-offset-2",
        className
      )}
    >
      {children}
    </a>
  )
}

/* The library's own dress for the inline elements: the component sets the
   size, so bold is a weight and code is a chip rather than a `.prose` block's
   idea of either. Held as a constant — a new object per render would make
   react-markdown rebuild its processor for every cell. */
const VIEW_MARKDOWN: Components = {
  p: ({ children }) => <>{children}</>,
  strong: ({ children }) => <strong className="font-medium text-foreground">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
  /* The transcript's own inline code (`.prose :where(code)`): a muted chip, no
     border, no ring — a `\`cff8137\`` in a table cell and the same token in the
     paragraph beside it are one chip. */
  code: ({ children }) => (
    <code className="rounded-md bg-muted px-[0.3em] py-[0.1em] font-mono text-[0.875em] text-foreground box-decoration-clone">{children}</code>
  ),
  a: ({ href, children }) => {
    const url = linkTarget(href)
    // An address a view may not open is said, not linked — the words stay.
    return url ? <LinkAnchor url={url}>{children}</LinkAnchor> : <>{children}</>
  },
}

/* Anything at all that markdown reads. A cell of plain words — the common case
   in a table of forty — costs a regex and no parse. */
const MARKUP = /[*_`[~]/
const BLOCK_MARKDOWN = /(^|\n)\s*(#{1,6} |[-*+] |\d+\. |> |\|)|```/
const BLOCK_REMARK = [remarkGfm]

/** A document drawn with the transcript's markdown renderer and link policy. */
export const MarkdownBlock = React.memo(function MarkdownBlock({ text }: { text: string }) {
  const value = text.trim()
  if (!value) return null
  if (!BLOCK_MARKDOWN.test(value)) return <RichText text={value} />
  return (
    <div className="prose prose-sm min-w-0 max-w-none break-words">
      <Markdown remarkPlugins={BLOCK_REMARK} components={MARKDOWN_COMPONENTS}>
        {value}
      </Markdown>
    </div>
  )
})
MarkdownBlock.displayName = "MarkdownBlock"

/* ── Inline chips ──
   `[[done]]` or `[[Beta|info]]` inside any string a component draws: a status
   or a tag set in the sentence rather than in a row of its own. A word from the
   state list (`CELL_STATES`) takes its tone without being told; `|tone` names
   one (an unknown name is ignored); anything else is neutral. The chip is the `ToneChip`'s wash and colour
   at the run's own size, sitting on the baseline like inline code, so it does
   not push the line apart. */
const CHIP = /\[\[([^[\]|\n]+?)(?:\|\s*([a-z]+)\s*)?\]\]/gi

function InlineChip({ label, named }: { label: string; named?: string }) {
  // A tone the list does not know is no tone: the chip still draws, neutral.
  const tone = TONES.find((t) => t === named?.toLowerCase())
  const state = CELL_STATES[label.trim().toLowerCase()]
  return (
    <span
      className={cn(
        "mx-[0.1em] inline-block rounded-md px-[0.45em] align-baseline text-[0.8125em] leading-[1.5] font-medium whitespace-nowrap",
        TONE_CHIP[tone ?? state?.tone ?? "neutral"]
      )}
    >
      {label.trim()}
    </span>
  )
}

function Inline({ text }: { text: string }) {
  if (!MARKUP.test(text)) return <>{text}</>
  return <InlineMarkdown text={text} components={VIEW_MARKDOWN} />
}

/** A string drawn with its inline markdown and chips. */
export const RichText = React.memo(function RichText({ text }: { text: string }) {
  if (!text.includes("[[")) return <Inline text={text} />
  /* ponytail: markdown is read per run between chips, so `**a [[x]] b**` loses
     its bold across the chip; a remark plugin is the upgrade if a model writes it. */
  const parts: React.ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(CHIP)) {
    if (match.index > last) parts.push(<Inline key={last} text={text.slice(last, match.index)} />)
    parts.push(<InlineChip key={`c${match.index}`} label={match[1]} named={match[2]} />)
    last = match.index + match[0].length
  }
  if (last < text.length) parts.push(<Inline key={last} text={text.slice(last)} />)
  return <>{parts}</>
})
RichText.displayName = "RichText"

/** The same string with its marks taken off — for a decision made about the
    text rather than drawn with it (a numeric column, an aria label). */
export function plainText(text: string): string {
  return text
    .replace(CHIP, "$1")
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim()
}
