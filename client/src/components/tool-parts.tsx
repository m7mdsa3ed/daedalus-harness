/* ── Tool-call rendering primitives ──
   The boxes every tool view is built out of: the panes, the code blocks, the
   markdown renderer, the content-block switch. They live apart from
   `thread-items/rows.tsx` (which owns the transcript's own rows) and from
   `tool-views/` (which owns one layout per kind of tool) so that the two
   can share them without importing each other — a tool view needs a pane, and
   the transcript needs to draw a tool view, and a cycle between those two is
   what splitting this file out of the middle avoids. */
import * as React from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { rehypeHighlight } from "@/lib/highlight"
import { needsTail, rehypeStreamWords, type StreamEffect } from "@/lib/stream-words"
import type * as acp from "@daedalus/acp"
import {
  ArrowLeftRightIcon,
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  CopyIcon,
  CornerDownRightIcon,
  FileTextIcon,
  GlobeIcon,
  Maximize2Icon,
  PencilLineIcon,
  SearchIcon,
  SquareTerminalIcon,
  ToggleLeftIcon,
  Trash2Icon,
} from "lucide-react"
import { ErrorBoundary } from "@/components/error-boundary"
import { Notice } from "@/components/notice"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { CopyButton } from "@/components/ui/copy-button"
import { DiffView } from "@/components/ui/diff-view"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import { isPlainClick, useThreadLinks } from "@/lib/workspace/thread-links"
import {
  fileRangeOf,
  formatRange,
  hostOf,
  safeJson,
  shortPath,
  splitCommand,
  toolKindOf,
  toolLanguage,
  type FileRange,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"
import { useViewOptionsContext } from "@/lib/view-options"
import { writeClipboard } from "@/lib/clipboard"
import { useCoarsePointer } from "@/hooks/use-device"
import { recoverUnfencedOpenui } from "@/lib/openui/recover-unfenced"
import { FileLink, FileMention, remarkMentions } from "@/components/file-link"

export const KIND_LABELS: Record<string, string> = {
  read: "read",
  edit: "edit",
  delete: "delete",
  move: "move",
  search: "search",
  execute: "run",
  think: "think",
  fetch: "fetch",
  switch_mode: "mode",
  other: "tool",
}

export const KIND_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  read: FileTextIcon,
  edit: PencilLineIcon,
  delete: Trash2Icon,
  move: ArrowLeftRightIcon,
  search: SearchIcon,
  execute: SquareTerminalIcon,
  think: BrainIcon,
  fetch: GlobeIcon,
  switch_mode: ToggleLeftIcon,
}

/* One colour language for the transcript's work marks, shared by the step-row
   icons and the group-row avatar stack: a shell command is the quiet terminal
   grey, a thought the thinking blue, and everything else a tool does the
   violet of work on the files. Keyed by the same kinds KIND_ICONS is, so a
   row and its icon never disagree. The hues come from the `--step-*` tokens
   in index.css, so a custom theme can move all three at once. */
export const KIND_COLORS: Record<string, string> = {
  think: "text-step-think",
  execute: "text-step-command",
  other: "text-step-tool",
}

/* The same map as the tinted tile a step row's mark sits on — the `/15` of
   the avatar stack, so a coloured icon wears its own background instead of
   floating transparent. Keyed by the same kinds, so a row's mark and its
   tile never disagree. */
export const KIND_CHIPS: Record<string, string> = {
  think: "bg-step-think/15",
  execute: "bg-step-command/15",
  other: "bg-step-tool/15",
}

/* Prose palette + code/table styling live in index.css, so both themes come
   from the app tokens — no prose-invert needed. */
/* Highlighting is `lib/highlight.ts` now, not `rehype-highlight`: the walk is
   the same, the grammar registry is a named list instead of lowlight's whole
   `common` set, and the ~180KB gzipped that used to sit in the entry chunk for
   every cold load is gone. It only colours a fence that declares its language,
   for the reason it always did — left to guess, highlight.js cheerfully
   "detects" a shell transcript as Perl. */
/* How tall an inline output pane grows before it starts scrolling.

   Relative rather than the fixed 16rem this used to be: 256px is a reasonable
   slab in a tall panel and about four lines in a short one, where it reads as
   truncated rather than as scrollable — and a table or a fenced block inside a
   box that short is a scroll region you have to fight. The cap still exists,
   because an unbounded pane in a transcript pushes everything after it off the
   screen; it is just tall enough now that scrolling is the exception.

   The fraction is of the *panel* (`--panel-h`, published by
   `workspace/panel-container`), not the viewport: a transcript docked under a
   terminal is a third of the window tall, and 60vh there is a pane taller than
   the thing it is in. Outside the dock the var is unset and the fallback makes
   it the viewport again. */
export const PANE_MAX_H = "max-h-[min(calc(var(--panel-h,100svh)*0.6),28rem)]"

/* ── The transcript's shared shapes ──
   One spelling each for a pane, a card, a caption and a disclosure, because
   the alternative is what was here: two washes for the same box (`bg-muted/30`
   and `/40`), three card geometries (`rounded-xl px-3 py-2.5`, `rounded-lg
   px-4 py-3`, `my-1.5` vs `my-2`) and three section labels. A row that adds
   one of these reaches for the constant; a theme that moves `--radius` moves
   all of them, which a bare `rounded` (a hardcoded 0.25rem — Tailwind defines
   no default radius from this theme) never did. */

/** A payload's box: rows drawn inside it supply their own padding. */
export const PANE = "overflow-hidden rounded-md border border-border/50 bg-muted/40"

/** The same box with its own padding, for a pane holding one thing rather than
    a list of rows (a brief, a plan, tool prose, a code block). */
export const PANE_PAD = "rounded-md border border-border/50 bg-muted/40 px-2.5 py-2"

/** A recessed block inside a pane — a heredoc body, an unfolded stack trace. */
export const INSET = "rounded-sm border border-border/50 bg-background/50"

/** A notice that is its own object in the flow rather than a step: an error, a
    task reporting back, an agent's demarcated block, a pasted blob. The tone
    (border and wash) is the caller's; the geometry is not. */
export const CARD = "my-2 rounded-xl border px-3 py-2.5"

/** The caption over a section of a step's detail, and over anything else that
    is a group of rows with a name. */
