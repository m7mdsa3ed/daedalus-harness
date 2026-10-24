/* ── The markdown renderer ──
   `Prose` is what every agent's words are drawn with, and it lives here rather
   than in `tool-parts.tsx` because it has a second caller now: a generated view
   draws its strings with the same pass, so `**Urgent**` and `` `cff4b18` `` read
   the same in a table cell as in an answer. It is not a tool part — it is the
   app's one markdown pipeline — and a module of its own is what lets the view
   import it without importing the whole tool-call surface (and the cycle that
   would close if it did).

   Nothing about the pass changed in the move. It is still react-markdown +
   remark-gfm + rehype-highlight, still block-split while a row streams so the
   settled blocks stop re-parsing, and still one `MarkdownLink` for every link
   the transcript draws. */
import * as React from "react"
import Markdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { splitBlocks } from "@/lib/markdown-blocks"
import { rehypeHighlight } from "@/lib/highlight"
import { fencedBlock } from "@/lib/pretty"
import { PrettyButton, usePretty } from "@/components/ui/pretty-button"
import { TAIL_WORDS, needsTail, rehypeStreamWords, type StreamEffect } from "@/lib/stream-words"
import { CheckIcon, CopyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { writeClipboard } from "@/lib/clipboard"
import { useCoarsePointer } from "@/hooks/use-device"
import { FileLink } from "@/components/file-link"
import { USER_CHIP_COMPONENTS, remarkUserChips } from "@/components/thread-items/user-chips"
import { LinkChip } from "@/components/inline-chip"

/** The plain pass. Exported for the one other place a fenced block is
    highlighted without being prose (a tool call's code preview). */
export const REHYPE = [rehypeHighlight] as never
/* The same pass with the sweep's tail wrapper appended, for the one row being
   written. Held as a constant rather than built per render, since a new array
   identity would make react-markdown rebuild its processor on every revealed
   word — the opposite of what the pacing is for. */
const REHYPE_STREAM = [rehypeHighlight, rehypeStreamWords] as never

const rehypeFor = (stream: StreamEffect | undefined) => (needsTail(stream) ? REHYPE_STREAM : REHYPE)
const REMARK = [remarkGfm]

/* The two elements markdown cannot style from CSS alone.

   A table needs a scroll container that is NOT the table: the usual fix is
   `display: block` on the <table> itself, which does scroll but stops it being
   a table — a block box does not stretch to its container, so `width: 100%`
   silently does nothing and every table renders shrink-wrapped, and the header
   borders no longer line up with the body's. Wrapping keeps `display: table`
   and puts the overflow on a parent that is allowed to have it.

   A link needs the target the renderer will not add. The transcript is a
   long-lived surface — inside Electron and inside a PWA, following a link
   in-place would replace the app, and the turn behind it is not something you
   can navigate back to cheaply. Only absolute http(s) links: an in-page anchor
   (a GFM footnote is one) must stay in the page. */
/* A link is the composer's chip, everywhere `Prose` draws one: the pill says
   the page's title (fetched server-side, `link-preview.ts`) over its host, and
   opens in a new tab. Only a plain-text label chips — an authored `[**bold**]
   (https://…)` keeps its own markup as an ordinary link rather than losing it
   to a label string. */
const MarkdownLink = ({
  node: _node,
  href,
  children,
  ...props
}: React.ComponentProps<"a"> & { node?: unknown }) =>
  /^https?:\/\//i.test(href ?? "")
    ? typeof children === "string" || children === undefined ? (
        <LinkChip url={href ?? ""} text={children} />
      ) : (
        <a {...props} href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      )
    : (
        <a {...props} href={href}>
          {children}
        </a>
      )

/* The fence's declared language, read off the <code> react-markdown nests in
   the <pre> (`language-x`, the same class `lib/highlight` reads). */
function fenceLanguage(children: React.ReactNode): string | undefined {
  const code = React.Children.toArray(children)[0]
  if (!React.isValidElement<{ className?: string }>(code)) return undefined
  return /(?:^|\s)(?:language|lang)-([\w+-]+)/.exec(code.props.className ?? "")?.[1]
}

/* A fenced code block floats a copy affordance over its corner. The text is
   read off the rendered <pre> at click time — rehype-highlight has already
   split it into spans, and a streaming tail keeps rewriting them, so a
   snapshot taken earlier would be stale. Hidden until hover for a fine
   pointer (a transcript is dense with blocks); always shown for touch, which
   has no hover. */
const MarkdownPre = ({
  node: _node,
  ...props
}: React.ComponentProps<"pre"> & { node?: unknown }) => {
  const coarse = useCoarsePointer()
  const [copied, setCopied] = React.useState(false)
  const ref = React.useRef<HTMLPreElement>(null)
  const language = fenceLanguage(props.children)
  const pretty = usePretty(language)

  const copy = async () => {
    try {
      await writeClipboard(pretty.text ?? ref.current?.textContent ?? "")
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* Clipboard is permission-gated; the code is on screen either way. */
    }
  }

  return (
    <div className="group/code relative">
      {pretty.text !== null && language ? (
        /* The laid-out text goes back through the same highlighter, in a plain
           <pre> so the copy and pretty buttons are not drawn a second time. */
        <Markdown rehypePlugins={REHYPE}>{fencedBlock(pretty.text, language)}</Markdown>
      ) : (
        <pre ref={ref} {...props} />
      )}
      <PrettyButton
        language={language}
        pretty={pretty}
        source={() => ref.current?.textContent ?? ""}
        className="right-8"
      />
      <Button
        type="button"
        variant="outline"
        size="icon-xs"
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy"}
        onClick={() => void copy()}
        className={cn(
          "absolute top-1 right-1 bg-popover",
          coarse ? "opacity-100" : "opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100",
        )}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </div>
  )
}

/* Inline code that is an absolute path is a door to the file, like a `FileLink`
   elsewhere. Only a leading `/`: relative names in prose are too often not files.
   `FileLink` itself refuses a path outside the project, and a `:line` suffix is
   dropped because the preview opens the file, not a line. */
const ABS_PATH_RE = /^\/[\w@.+-]+(?:\/[\w@.+-]+)*$/
const MarkdownCode = ({
  node: _node,
  className,
  children,
  ...props
}: React.ComponentProps<"code"> & { node?: unknown }) => {
  const code = <code className={className} {...props}>{children}</code>
  if (className || typeof children !== "string") return code
  const path = children.replace(/:\d+(?:[-:]\d+)?$/, "")
  return ABS_PATH_RE.test(path) ? <FileLink path={path}>{code}</FileLink> : code
}

/* Exported so the one markdown pass can be reused outside the transcript — the
   changelog dialog renders a release's own markdown, and a table or a link there
   should be the same box and the same target `Prose` gives it. */
export const MARKDOWN_COMPONENTS = {
  table: ({ node: _node, ...props }: React.ComponentProps<"table"> & { node?: unknown }) => (
    <div className="harness-table">
      <table {...props} />
    </div>
  ),
  a: MarkdownLink,
  code: MarkdownCode,
  pre: MarkdownPre,
} as never

/* A user bubble's quotes, pastes and `@path` mentions, as the composer's chips
   (`thread-items/user-chips.tsx`). Constants, for the same processor-identity
   reason as the rehype pair above. */
const REMARK_MENTIONS = [remarkGfm, remarkUserChips] as never
const MENTION_COMPONENTS = {
  ...(MARKDOWN_COMPONENTS as object),
  ...USER_CHIP_COMPONENTS,
} as never

const INLINE_MARKDOWN_COMPONENTS = {
  p: ({ node: _node, ...props }: React.ComponentProps<"span"> & { node?: unknown }) => (
    <span {...props} />
  ),
  a: ({
    node: _node,
    href: _href,
    ...props
  }: React.ComponentProps<"a"> & { node?: unknown }) => (
    <span className="font-medium text-primary underline underline-offset-2" {...props} />
  ),
} as never

const INLINE_MARKDOWN_ELEMENTS = ["p", "strong", "em", "del", "code", "a"]

/* Memoized: a long transcript is a thousand of these, and they are the one
   component that runs a real markdown parse (react-markdown + remark-gfm +
   rehype-highlight) per render. The reducer keeps unchanged items referentially
   stable, so a streaming chunk only changes the tail — memo means the hundreds
   above it stop re-parsing their prose on every token. */
export const Prose = React.memo(function Prose({
  text,
  className,
  stream,
  mentions,
}: {
  text: string;
  className?: string;
  /** Set only on the row currently being written: the reveal to draw its tail
      with (`lib/stream-words`). Absent — and `"none"` — is prose painted whole,
      which is every settled row and every replayed one. The attribute is what
      the CSS matches, so it has to be on the element the spans are inside. */
  stream?: StreamEffect;
  /** Draw quotes, pastes and `@path` mentions as the composer's chips — a
      user bubble's, where the syntax is the person's. */
  mentions?: boolean;
}) {
  /* While the row is being written (`stream` set, `"none"` included) it is
     drawn a block at a time, so a painted word re-parses only the block it
     landed in — see `lib/markdown-blocks`. Each block is a fragment, so its
     elements are still direct children of `.prose` and the typography's
     sibling and first/last-child rules read them as one document. Only the
     tail carries the reveal: it is the only block whose words are new.
     Latched for the instance's life: a row that was ever drawn in blocks stays
     in blocks when it settles, so the settle reconciles in place rather than
     swapping the tree for a single <Markdown> — which rebuilt the whole answer
     and dropped any selection or focus in it. A row mounted settled (a replay)
     never streamed and keeps the one parse. */
  const streamed = React.useRef(false)
  if (stream !== undefined) streamed.current = true
  const blocks = streamed.current && !mentions ? splitBlocks(text) : null
  /* A tail shorter than the sweep's ramp folds back into the block before it:
     the ramp is the last `TAIL_WORDS` words of the document, and cutting a new
     paragraph's first word off as the tail snapped the previous one's still-
     fading words to rest all at once. Kept after the settle, so the blocks are
     the same shape either side of it. */
  if (blocks) {
    while (blocks.length > 1 && (blocks[blocks.length - 1].match(/\S+/g)?.length ?? 0) < TAIL_WORDS) {
      const tail = blocks.pop()!
      blocks[blocks.length - 1] += tail
    }
  }
  return (
    <div
      className={cn("prose prose-sm max-w-none", className)}
      data-stream={stream && stream !== "none" ? stream : undefined}
    >
      {blocks ? (
        blocks.map((block, index) => (
          <MarkdownBlock
            key={index}
            text={block}
            rehype={index === blocks.length - 1 ? rehypeFor(stream) : REHYPE}
          />
        ))
      ) : (
        <Markdown
          remarkPlugins={mentions ? REMARK_MENTIONS : REMARK}
          rehypePlugins={rehypeFor(stream)}
          components={mentions ? MENTION_COMPONENTS : MARKDOWN_COMPONENTS}
        >
          {text}
        </Markdown>
      )}
    </div>
  )
})
Prose.displayName = "Prose"

/* One settled block of a streaming answer: the memo is the whole point — a
   block behind the tail is the same string on every word. */
const MarkdownBlock = React.memo(function MarkdownBlock({ text, rehype }: { text: string; rehype: never }) {
  return (
    <Markdown remarkPlugins={REMARK} rehypePlugins={rehype} components={MARKDOWN_COMPONENTS}>
      {text}
    </Markdown>
  )
})

/**
 * Inline markdown for a string drawn inside somebody else's type scale.
 *
 * `Prose` is a document: block elements, its own margins, `.prose` everywhere.
 * This is one line of it — a table cell, a list item, a row's body — so block
 * syntax is unwrapped (`allowedElements`), the `.prose` class is the caller's
 * to add or not, and `components` is how a surface supplies its own link: the
 * generated views pass an anchor that opens an address the reader can see and
 * never resolves a page title over the network (which `MarkdownLink` does).
 *
 * Same processor as prose on purpose: one way a `**bold**` is read, whether it
 * is in an answer or in a cell of the table beside it.
 */
export const InlineMarkdown = React.memo(function InlineMarkdown({
  text,
  components,
}: {
  text: string;
  components?: Components
}) {
  const set = React.useMemo(
    () => ({ ...(INLINE_MARKDOWN_COMPONENTS as object), ...(components as object) }) as never,
    [components]
  )
  return (
    <Markdown
      remarkPlugins={REMARK}
      rehypePlugins={REHYPE}
      components={set}
      allowedElements={INLINE_MARKDOWN_ELEMENTS}
      unwrapDisallowed
    >
      {text}
    </Markdown>
  )
})
InlineMarkdown.displayName = "InlineMarkdown"

/** Markdown for a single-line step preview. Block syntax is unwrapped so the
    row keeps its compact geometry while inline emphasis, code and links render
    the same way they do in the expanded detail. */
export const ProsePreview = React.memo(function ProsePreview({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <span className={cn("prose prose-sm max-w-none", className)}>
      <InlineMarkdown text={text} />
    </span>
  )
})
ProsePreview.displayName = "ProsePreview"
