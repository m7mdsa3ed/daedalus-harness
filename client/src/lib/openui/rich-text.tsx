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
        "min-w-0 font-medium break-words text-primary",
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
  code: ({ children }) => (
    <code className="rounded-md bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground">{children}</code>
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

/** A string drawn with its inline markdown. */
export const RichText = React.memo(function RichText({ text }: { text: string }) {
  if (!MARKUP.test(text)) return <>{text}</>
  return <InlineMarkdown text={text} components={VIEW_MARKDOWN} />
})
RichText.displayName = "RichText"

/** The same string with its marks taken off — for a decision made about the
    text rather than drawn with it (a numeric column, an aria label). */
export function plainText(text: string): string {
  return text
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim()
}