export const LABEL =
  "text-[10px] font-semibold tracking-[0.08em] uppercase text-muted-foreground/50"

/** The "Show details" / "Hide result" line every card folds its payload behind.
    One component rather than three copies of the same flex row, so the chevron
    turns the same way and sits at the same size wherever it is drawn. */
export function Disclosure({
  open,
  onToggle,
  children,
  className,
}: {
  open: boolean
  onToggle: () => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "flex w-fit items-center gap-1 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground",
        className
      )}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform duration-200", open && "rotate-90")}
      />
      {children}
    </button>
  )
}

const REHYPE = [rehypeHighlight] as never
/* The same pass with the tail wrapper appended, for the one row being written.
   Two arrays, because only the edge family needs each span stamped with its
   distance from the edge; both are held as constants rather than built per render, since
   a new array identity would make react-markdown rebuild its processor on every
   revealed word — the opposite of what the pacing is for. */
const REHYPE_STREAM = [rehypeHighlight, [rehypeStreamWords, { tail: false }]] as never
const REHYPE_STREAM_TAIL = [rehypeHighlight, [rehypeStreamWords, { tail: true }]] as never

const rehypeFor = (stream: StreamEffect | undefined) =>
  needsTail(stream) ? REHYPE_STREAM_TAIL : stream && stream !== "none" ? REHYPE_STREAM : REHYPE
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
const MarkdownLink = ({
  node: _node,
  href,
  ...props
}: React.ComponentProps<"a"> & { node?: unknown }) =>
  /^https?:\/\//i.test(href ?? "") ? (
    <a {...props} href={href} target="_blank" rel="noreferrer noopener" />
  ) : (
    <a {...props} href={href} />
  )

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

  const copy = async () => {
    try {
      await writeClipboard(ref.current?.textContent ?? "")
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* Clipboard is permission-gated; the code is on screen either way. */
    }
  }

  return (
    <div className="group/code relative">
      <pre ref={ref} {...props} />
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy"}
        onClick={() => void copy()}
        className={cn(
          "absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-md border border-border/60 bg-popover/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-colors hover:text-foreground focus-visible:outline-hidden",
          coarse ? "opacity-100" : "opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100",
        )}
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </button>
    </div>
  )
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
  pre: MarkdownPre,
} as never

/* A user bubble's `@path` mentions, as links into the Preview panel. Constants,
   for the same processor-identity reason as the rehype pair above. */
const REMARK_MENTIONS = [remarkGfm, remarkMentions] as never
const MENTION_COMPONENTS = {
  ...(MARKDOWN_COMPONENTS as object),
  "file-mention": FileMention,
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
  /** Draw `@path` mentions as links (`components/file-link.tsx`) — a user
      bubble's, where the syntax is the person's. */
  mentions?: boolean;
}) {
  return (
    <div
      className={cn("prose prose-sm max-w-none", className)}
      data-stream={stream && stream !== "none" ? stream : undefined}
    >
      <Markdown
        remarkPlugins={mentions ? REMARK_MENTIONS : REMARK}
        rehypePlugins={rehypeFor(stream)}
        components={mentions ? MENTION_COMPONENTS : MARKDOWN_COMPONENTS}
      >
        {text}
      </Markdown>
    </div>
  )
})
Prose.displayName = "Prose"

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
      <Markdown
        remarkPlugins={REMARK}
        rehypePlugins={REHYPE}
        components={INLINE_MARKDOWN_COMPONENTS}
        allowedElements={INLINE_MARKDOWN_ELEMENTS}
        unwrapDisallowed
      >
        {text}
      </Markdown>
    </span>
  )
})
ProsePreview.displayName = "ProsePreview"

/**
 * A plan, read at full size. Both places a plan proposal is drawn — the
 * approval card at the tail of the transcript and the settled `plan` tool view
 * — show it inside a band that stops at half the panel, because the answers
 * below it must stay on screen and a transcript column is narrow. That is the
 * right default and the wrong ceiling: a forty-step plan is a document, and
 * reading one through a half-panel window that is also being scrolled by the
 * stream is what this is the way out of.
 *
 * So it is an *option*, never a replacement: the inline plan stays exactly
 * where it was and this opens the same markdown in a dialog the size of the
 * window. It is a reader and nothing else — no answers ride in here, since the
 * card keeps its action bar and a dialog covering the transcript is the wrong
 * place to be asked something. Escape closes it and, because `overlayOpen()`
 * sees an open `role="dialog"`, the thread's own Escape/digit/Enter bindings
 * stand down while it is up, so closing the reader can never also answer the
 * permission behind it.
 */
export function PlanFullscreen({
  plan,
  title,
  className,
}: {
  plan: string
  title?: string | null
  className?: string
}) {
  return (
    <Dialog>
      <DialogTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex w-fit items-center gap-1 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground",
              className
            )}
          />
        }
      >
        <Maximize2Icon aria-hidden className="size-3" />
        Full screen
      </DialogTrigger>
      {/* Nearly the whole window: a plan is the one payload where the limit on
          reading it was the room, and `pr-12` clears the dialog's own close
          button the way the workflow dialog's header does. */}
      <DialogContent className="flex h-[calc(100svh-2rem)] w-[min(64rem,calc(100vw-1rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-2rem)]">
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border/40 py-3 pr-12 pl-4">
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground/70"
          >
            <ClipboardListIcon className="size-4" />
          </span>
          <DialogTitle className="min-w-0 flex-1 truncate text-sm leading-4 font-medium">
            {title || "Plan"}
          </DialogTitle>
        </div>
        <div className="min-h-0 flex-1 overflow-auto overscroll-contain px-5 py-4">
          <Prose text={plan} />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* Agents stream output as many small text blocks (one per result, per line).
   Rendering a bordered box per block turns six one-liners into six panels —
   consecutive text is one stream, so it gets one block. */
export function mergeText(content: acp.ToolCallContent[]): acp.ToolCallContent[] {
  const merged: acp.ToolCallContent[] = []
  for (const part of content) {
    const prev = merged[merged.length - 1]
    if (
      part.type === "content" &&
      part.content.type === "text" &&
      prev?.type === "content" &&
      prev.content.type === "text"
    ) {
      merged[merged.length - 1] = {
        ...prev,
        content: { ...prev.content, text: `${prev.content.text}\n${part.content.text}` },
      }
    } else {
      merged.push(part)
    }
  }
  return merged
}

