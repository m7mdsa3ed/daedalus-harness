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
  CornerDownRightIcon,
  FileTextIcon,
  GlobeIcon,
  PencilLineIcon,
  SearchIcon,
  SquareTerminalIcon,
  ToggleLeftIcon,
  Trash2Icon,
} from "lucide-react"
import { DiffView } from "@/components/ui/diff-view"
import { useThreadLinks } from "@/lib/workspace/thread-links"
import { shortPath, splitCommand, toolKindOf, toolLanguage } from "@/lib/tools"
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

   Viewport-relative rather than the fixed 16rem this used to be: 256px is a
   reasonable slab on a desktop and about four lines on a phone, where it reads
   as truncated rather than as scrollable — and a table or a fenced block inside
   a box that short is a scroll region you have to fight. The cap still exists,
   because an unbounded pane in a transcript pushes everything after it off the
   screen; it is just tall enough now that scrolling is the exception. */
export const PANE_MAX_H = "max-h-[min(60vh,28rem)]"

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
        const label = `${location.path}${location.line != null ? `:${location.line}` : ""}`
        if (!links) return <li key={index} className="truncate">{label}</li>
        return (
          <li key={index} className="flex min-w-0 items-center gap-1.5">
            <button
              type="button"
              className="min-w-0 flex-1 truncate text-left underline-offset-2 hover:text-foreground hover:underline"
              title={`Open ${location.path}`}
              onClick={() => links.openFile(location.path, location.line ?? undefined)}
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
/** HH:MM in the reader's locale; the full stamp is in the tooltip. Renders
    nothing without a time — replayed history has none to show (see store). */
export function Timestamp({ at, className }: { at?: number; className?: string }) {
  if (!at) return null
  const date = new Date(at)
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      className={cn("shrink-0 text-[10px] tabular-nums text-muted-foreground/60", className)}
    >
      {date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
    </time>
  )
}
