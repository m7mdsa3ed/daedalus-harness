/* ── Tool-call rendering primitives ──
   The boxes every tool view is built out of: the panes, the code blocks, the
   markdown renderer, the content-block switch. They live apart from
   `thread-items.tsx` (which owns the transcript's own rows) and from
   `tool-views.tsx` (which owns one layout per kind of tool) so that the two
   can share them without importing each other — a tool view needs a pane, and
   the transcript needs to draw a tool view, and a cycle between those two is
   what splitting this file out of the middle avoids. */
import * as React from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import type * as acp from "@agentclientprotocol/sdk"
import {
  ArrowLeftRightIcon,
  BrainIcon,
  ClipboardListIcon,
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
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { DiffView } from "@/components/ui/diff-view"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isPlainClick, useThreadLinks } from "@/lib/workspace/thread-links"
import {
  fileRangeOf,
  formatRange,
  hostOf,
  shortPath,
  splitCommand,
  toolKindOf,
  toolLanguage,
  type FileRange,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"
import { useViewOptionsContext } from "@/lib/view-options"

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

/* Prose palette + code/table styling live in index.css, so both themes come
   from the app tokens — no prose-invert needed. */
/* `detect: false` — highlight.js only colours a fence that declares its
   language. Left to guess, it cheerfully "detects" a shell transcript as Perl
   and paints a log file at random, which is worse than no colour at all.

   ponytail: this pulls lowlight's whole `common` grammar set (~180KB gzipped),
   because rehype-highlight imports it statically — passing `languages` narrows
   what resolves but not what ships. Trimming it means driving `createLowlight`
   from a hand-rolled plugin; worth doing if the bundle ever matters more than
   the twenty lines. */
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

const REHYPE = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as never
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

const MARKDOWN_COMPONENTS = {
  table: ({ node: _node, ...props }: React.ComponentProps<"table"> & { node?: unknown }) => (
    <div className="harness-table">
      <table {...props} />
    </div>
  ),
  a: MarkdownLink,
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
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("prose prose-sm max-w-none", className)}>
      <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={MARKDOWN_COMPONENTS}>
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
      <h4 className="text-[10px] font-semibold tracking-[0.08em] uppercase text-muted-foreground/50">
        {label}
      </h4>
      {children}
    </section>
  )
}

const isScalar = (value: unknown) =>
  value === null || ["string", "number", "boolean"].includes(typeof value)

/** What the tool was called with. A flat object — the overwhelmingly common
    shape — becomes a key/value table, because `{"command":"pnpm build"}` is
    JSON noise around the one word you wanted. Anything nested falls back to
    pretty-printed JSON rather than to a lossy summary. */
export function ToolInput({ item }: { item: ToolItem }) {
  const input = item.rawInput
  const language = toolLanguage(item)
  if (input === null || input === undefined) return null
  if (typeof input === "string") {
    return input.trim() ? <CodeBlock language={language}>{input}</CodeBlock> : null
  }
  if (isScalar(input)) return <CodeBlock language={language}>{String(input)}</CodeBlock>

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
  return <CodeBlock language="json">{JSON.stringify(input, null, 2)}</CodeBlock>
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
  const links = useThreadLinks()
  // `item.kind` is the ThreadItem discriminant ("tool"); the *tool*'s kind is
  // what ACP reported, read through the quarantine in lib/tools.
  const isEdit = toolKindOf(item) === "edit"

  return (
    <ul className="space-y-0.5 font-mono text-[11px] text-muted-foreground/80">
      {item.locations.map((location, index) => {
        /* The span, not just the point ACP carries: a windowed read or a
           multi-line rewrite says `:400-460`, and opening it highlights those
           lines rather than dropping a caret on the first of them. */
        const range = fileRangeOf(item, location)
        const label = `${location.path}${range ? `:${formatRange(range)}` : ""}`
        if (!links) return <li key={index} className="truncate">{label}</li>
        return (
          <li key={index} className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left underline-offset-2 hover:text-foreground hover:underline"
              title={`Open ${location.path}`}
              onClick={() => links.openFile(location.path, range?.line, range?.end)}
            >
              {label}
            </button>
            {isEdit && (
              <button
                type="button"
                className="shrink-0 text-[10px] whitespace-nowrap opacity-70 underline-offset-2 hover:text-foreground hover:underline hover:opacity-100"
                title="Compare with the last commit"
                onClick={() => links.openDiff(location.path)}
              >
                diff
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Tool output as markdown. Agents write it as markdown — tables, lists, fenced
    code — and a `pre` rendered all of that as literal pipes and backticks. */
export function ToolProse({ text }: { text: string }) {
  if (!text.trim()) return null
  return (
    <div className={cn(PANE_MAX_H, "min-w-0 overflow-auto rounded-md border border-border/50 bg-muted/40 px-2.5 py-2")}>
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
          <div key={index} className="overflow-hidden rounded border border-border/50 bg-background/50">
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
  return (
    <div
      className={cn(
        PANE_MAX_H,
        "w-fit max-w-full overflow-auto rounded-md border px-2.5 py-2",
        tone === "error"
          ? "border-destructive/40 bg-destructive/5 text-destructive"
          : "border-border/50 bg-muted/40"
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
  const isJson =
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    (() => {
      try {
        JSON.parse(trimmed)
        return true
      } catch {
        return false
      }
    })()
  if (tone !== "error" && (isJson || LOOKS_LIKE_MARKDOWN.test(trimmed))) {
    return <ToolProse text={isJson ? "```json\n" + trimmed + "\n```" : trimmed} />
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

export const PANE = "overflow-hidden rounded-md border border-border/50 bg-muted/30"

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
  const links = useThreadLinks()
  const inner = (
    <>
      <FileTextIcon aria-hidden className="size-3 shrink-0 opacity-70" />
      <span className="truncate">{file}</span>
      {range && <span className="shrink-0 opacity-60">:{formatRange(range)}</span>}
    </>
  )
  const cls = "inline-flex max-w-[45%] shrink-0 items-center gap-1 rounded-md bg-muted/60 px-1.5 py-px font-mono text-[10px] leading-4 text-muted-foreground/80"
  if (!links) return <span className={cls} title={filePath ?? file}>{inner}</span>
  return (
    <button
      type="button"
      className={cn(cls, "transition-colors hover:text-foreground hover:bg-muted")}
      title={filePath ? `Open ${filePath}` : file}
      onClick={() => links.openFile(filePath ?? file, range?.line, range?.end)}
    >
      {inner}
    </button>
  )
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
      className={cn("size-3.5 shrink-0 rounded-sm bg-background/60", className)}
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
              "shrink-0 cursor-default whitespace-nowrap text-[10px] tabular-nums text-muted-foreground/50 transition-colors hover:text-muted-foreground",
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