/** A captioned block inside a step's detail. The three sections used to run
    together as undifferentiated grey, so you could not tell what the tool was
    asked from what it answered. */
export function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 space-y-1">
      <h4 className={LABEL}>{label}</h4>
      {children}
    </section>
  )
}

const isScalar = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value)

/** How many levels of a tool call's arguments open on their own. Deeper than
    the one `SmartBlock` gives a payload, because these are the thing you
    opened the step to read rather than something it happened to return — see
    the JSON block below. Exported because the approval card draws the same
    arguments the same way (`tool-approval.tsx`), and a card and a step that
    disagreed about how far the tree opens would read as two readers. */
export const JSON_INPUT_PREVIEW = 3

/** What the tool was called with. A flat object — the overwhelmingly common
    shape — becomes a key/value table, because `{"command":"pnpm build"}` is
    JSON noise around the one word you wanted. Anything that is a shape rather
    than a greeting becomes a tree, which is the same JSON read as structure
    instead of as lines to scan. */
export function ToolInput({ item }: { item: ToolItem }) {
  const input = item.rawInput
  const language = toolLanguage(item)
  if (input === null || input === undefined) return null
  if (typeof input === "string") {
    return input.trim() ? <CodeBlock language={language}>{input}</CodeBlock> : null
  }
  if (isScalar(input)) return <CodeBlock language={language}>{String(input)}</CodeBlock>
  if (Array.isArray(input)) return <JsonView value={input} text={safeJson(input)} preview={JSON_INPUT_PREVIEW} />

  const entries =
    typeof input === "object" && !Array.isArray(input)
      ? Object.entries(input as Record<string, unknown>)
      : null
  if (entries && entries.length > 0 && entries.every(([, value]) => isScalar(value))) {
    return (
      /* Body tier, not caption tier: these are the tool's actual arguments —
         the thing you read — so they match message prose. `text-[11px]` is for
         labels and counters. */
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-xs">
        {entries.map(([key, value]) => (
          <React.Fragment key={key}>
            <dt className="text-muted-foreground/60">{key}</dt>
            <dd className="min-w-0 break-words whitespace-pre-wrap text-foreground/80">
              {value === null ? "null" : String(value)}
            </dd>
          </React.Fragment>
        ))}
      </dl>
    )
  }
  return <JsonView value={input} text={safeJson(input)} preview={JSON_INPUT_PREVIEW} />
}

/**
 * The files a tool call touched.
 *
 * Clickable only inside a workspace — `useThreadLinks` is null anywhere else,
 * and a path that looks like a link and does nothing is worse than one that
 * plainly is not. An edit also offers its diff against the last commit, which
 * is the question you actually have about an agent's write: not "what does this
 * file say" but "what did it just change".
 */
export function ToolLocations({ item }: { item: ToolItem }) {
  return (
    <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground/80">
      {item.locations.map((location, index) => {
        const range = fileRangeOf(item, location)
        const label = `${location.path}${range ? `:${formatRange(range)}` : ""}`
        return <li key={index} className="truncate">{label}</li>
      })}
    </ul>
  )
}

/* ── The openui view ──

   A fenced `openui` block is not a code block. The model writes a program in a
   compact line-oriented language (`client/src/lib/openui/library.tsx` holds the
   component table it may name), and what belongs on screen is the UI it
   describes, not the source.

   Three things about where this lives:

   — **it stands where the fence stood**, inline in the message that carried it
     and in that message's own column. Not in a tool-output pane: it is a
     replacement for a fenced block, a fenced block in prose is inline, and
     boxing it would make an answer's own words and its picture two surfaces
     when they are one answer;
   — **an unclosed fence draws too, from the moment it opens.** This is what the
     language is *for*: `root` comes first so the shell appears at once, and a
     forward reference resolves when its statement arrives, so the view fills in
     over the answer rather than appearing once at the end. Drawing a partial
     program is not a compromise on streaming — it is the design. What it
     demands is that the drawing be forgiving, which is why `openui-view.tsx`
     suspends its "came out empty" verdict while the row is still being written:
     a one-line program is legitimately an empty shell.
   — **parse failures fall back to the source.** An agent that puts a fenced
     `openui` heading on a doc block gets its text read, not a box saying "could
     not render".

   The view is deliberately inert: no `toolProvider` is passed, so a `Query()`
   in the program has no tool to reach and is dropped — which is the boundary
   this feature is built on (see the library's header comment). */

/* The fence tag the generated prompt tells the model to write. `openui` alone
   is accepted too — it is the shorter name a model reaches for unprompted, and
   a fence that means this should draw rather than fall through to the source. */
const OPENUI_LANG = "openui-lang"

/** An openui fenced block found in a message, and the text around it. */
interface OpenuiFence {
  start: number
  end: number
  code: string
  /** The closing ``` has not arrived yet — the model is still writing this
      program. Only ever true for the last fence in a live row. */
  open: boolean
}

/* Two patterns, because the two cases are genuinely different and a single one
   gets one of them wrong. Closed first: a completed fence is paired with its own
   terminator, and that matters when a message holds more than one. */
const OPENUI_FENCE_CLOSED_RE =
  /(^|\n)[ \t]*```+[ \t]*openui(?:-lang)?[ \t]*\r?\n([\s\S]*?)```+[ \t]*(?=\n|$)/g

/* A fence still being written: the info string and its newline have arrived, the
   closing run has not. Requires the newline, so the partial *info string* itself
   (` ```openui-lan `) stays prose until the model finishes typing it. */
const OPENUI_FENCE_OPEN_RE = /(^|\n)[ \t]*```+[ \t]*openui(?:-lang)?[ \t]*\r?\n([\s\S]*)$/

/**
 * Split a message into prose runs and openui fences.
 *
 * `streaming` is what allows a trailing, unclosed fence to be drawn; a settled
 * row never has one, since a fence the model never closed is not a program.
 */
function splitOpenuiFences(text: string, streaming: boolean): (string | OpenuiFence)[] {
  const parts: (string | OpenuiFence)[] = []
  let cut = 0
  for (const match of text.matchAll(OPENUI_FENCE_CLOSED_RE)) {
    const start = match.index + match[1].length
    const end = start + match[0].length - match[1].length
    if (start > cut) parts.push(text.slice(cut, start))
    parts.push({ start, end, code: match[2], open: false })
    cut = end
  }
  const rest = text.slice(cut)
  const pending = streaming ? OPENUI_FENCE_OPEN_RE.exec(rest) : null
  if (pending) {
    const start = cut + pending.index + pending[1].length
    if (start > cut) parts.push(text.slice(cut, start))
    parts.push({ start, end: text.length, code: pending[2], open: true })
  } else if (rest) {
    parts.push(rest)
  }
  return parts
}

/**
 * One generated view, drawn from the program in `code`.
 *
 * The renderer is scheduled rather than imported outright. Every reader of a
 * transcript loads this module, and the vast majority of turns never write an
 * openui fence — so the parser, the library and recharts are reached only by a
 * fence that has already been found, and the suspense fallback is the source
 * pane that was there before it arrived. `React.lazy` only fires the import the
 * first time a fence actually renders, which also keeps a module that recharts
 * pulls in out of the entry chunk.
 */
const OpenuiView = React.lazy(() =>
  import("@/components/openui-view").then((module) => ({ default: module.OpenuiView }))
)

function OpenuiFenceView({ code, open }: { code: string; open: boolean }) {
  /* The imports are one shared chunk, so a second fence on the same screen is
     the same lazy component — no per-view identity games there. */
  return (
    <React.Suspense fallback={<Prose text={"```" + OPENUI_LANG + "\n" + code + "\n```"} />}>
      <ErrorBoundary name="openui view" resetKeys={[code]} key={code}>
        <OpenuiView code={code} streaming={open} />
      </ErrorBoundary>
    </React.Suspense>
  )
}

/**
 * Prose that may hold generated views.
 *
 * It is not a markdown plugin: a plugin would have to claim the fence from
 * inside the parse and hand a React node back out of it. Splitting the text
 * first and handing each run to `Prose` keeps every markdown behaviour a reader
 * already knows — the tables, the streaming reveal on the tail run — because
 * those runs are still `Prose`.
 *
 * The tail run takes `stream` so the reveal ends where it always did. A view
 * takes it too, as `streaming` — not for the reveal, but because it is what says
 * a fence may legitimately be half-written, which suspends the view's "came out
 * empty" verdict until the row settles.
 */
export function ProseWithOpenui({
  text,
  stream,
  className,
  streaming = false,
}: {
  text: string
  stream?: StreamEffect
  className?: string
  /** The row is still being written, so a trailing unclosed fence is a program
      in progress rather than a fence the model forgot to close. */
  streaming?: boolean
}) {
  const parts = React.useMemo(() => {
    if (text.includes("```")) {
      const split = splitOpenuiFences(text, streaming)
      if (split.some((part) => typeof part !== "string")) return { kind: "parts" as const, split }
    }
    if (!streaming) {
      const recovered = recoverUnfencedOpenui(text)
      if (recovered) return { kind: "recovered" as const, ...recovered }
    }
    return null
  }, [text, streaming])
  if (!parts) return <Prose text={text} stream={stream} className={className} />
  if (parts.kind === "recovered") {
    return (
      <div className={cn("min-w-0 space-y-2", className)}>
        <Notice tone="info" size="sm" title="Recovered OpenUI view">
          This reply looked like an unfenced OpenUI program. It was recovered for display; the original reply is unchanged.
        </Notice>
        <OpenuiFenceView code={parts.code} open={false} />
        {parts.remainder && <ProseWithOpenui text={parts.remainder} />}
      </div>
    )
  }
  const split = parts.split

  return (
    /* The same gap the view's own sections keep, so prose and a drawn view
       sit as one rhythm instead of touching. */
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {split.map((part, index) =>
        typeof part === "string" ? (
          /* Keyed by offset, not by index: a chunk arriving at the tail must not
             make React tear down and rebuild the prose above it. */
          <Prose key={`t${index}`} text={part} stream={index === split.length - 1 ? stream : undefined} />
        ) : (
          <OpenuiFenceView key={`f${part.start}`} code={part.code} open={part.open} />
        )
      )}
    </div>
  )
}

/** Tool output as markdown. Agents write it as markdown — tables, lists, fenced
    code — and a `pre` rendered all of that as literal pipes and backticks. */
export function ToolProse({ text }: { text: string }) {
  if (!text.trim()) return null
  return (
    <div className={cn(PANE_MAX_H, PANE_PAD, "min-w-0 overflow-auto")}>
      {/* No size utility: the unlayered `.prose` rule in index.css sets the body
          size and outranks any `text-*` utility on this element — the
          `text-[11px]` that used to be here never applied, which is half of why
          tool output and message prose disagreed. Same <Prose> as a message for
          the other half: one component means a table or a link cannot render
          one way in a turn and another way in tool output. */}
      <Prose text={text} />
    </div>
  )
}

/**
 * Syntax-coloured code with no chrome of its own — the caller supplies the box.
 * Highlighting rides on the Markdown renderer's own plugin (one pipeline, one
 * theme) rather than a second highlighter wired up here, so a payload is
 * wrapped in a fence and handed over.
 */
export function Highlighted({
  code,
  language,
  className,
}: {
  code: string
  language?: string
  className?: string
}) {
  // A payload containing its own fence would break out of ours; leave it plain.
  if (!language || code.includes("```")) {
    return <pre className={cn("font-mono text-xs whitespace-pre-wrap", className)}>{code}</pre>
  }
  return (
    <div className={cn("harness-code-bare prose prose-sm max-w-none", className)}>
      <Markdown rehypePlugins={REHYPE}>{"```" + language + "\n" + code.replace(/\n$/, "") + "\n```"}</Markdown>
    </div>
  )
}

/**
 * A shell command, with any heredoc bodies lifted out into their own blocks.
 * `python3 - <<'PY'` is two languages in one string; rendering it as one paints
 * the Python in shell colours and hides where the script starts and stops. The
 * body's box IS its terminator, so the closing delimiter line is absorbed
 * rather than left dangling under the block.
 */
export function ShellScript({ command, className }: { command: string; className?: string }) {
  const segments = React.useMemo(() => splitCommand(command), [command])
  if (segments.length <= 1) {
    return <Highlighted code={command} language="bash" className={className} />
  }
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      {segments.map((segment, index) =>
        segment.kind === "shell" ? (
          <Highlighted key={index} code={segment.text} language="bash" />
        ) : (
          <div key={index} className={cn(INSET, "overflow-hidden")}>
            <div className="flex items-center gap-1.5 border-b border-border/50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground/70">
              <CornerDownRightIcon aria-hidden className="size-3 shrink-0" />
              <span>{segment.label}</span>
              {segment.language && <span className="opacity-70">· {segment.language}</span>}
            </div>
            <div className={cn(PANE_MAX_H, "overflow-auto px-2 py-1")}>
              <Highlighted code={segment.text} language={segment.language} />
            </div>
          </div>
        )
      )}
    </div>
  )
}

export function CodeBlock({
  children,
  tone,
  language,
}: {
  children: string
  tone?: "error"
  language?: string
}) {
  const pane = (
    <div
      className={cn(
        PANE_MAX_H,
        "w-fit max-w-full overflow-auto",
        tone === "error"
          ? /* `pr-9` reserves the corner the copy below floats in, so a long
               single-line stack trace is not read with its tail under a
               button. */
            "rounded-md border border-destructive/40 bg-destructive/5 py-2 pl-2.5 pr-9 text-destructive"
          : PANE_PAD
      )}
    >
      {/* Errors stay uncoloured: a stack trace highlighted as code competes with
          the destructive tint that is the actual signal. */}
      {tone !== "error" && language === "bash" ? (
        <ShellScript command={children} />
      ) : (
        <Highlighted code={children} language={tone === "error" ? undefined : language} />
      )}
    </div>
  )
  if (tone !== "error") return pane
  /* The one place every failed tool call ends up — an MCP error, a non-zero
     bash run, a failed read, a fetch that 500'd all arrive here through
     `SmartBlock`, so the copy they each needed is written once.

     Outside the pane, not in it: the pane is the scroll container, and a
     button positioned inside one scrolls away with the stack trace it is meant
     to lift out. Always drawn rather than revealed on hover, because a
     failure is read on touch as often as with a pointer. */
  return (
    <div className="relative w-fit max-w-full">
      {pane}
      <CopyButton
        text={children}
        size="icon-xs"
        className="absolute top-1 right-1 bg-destructive/5 text-destructive/70 backdrop-blur-sm hover:bg-destructive/15 hover:text-destructive"
      />
    </div>
  )
}

const LOOKS_LIKE_MARKDOWN = /(^|\n)\s*(#{1,6} |[-*+] |\d+\. |> |\|)|\*\*|```/

/** Payload of unknown shape: JSON as fenced JSON, markdown as markdown, and
    anything else verbatim. Guessing wrong on prose is cheap; guessing wrong on
    a log file mangles it, so the plain block is the default. */
export function SmartBlock({
  text,
  tone,
  language,
}: {
  text: string
  tone?: "error"
  language?: string
}) {
  const trimmed = text.trim()
  if (!trimmed) return null
  /* JSON is a shape before it is text, so it reaches the tree — unless it is an
     error, where the payload is read for what went wrong rather than parsed,
     and the failure's own code block is what carries the Copy. */
  if (tone !== "error") {
    const json = parseJsonDocument(trimmed)
    if (json !== null) return <JsonView value={json.value} text={trimmed} />
  }
  if (tone !== "error" && LOOKS_LIKE_MARKDOWN.test(trimmed)) {
    return <ToolProse text={trimmed} />
  }
  return (
    <CodeBlock tone={tone} language={language}>
      {text}
    </CodeBlock>
  )
}

/* Output past this many characters is cut, with a button to take the cap off.
   A scroll container alone still pays to lay out every line of a 5MB log. */
export const OUTPUT_LIMIT = 8_000

export function useShowAll(text: string, limit = OUTPUT_LIMIT): [string, boolean, () => void] {
  const [all, setAll] = React.useState(false)
  const over = !all && text.length > limit
  return [over ? `${text.slice(0, limit).trimEnd()}\n…` : text, over, () => setAll(true)]
}

export function ShowAll({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    >
      Show everything
    </button>
  )
}

/* ── JSON, as a tree ──
   A tool's arguments and an MCP server's result are usually a *shape* — an
   object with four keys, an array of records — and pretty-printed JSON is a
   wall of text you read by scanning lines and matching braces by eye. This is
   the same bytes as a tree: a node you can fold, a key you can see, a value
   coloured by what it is.

   Four things decided for it:

   — **It replaces the JSON block, not the code block.** `SmartBlock` calls it
   only for payloads that actually parse: a log file that happens to start with
   `{` is prose, and a tree that refuses to draw it would be worse than the
   blob it was handed. A payload that does not parse falls back to the block
   that was there before.

   — **`preview` is the caller's, because the payload is not the same thing on
   both sides.** A call's *arguments* are what you came to read, so they open a
   level or two; a *result* is what you asked for and only sometimes a shape,
   so it opens one and the summary line says whether to open the rest.

   — **The children are capped and the cap is a row.** A `{"data": [ … ]}` with
   ten thousand entries is one render away from locking the transcript up, so
   past the cap the list stops and offers the rest — the same bargain
   `OUTPUT_LIMIT`, `ShowAll` and `DiffView`'s `MAX_LINES` each make in their own
   place.

   — **Nothing here is a vendor's.** This is the harness's own reader for the
   one serialization every runtime's tool call arrives in, so it belongs beside
   the panes rather than in `tool-views/`. */

const JSON_CHILD_LIMIT = 300
const JSON_SUMMARY_ITEMS = 4
const JSON_SUMMARY_LEN = 72

/** One value on a folded node's own line: a string stays quoted, an array or an
    object shows only the shape of itself, everything else is itself. */
function jsonAtom(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return "[…]"
  if (value !== null && typeof value === "object") return "{…}"
  return String(value)
}

/** What a folded node holds, on the node's own line. Deliberately plain rather
    than coloured: the colours are for values you can read, and this is for
    deciding whether to read them. */
function jsonSummary(value: unknown): string {
  const entries = Array.isArray(value)
    ? value.map(jsonAtom)
    : Object.entries(value as Record<string, unknown>).map(([key, inner]) => `${key}: ${jsonAtom(inner)}`)
  const shown = entries.slice(0, JSON_SUMMARY_ITEMS).join(", ")
  const text = entries.length > JSON_SUMMARY_ITEMS ? `${shown}, …` : shown
  return text.length > JSON_SUMMARY_LEN ? `${text.slice(0, JSON_SUMMARY_LEN)}…` : text
}

/** A JSON value that is not a container. `null` is its own colour because it
    is the one value whose *text* is also a word — `null` in the string green
    of a value that happens to say "null" reads as a mistake. */
function JsonLeaf({ value }: { value: unknown }) {
  if (value === null) return <span className="italic text-code-punctuation">null</span>
  if (typeof value === "string") return <span className="text-code-string">{JSON.stringify(value)}</span>
  if (typeof value === "number") return <span className="text-code-number">{String(value)}</span>
  if (typeof value === "boolean") return <span className="text-code-boolean">{String(value)}</span>
  return <span className="text-code-punctuation">{String(value)}</span>
}

/**
 * One node of the tree.
 *
 * `name` is the key it hangs under and `index` the position it holds in an
 * array — array children are numbered rather than keyed, and only the number is
 * drawn, quietly, because `"0": "a"` is a key that does not exist. `depth` is
 * read once and only to decide whether it starts open; folding a node does not
 * re-fold what is under it, so what you opened stays open.
 */
function JsonNode({
  name,
  index,
  value,
  depth,
  preview,
  last,
}: {
  name: string | null
  index: number | null
  value: unknown
  depth: number
  preview: number
  last: boolean
}) {
  const composite = value !== null && typeof value === "object"
  const [open, setOpen] = React.useState(composite && depth < preview)
  const [showAll, setShowAll] = React.useState(false)
  const comma = !last && <span className="text-code-punctuation">,</span>

  const toggle = (event: React.MouseEvent) => {
    /* A click that has a selection in it is a reader copying the tree, not
       folding it — collapsing the row out from under their drag is the one
       thing this could do that they did not ask for. */
    if (window.getSelection()?.toString()) return
    event.stopPropagation()
    setOpen((was) => !was)
  }

  const list = Array.isArray(value)
  /* Keys and indices kept apart rather than one `string | number`: React needs
     the key to be unique among siblings and a `"0"` key beside a `0` index is
     a collision, while what is *drawn* differs too — a number is written
     quietly and a key in the key colour. */
  const entries: { key: string; name: string | null; index: number | null; value: unknown }[] =
    !composite
      ? []
      : list
        ? (value as unknown[]).map((entry, i) => ({ key: String(i), name: null, index: i, value: entry }))
        : Object.entries(value as Record<string, unknown>).map(([key, entry]) => ({
            key,
            name: key,
            index: null,
            value: entry,
          }))
  const brackets = list ? (["[", "]"] as const) : (["{", "}"] as const)

  /* A scalar and an *empty* container are the same row — there is nothing to
     fold, so there is no trigger, and `{}` is a value rather than a closed
     node. The chevron is drawn invisible rather than omitted so a key sits at
     the same x whether its value is a string or an object; in a mixed list
     that is the difference between reading a column and reading a staircase. */
  if (!composite || entries.length === 0) {
    return (
      <div className="flex flex-wrap items-baseline gap-x-1 font-mono text-[11px] leading-5">
        <ChevronRightIcon aria-hidden className="invisible size-3 shrink-0" />
        {index !== null && <span className="text-muted-foreground/50">{index}</span>}
        {name !== null && <span className="text-code-key">{name}</span>}
        {name !== null && <span className="text-code-punctuation">:</span>}
        {composite ? (
          <span className="text-code-punctuation">
            {brackets[0]}
            {brackets[1]}
          </span>
        ) : (
          <JsonLeaf value={value} />
        )}
        {comma}
      </div>
    )
  }

  const capped = !showAll && entries.length > JSON_CHILD_LIMIT
  const visible = capped ? entries.slice(0, JSON_CHILD_LIMIT) : entries

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-baseline gap-1 rounded-sm text-left font-mono text-[11px] leading-5 outline-hidden hover:bg-muted/60 focus-visible:bg-muted/60"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 translate-y-[3px] text-muted-foreground/50 transition-transform",
            open && "rotate-90"
          )}
        />
        {index !== null && <span className="text-muted-foreground/50">{index}</span>}
        {name !== null && <span className="text-code-key">{name}</span>}
        {name !== null && <span className="text-code-punctuation">:</span>}
        <span className="text-code-punctuation">{brackets[0]}</span>
        {/* Folded: what it holds, and its own closing bracket, so the line
            reads as the whole value rather than as an opening brace. */}
        {!open && (
          <span className="min-w-0 truncate">
            <span className="text-muted-foreground/70">{jsonSummary(value)}</span>
            <span className="text-code-punctuation">{brackets[1]}</span>
          </span>
        )}
        {!open && comma}
      </button>
      {open && entries.length > 0 && (
        <>
          {/* The rail is the child container's own edge rather than a drawn
              line, so every level of the tree hangs off the last by one
              indent — `ms-1.5` puts it under the chevron it belongs to. */}
          <div className="ms-1.5 border-s border-border/50 ps-2">
            {visible.map((entry, position) => (
              <JsonNode
                key={entry.key}
                name={entry.name}
                index={entry.index}
                value={entry.value}
                depth={depth + 1}
                preview={preview}
                last={position === visible.length - 1 && !capped}
              />
            ))}
            {capped && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="font-mono text-[11px] leading-5 text-muted-foreground/70 transition-colors hover:text-foreground"
              >
                {entries.length - JSON_CHILD_LIMIT} more …
              </button>
            )}
          </div>
          <div className="flex gap-1 font-mono text-[11px] leading-5 ps-4">
            <span className="text-code-punctuation">{brackets[1]}</span>
            {comma}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * A JSON document as a tree.
 *
 * `text` is the source the tree was read from — what Copy hands back, byte for
 * byte, so a copy is the JSON and not a re-serialization of it.
 */
export function JsonView({
  value,
  text,
  preview = 1,
  className,
}: {
  value: unknown
  text: string
  /** How many levels open on their own. Zero is the whole document folded. */
  preview?: number
  className?: string
}) {
  const coarse = useCoarsePointer()
  return (
    <div className={cn("group/json relative", className)}>
      <div className={cn(PANE, PANE_MAX_H, "overflow-auto px-2 py-1.5")}>
        <JsonNode name={null} index={null} value={value} depth={0} preview={preview} last />
      </div>
      {/* The copy rides the tree the way it rides a fenced block — hover on a
          fine pointer, always on touch, where there is no hover to reveal it. */}
      <CopyButton
        text={text}
        size="icon-xs"
        className={cn(
          "absolute top-1 right-1 bg-popover/90 text-muted-foreground/70 backdrop-blur-sm transition-opacity hover:text-foreground",
          coarse ? "opacity-100" : "opacity-0 group-hover/json:opacity-100 focus-visible:opacity-100"
        )}
      />
    </div>
  )
}

/** A payload that is a JSON document, or null.
 *
 * The first-character guard is not a correctness check — the parse is — but it
 * is what keeps a five-megabyte log file from being handed to `JSON.parse` on
 * every render just to be told it is a log file. */
function parseJsonDocument(text: string): { value: unknown } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null
  try {
    return { value: JSON.parse(trimmed) as unknown }
  } catch {
    return null
  }
}

/**
 * A shell run as one pane: the command on a `$` line, what it printed under a
 * hairline. This is the shape of every shell run in the app — an agent's Bash
 * call (`tool-views/files.tsx`, `RunDetail`) and the reader's own `!` command
 * (`thread-cards.tsx`, `ShellStep`) both draw through it, so the two read as the
 * same act rather than as two things that happen to print text.
 */
export function ShellPane({
  command,
  output,
  failed = false,
  running = false,
  emptyNote,
}: {
  command: string
  output: string
  failed?: boolean
  running?: boolean
  /** What to say when a settled run printed nothing at all. Absent leaves the
      pane as the command line alone, which is what a Bash step does. */
  emptyNote?: string
}) {
  const [out, over, showAll] = useShowAll(output, 200_000)
  return (
    <div className={cn(PANE, failed && "border-destructive/40 bg-destructive/5")}>
      <div className="flex items-start gap-2 px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed">
        <span aria-hidden className="shrink-0 leading-relaxed select-none text-muted-foreground/60">
          $
        </span>
        <ShellScript command={command} className="min-w-0 flex-1" />
      </div>
      {out.trim() && (
        <pre
          className={cn(
            PANE_MAX_H,
            "overflow-auto border-t border-inherit px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed break-words whitespace-pre-wrap",
            failed ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {out}
        </pre>
      )}
      {/* Running with nothing printed yet: breathing lines, not an empty pane. */}
      {!out.trim() && running && <ToolCallSkeleton className="border-t border-inherit p-2.5" />}
      {!out.trim() && !running && emptyNote && (
        <p className="border-t border-inherit px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground">
          {emptyNote}
        </p>
      )}
      {over && <ShowAll onClick={showAll} />}
    </div>
  )
}

/** A file a step acted on, as a chip. The path is elided to its basename so a
    row says "Read" + `package.json` rather than an elided mono path; the full
    path rides in the tooltip. Clickable only where `useThreadLinks` is alive. */
export function FileBadge({
  file,
  filePath,
  range,
}: {
  file: string
  filePath?: string
  /** The lines the step was about. Printed after the basename and carried into
      the editor, which tints them — the chip then says `store.ts:400-460`,
      which is the part of the file the row is actually about. */
  range?: FileRange
}) {
  const inner = (
    <>
      <FileTextIcon aria-hidden className="size-3 shrink-0 opacity-70" />
      <span className="truncate">{file}</span>
      {range && <span className="shrink-0 opacity-60">:{formatRange(range)}</span>}
    </>
  )
  /* The chip carries the row's own entrance (`harness-part-in`, index.css)
     because it is very often the last thing to arrive: a tool call's input
     streams, so an edit row is drawn as "Edit" the moment the call opens and
     only learns its path a beat later. Mounted then, with the title already
     settled beside it, an un-animated chip is a hard pop in the middle of a
     line that had otherwise faded in. On a row that mounts whole it simply
     lands with the title it belongs to — it inherits that part's `--part-i`,
     so it is the same 45ms, not a slot of its own. */
  const cls = "harness-part-in inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-px font-mono text-[10px] leading-4 text-muted-foreground/80"
  return <span className={cls} title={filePath ?? file}>{inner}</span>
}


/**
 * A site's icon, from the one service every browser already talks to for it.
 * Decorative: it is the visual anchor of a source row and nothing depends on
 * it loading, so a failure just leaves the globe in place. `referrerPolicy`
 * keeps the page's own address out of the request.
 */
export function Favicon({ url, className }: { url: string; className?: string }) {
  const host = hostOf(url)
  const [failed, setFailed] = React.useState(false)
  if (!host || failed) return <GlobeIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground/60", className)} />
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
      alt=""
      width={14}
      height={14}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("size-3.5 shrink-0 rounded-sm bg-background/50", className)}
    />
  )
}

/**
 * One page the agent used, as a chip: icon, host, and the title on hover.
 * Shared by the search results and the per-turn Sources strip so a page looks
 * the same wherever it is mentioned.
 *
 * Inside a workspace a plain click opens it in the dock's Browser panel — the
 * source and the thread that cited it end up side by side instead of the
 * thread being left behind in another tab. It stays an anchor either way:
 * ⌘-click, middle-click and copy-address are the browser's, not ours (see
 * `useSourceOpener`).
 */
export function SourceChip({ url, title }: { url: string; title?: string }) {
  const open = useSourceOpener()
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => open(event, url)}
      title={title ? `${title}\n${url}` : url}
      className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[11px] leading-4 text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground"
    >
      <Favicon url={url} className="size-3" />
      <span className="truncate">{hostOf(url) || url}</span>
    </a>
  )
}

/**
 * The click handler every source link shares.
 *
 * Returns a no-op outside a workspace, where there is no panel to open and the
 * anchor's own `target="_blank"` is the right answer — the same fallback
 * `useThreadLinks` gives a file path.
 */
export function useSourceOpener(): (event: React.MouseEvent, url: string) => void {
  const links = useThreadLinks()
  return React.useCallback(
    (event: React.MouseEvent, url: string) => {
      if (!links || !isPlainClick(event)) return
      event.preventDefault()
      links.openUrl(url)
    },
    [links]
  )
}

/** Diffs and inline content blocks — the payload a code block cannot show. */
export function ToolContentBlocks({ item }: { item: ToolItem }) {
  if (item.content.length === 0) return null
  return (
    <div className="space-y-2">
      {mergeText(item.content).map((block, index) => (
        <ToolContentView key={index} content={block} />
      ))}
    </div>
  )
}

/** Everything a tool call produced, rendered the way the transcript renders it.
    Shared with the approval card so a diff looks the same before and after. */
export function ToolCallContent({ content }: { content: acp.ToolCallContent[] }) {
  return mergeText(content).map((part, i) => <ToolContentView key={i} content={part} />)
}

export function ToolContentView({ content }: { content: acp.ToolCallContent }) {
  const view = useViewOptionsContext()
  if (content.type === "diff") {
    return (
      <DiffView
        oldText={content.oldText}
        newText={content.newText}
        path={content.path ? shortPath(content.path, 80) : undefined}
        split={view.splitDiffs}
      />
    )
  }
  if (content.type === "content") return <ContentBlockView block={content.content} />
  return <div className="text-[11px] text-muted-foreground">[{content.type}]</div>
}

/** The non-text halves of an ACP ContentBlock. These used to fall through to a
    `[content]` placeholder, which hid an image the tool actually returned. */
export function ContentBlockView({ block }: { block: acp.ContentBlock }) {
  switch (block.type) {
    case "text":
      return <SmartBlock text={block.text} />
    case "image":
      return (
        <img
          src={`data:${block.mimeType};base64,${block.data}`}
          alt=""
          className="max-h-64 w-fit max-w-full rounded-md border border-border/50 object-contain"
        />
      )
    case "audio":
      return (
        <audio
          controls
          src={`data:${block.mimeType};base64,${block.data}`}
          className="w-full max-w-sm"
        />
      )
    case "resource_link":
      /* A file link the agent sent opens in the Preview panel; anything else —
         a web address, a path outside the project — stays a plain link. */
      if (block.uri.startsWith("file://"))
        return (
          <FileLink
            path={block.uri}
            className="block truncate text-start font-mono text-[11px]"
          >
            {block.name || block.uri}
          </FileLink>
        )
      return (
        <a
          href={block.uri}
          target="_blank"
          rel="noreferrer"
          className="block truncate font-mono text-[11px] text-primary underline-offset-2 hover:underline"
          title={block.description ?? block.uri}
        >
          {block.name || block.uri}
        </a>
      )
    case "resource":
      // Text resources are the readable half; a blob is bytes, so it gets a
      // line saying what it is rather than a screenful of base64.
      return "text" in block.resource ? (
        <div className="min-w-0 space-y-1">
          <p className="truncate font-mono text-[10px] text-muted-foreground/60">
            {block.resource.uri}
          </p>
          <CodeBlock>{block.resource.text}</CodeBlock>
        </div>
      ) : (
        <p className="truncate font-mono text-[11px] text-muted-foreground/80">
          {block.resource.uri}
          {block.resource.mimeType ? ` · ${block.resource.mimeType}` : ""}
        </p>
      )
    default:
      return null
  }
}
/* ── Timestamps ──
   A stamp in a transcript answers two different questions and only one of them
   fits in the ~40px it is given: "where in the day did this happen" (a clock)
   and "how long ago was that" (a phrase). So the label is the clock and the
   hover is the phrase, with one rule the clock alone could not state — a
   thread is read days after it ran, and `14:03` on a row from last Tuesday is
   not a shorter truth, it is a wrong one. Anything off today's date therefore
   carries its day in front of the clock: the weekday inside a week ("Fri
   14:03"), the date beyond it ("4 Mar 14:03"), the year beyond that. */

const clockOf = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })

const startOfDay = (ms: number) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** The short label: a clock, prefixed with the day when it is not today's. */
export function formatStamp(at: number, now = Date.now()): string {
  const date = new Date(at)
  const time = clockOf(date)
  const days = Math.round((startOfDay(now) - startOfDay(at)) / 86_400_000)
  if (days === 0) return time
  // Inside the last week the weekday is both shorter and easier to place than
  // a date — "Fri 14:03" needs no arithmetic to read as "yesterday-ish".
  if (days > 0 && days < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return sameYear
    ? `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })

/** "just now" / "12 minutes ago" / "3 days ago", in the reader's locale. */
export function formatRelative(at: number, now = Date.now()): string {
  const diff = at - now
  const abs = Math.abs(diff)
  if (abs < 45_000) return "just now"
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60_000],
    ["hour", 3_600_000],
    ["day", 86_400_000],
    ["month", 2_592_000_000],
    ["year", 31_536_000_000],
  ]
  let [unit, size] = steps[0]
  for (const [u, s] of steps) if (abs >= s) [unit, size] = [u, s]
  return RELATIVE.format(Math.round(diff / size), unit)
}

/**
 * When something happened. Renders nothing without a time — replayed history
 * has none to show (see store).
 *
 * The hover is a real tooltip rather than a `title`: the browser's takes a
 * second to appear, cannot be styled to match the transcript, and on a phone
 * never appears at all — and the two lines it holds (the full date, and how
 * long ago that was) are the whole reason to reach for a stamp you are already
 * looking at. Left quiet by default and lit on hover, because a column of
 * timestamps down a transcript should be legible when looked for and invisible
 * when not.
 */
export function Timestamp({ at, className }: { at?: number; className?: string }) {
  if (!at) return null
  const date = new Date(at)
  const now = Date.now()
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <time
            dateTime={date.toISOString()}
            className={cn(
              // 11px, the transcript's meta scale — NOT 10px. A stamp is read
              // beside a token figure and an outcome word in the same trailing
              // group, and one part a notch smaller than the rest reads as a
              // misalignment rather than as a quieter voice; the colour is what
              // makes it quiet. Callers wanting the smaller one still say so
              // (the queue's rows).
              "shrink-0 cursor-default whitespace-nowrap text-[11px] tabular-nums text-muted-foreground/50 transition-colors hover:text-muted-foreground",
              className
            )}
          />
        }
      >
        {formatStamp(at, now)}
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0 text-[11px]">
        <span className="tabular-nums">
          {date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
        </span>
        <span className="text-background/60">{formatRelative(at, now)}</span>
      </TooltipContent>
    </Tooltip>
  )
}
