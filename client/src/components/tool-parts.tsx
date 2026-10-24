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
import type { StreamEffect } from "@/lib/stream-words"
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
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog"
import { VIEWER, ViewerHeader } from "@/components/ui/responsive-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyButton } from "@/components/ui/copy-button"
import { PrettyButton, usePretty } from "@/components/ui/pretty-button"
import { canPrettify, fencedBlock } from "@/lib/pretty"
import { DiffView } from "@/components/ui/diff-view"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import { isPlainClick, useThreadLinks } from "@/lib/workspace/thread-links"
import {
  fileRangeOf,
  formatRange,
  hostOf,
  mcpTintIndex,
  safeJson,
  shortPath,
  splitCommand,
  toolKindOf,
  toolLanguage,
  type FileRange,
} from "@/lib/tools"
import type { ToolItem } from "@/lib/store"
import { cn } from "@/lib/utils"
import { useLayoutOptionsContext } from "@/lib/layout-options"
import { useCoarsePointer } from "@/hooks/use-device"
import { recoverUnfencedOpenui } from "@/lib/openui/recover-unfenced"
import { splitOpenuiFences } from "@/lib/openui/fences"
import { FileLink } from "@/components/file-link"
import { Prose, REHYPE } from "@/components/prose"
import { FilePreviewContext, projectPath } from "@/lib/file-preview"

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

/* One accent per tool kind, shared by the step rows and grouped avatars. Keep
   each hue distinct so a mixed group can be scanned by icon color alone.
   These are categories, not status, so they keep their own hues rather than
   the success/warning/destructive tokens. */
export const KIND_COLORS: Record<string, string> = {
  read: "text-cyan-600 dark:text-cyan-400",
  edit: "text-orange-600 dark:text-orange-400",
  delete: "text-red-600 dark:text-red-400",
  move: "text-amber-600 dark:text-amber-400",
  search: "text-blue-600 dark:text-blue-400",
  execute: "text-emerald-600 dark:text-emerald-400",
  think: "text-violet-600 dark:text-violet-400",
  fetch: "text-teal-600 dark:text-teal-400",
  switch_mode: "text-indigo-600 dark:text-indigo-400",
  other: "text-slate-600 dark:text-slate-400",
}

/* The matching tinted avatar tile for each kind's foreground accent. */
export const KIND_CHIPS: Record<string, string> = {
  read: "bg-cyan-500/12",
  edit: "bg-orange-500/12",
  delete: "bg-red-500/12",
  move: "bg-amber-500/12",
  search: "bg-blue-500/12",
  execute: "bg-emerald-500/12",
  think: "bg-violet-500/12",
  fetch: "bg-teal-500/12",
  switch_mode: "bg-indigo-500/12",
  other: "bg-slate-500/12",
}

/* One accent per MCP integration, for the chip that names it and the disc the
   run stack turns behind its logo. The hue is *derived* (`mcpTintIndex`), not
   assigned: a server somebody adds tomorrow gets a colour without a table anyone
   has to edit, and the same server is the same colour everywhere — the bargain
   `InitialMark` makes for a project. Twelve, from the palette the kind tints
   already use, because a transcript holds a handful of integrations and the
   whole job is telling them apart at a glance. */
export const MCP_TINTS: { wash: string; accent: string }[] = [
  /* Deliberately not in spectrum order. The modulus hands out neighbours, and
     two neighbouring entries are drawn side by side in the same transcript — so
     the order alternates across the wheel instead (rose, teal, amber, indigo…),
     and the buckets that collide are the ones furthest apart in hue. */
  { wash: "bg-rose-500/12", accent: "text-rose-600 dark:text-rose-300" },
  { wash: "bg-teal-500/12", accent: "text-teal-600 dark:text-teal-300" },
  { wash: "bg-amber-500/12", accent: "text-amber-600 dark:text-amber-300" },
  { wash: "bg-indigo-500/12", accent: "text-indigo-600 dark:text-indigo-300" },
  { wash: "bg-lime-500/12", accent: "text-lime-700 dark:text-lime-300" },
  { wash: "bg-fuchsia-500/12", accent: "text-fuchsia-600 dark:text-fuchsia-300" },
  { wash: "bg-sky-500/12", accent: "text-sky-600 dark:text-sky-300" },
  { wash: "bg-orange-500/12", accent: "text-orange-600 dark:text-orange-300" },
  { wash: "bg-violet-500/12", accent: "text-violet-600 dark:text-violet-300" },
  { wash: "bg-emerald-500/12", accent: "text-emerald-600 dark:text-emerald-300" },
  { wash: "bg-pink-500/12", accent: "text-pink-600 dark:text-pink-300" },
  { wash: "bg-cyan-500/12", accent: "text-cyan-600 dark:text-cyan-300" },
]

/** The colour one MCP integration wears: a wash for its chip and for the disc
    behind its mark, and the hue's own ink for the word on it. */
export function mcpTint(server: string): { wash: string; accent: string } {
  return MCP_TINTS[mcpTintIndex(server, MCP_TINTS.length)]
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

/* How tall a thinking row's detail grows before it scrolls itself.

   The cap has to exist — an unbounded reasoning block pushes everything after
   it off the screen — but a fixed one is wrong in both directions: 28rem is
   most of a phone and a slab on a desktop, and the whole point of the row while
   it streams is that you can watch the newest words land. So it is a fraction
   of the *panel* (`--panel-h`, published by `workspace/panel-container`; the
   fallback makes it the viewport outside one), and the fraction moves with the
   panel's **width** — `@panel-sm:`, the container query, not `sm:`, because a
   chat squeezed beside a terminal is narrow for the same reason a phone is.

   Deliberately *tight*: the box is a live view, not a reading pane — it is open
   only while the thought streams (see `ThoughtDetail` in
   `thread-items/rows.tsx`, and `autoOpen` on `StepRow`) and folds to one line
   the moment it settles, so it should not eat the turn it sits in. A short
   panel gets less of it (0.3), a roomy one more (0.42, still ceilinged so a tall
   monitor does not turn a thought into a page).

   The box follows its own newest text while the thought streams — see
   `ThoughtDetail` — because the transcript's `useFollowStream` measures the
   *content*, and a capped box stops growing: the newest thinking would be
   exactly what falls out of view.

   This is the OPEN cap only. The folded shape is the card's own preview — three
   lines, clamped and faded by `.thought-preview .prose` — so this ceiling is
   what the opened one is held to. */
export const THOUGHT_MAX_H =
  "max-h-[calc(var(--panel-h,100svh)*0.3)] @panel-sm:max-h-[min(calc(var(--panel-h,100svh)*0.42),20rem)]"

/* ── The transcript's shared shapes ──
   One spelling each for a pane, a card, a caption and a disclosure, because
   the alternative is what was here: two washes for the same box (`bg-muted`
   and `/40`), three card geometries (`rounded-xl px-3 py-2.5`, `rounded-lg
   px-4 py-3`, `my-1.5` vs `my-2`) and three section labels. A row that adds
   one of these reaches for the constant; a theme that moves `--radius` moves
   all of them, which a bare `rounded` (a hardcoded 0.25rem — Tailwind defines
   no default radius from this theme) never did. */

/** A payload's box: rows drawn inside it supply their own padding. */
export const PANE = "overflow-hidden rounded-lg bg-muted"

/** The same box with its own padding, for a pane holding one thing rather than
    a list of rows (a brief, a plan, tool prose, a code block). */
export const PANE_PAD = "rounded-lg bg-muted px-3 py-2"

/** A row inside a `PANE`: a text row with no leading mark, so it may run wider
    than it is tall. A dense mono list (grep hits, a read, a run's footer) is
    `px-3 py-1`; a row that holds more than one line adds `space-y-1`. */
export const PANE_ROW = "px-3 py-2"

/** A recessed block inside a pane — a heredoc body, an unfolded stack trace. */
export const INSET = "rounded-md bg-background"

/** A notice that is its own object in the flow rather than a step: an error, a
    task reporting back, an agent's demarcated block, a pasted blob. The tone
    (border and wash) is the caller's; the geometry is not. */
export const CARD = "my-2 rounded-xl border p-3"

/** A chip inside a step's title line — a file, a path. 20px tall, so it sits in
    the 24px title line box with 2px either side. */
export const CHIP =
  "inline-flex items-center gap-1 rounded-md bg-muted px-1 py-0.5 font-mono text-xs leading-4"

/** The caption over a section of a step's detail, and over anything else that
    is a group of rows with a name. */
export const LABEL =
  "text-xs font-medium text-muted-foreground"

/** The "Show details" / "Hide result" line every card folds its payload behind.
    One component rather than three copies of the same flex row, so the chevron
    turns the same way and sits at the same size wherever it is drawn. */
/** The disclosure line's own class, for a trigger that cannot be `Disclosure`
    itself (a dialog trigger, a `<summary>`). */
export const DISCLOSURE =
  "flex w-fit items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"

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
      className={cn(DISCLOSURE, className)}
    >
      <ChevronRightIcon
        aria-hidden
        className={cn("size-3 shrink-0 transition-transform duration-200", open && "rotate-90")}
      />
      {children}
    </button>
  )
}


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
            className={cn(DISCLOSURE, className)}
          />
        }
      >
        <Maximize2Icon aria-hidden className="size-3" />
        Full screen
      </DialogTrigger>
      {/* Nearly the whole window: a plan is the one payload where the limit on
          reading it was the room. */}
      <DialogContent className={VIEWER}>
        <ViewerHeader icon={<ClipboardListIcon />} title={title || "Plan"} />
        <div data-read-surface className="min-h-0 flex-1 overflow-auto overscroll-contain px-6 py-5">
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

/** A record as a key/value grid — keys in their own column so the eye reads
    down the values, the way a table reads down a column. Shared because a
    structured result is drawn this way by more than one view: the harness's
    operation fields and an MCP server's answer are the same reading. */
export function FieldList({ fields }: { fields: { key: string; value: string }[] }) {
  return (
    <dl className={cn(PANE_PAD, "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm")}>
      {fields.map((field) => (
        <React.Fragment key={field.key}>
          <dt className="font-mono text-muted-foreground">{field.key}</dt>
          <dd className="min-w-0 break-words text-foreground">{field.value}</dd>
        </React.Fragment>
      ))}
    </dl>
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
         the thing you read — so they match message prose. `text-xs` is for
         labels and counters. */
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-sm">
        {entries.map(([key, value]) => (
          <React.Fragment key={key}>
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="min-w-0 break-words whitespace-pre-wrap text-foreground">
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
    <ul className="space-y-1 font-mono text-xs text-muted-foreground">
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
    <React.Suspense fallback={<Prose text={"```openui-lang\n" + code + "\n```"} />}>
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
      <div className={cn("flex min-w-0 flex-col gap-2", className)}>
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
          `text-xs` that used to be here never applied, which is half of why
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
  if (!language) {
    return <pre className={cn("font-mono text-xs leading-relaxed whitespace-pre-wrap", className)}>{code}</pre>
  }
  return (
    <div className={cn("harness-code-bare prose prose-sm max-w-none", className)}>
      <Markdown rehypePlugins={REHYPE}>{fencedBlock(code, language)}</Markdown>
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
            <div className="flex items-center gap-1 border-b px-2 py-1 font-mono text-xs text-muted-foreground">
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
  /* JSON in a tool's output is laid out by default — a minified result is
     unreadable as one line — whether the tool labelled it or not. An error
     stays as the tool said it. The button puts the original back. */
  const json = React.useMemo(
    () => tone !== "error" && (language === "json" || (!language && parseJsonDocument(children) !== null)),
    [tone, language, children]
  )
  const effective = json ? "json" : language
  const pretty = usePretty(effective, json ? children : undefined)
  const shown = pretty.text ?? children
  const pane = (
    <div
      className={cn(
        PANE_MAX_H,
        "w-fit max-w-full overflow-auto",
        tone === "error"
          ? /* `pr-9` reserves the corner the copy below floats in, so a long
               single-line stack trace is not read with its tail under a
               button. */
            "rounded-lg bg-destructive/10 py-2 pl-3 pr-9 text-destructive"
          : PANE_PAD
      )}
    >
      {/* Errors stay uncoloured: a stack trace highlighted as code competes with
          the destructive tint that is the actual signal. */}
      {tone !== "error" && language === "bash" ? (
        <ShellScript command={children} />
      ) : (
        <Highlighted code={shown} language={tone === "error" ? undefined : effective} />
      )}
    </div>
  )
  /* Pretty print lives outside the pane for the same reason the error copy
     does: the pane scrolls. Only a language Prettier can lay out draws it. */
  if (tone !== "error") {
    if (!canPrettify(effective)) return pane
    return (
      <div className="group/code relative w-fit max-w-full">
        {pane}
        <PrettyButton language={effective} pretty={pretty} source={() => children} className="right-1" />
      </div>
    )
  }
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
        className="absolute top-1 right-1 text-destructive hover:bg-destructive/20 hover:text-destructive"
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
    <Button type="button" variant="ghost" size="xs" onClick={onClick} className="m-1 text-muted-foreground">
      Show everything
    </Button>
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
      <div className="flex flex-wrap items-baseline gap-x-1 font-mono text-xs leading-5">
        <ChevronRightIcon aria-hidden className="invisible size-3 shrink-0" />
        {index !== null && <span className="text-muted-foreground">{index}</span>}
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
        className="flex w-full items-baseline gap-1 rounded-md text-left font-mono text-xs leading-5 outline-hidden hover:bg-muted focus-visible:bg-muted"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 translate-y-[3px] text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        {index !== null && <span className="text-muted-foreground">{index}</span>}
        {name !== null && <span className="text-code-key">{name}</span>}
        {name !== null && <span className="text-code-punctuation">:</span>}
        <span className="text-code-punctuation">{brackets[0]}</span>
        {/* Folded: what it holds, and its own closing bracket, so the line
            reads as the whole value rather than as an opening brace. */}
        {!open && (
          <span className="min-w-0 truncate">
            <span className="text-muted-foreground">{jsonSummary(value)}</span>
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
          <div className="ms-1.5 border-s ps-2">
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
                className="font-mono text-xs leading-5 text-muted-foreground transition-colors hover:text-foreground"
              >
                {entries.length - JSON_CHILD_LIMIT} more …
              </button>
            )}
          </div>
          <div className="flex gap-1 font-mono text-xs leading-5 ps-4">
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
      <div className={cn(PANE, PANE_MAX_H, "overflow-auto", PANE_ROW)}>
        <JsonNode name={null} index={null} value={value} depth={0} preview={preview} last />
      </div>
      {/* The copy rides the tree the way it rides a fenced block — hover on a
          fine pointer, always on touch, where there is no hover to reveal it. */}
      <CopyButton
        text={text}
        size="icon-xs"
        className={cn(
          "absolute top-1 right-1 bg-popover text-muted-foreground transition-opacity hover:text-foreground",
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
/** ShellPane's rows, shared with the terminal-channel run (`TerminalDetail`)
    so the two panes are one geometry. */
export const SHELL_COMMAND = "flex items-start gap-2 px-3 py-2 font-mono text-xs leading-relaxed"
export const SHELL_OUTPUT =
  "overflow-auto border-t border-inherit px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
export const SHELL_SKELETON = "border-t border-inherit px-3 py-2"
/** A pane's footer row — a failed run's exit line. */
export const SHELL_FOOTER = "flex items-center gap-2 border-t border-inherit px-3 py-1 font-mono text-xs"

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
    <div className={cn(PANE, failed && "bg-destructive/10")}>
      <div className={SHELL_COMMAND}>
        <span aria-hidden className="shrink-0 leading-relaxed select-none text-muted-foreground">
          $
        </span>
        <ShellScript command={command} className="min-w-0 flex-1" />
      </div>
      {out.trim() && (
        <pre
          className={cn(
            PANE_MAX_H,
            SHELL_OUTPUT,
            failed ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {out}
        </pre>
      )}
      {/* Running with nothing printed yet: breathing lines, not an empty pane. */}
      {!out.trim() && running && <ToolCallSkeleton className={SHELL_SKELETON} />}
      {!out.trim() && !running && emptyNote && (
        <p className="border-t border-inherit px-3 py-2 font-mono text-xs text-muted-foreground">
          {emptyNote}
        </p>
      )}
      {over && <ShowAll onClick={showAll} />}
    </div>
  )
}

/** A file a step acted on, as a chip. The path is elided to its basename so a
    row says "Read" + `package.json` rather than an elided mono path; the full
    path rides in the tooltip.

    **The chip is the door to the file, not a label with an eye beside it.** A
    path that resolves into the thread's project (`projectPath`) is drawn as a
    button that opens the Preview panel, exactly as a `FileLink` in prose and a
    user bubble's `@` mention do; anything else — outside the project, or no
    thread in reach — is the plain chip it always was, because a control that
    can only fail is worse than none.

    It cannot be a real `<button>`: the chip sits inside the row's disclosure
    button, and a button may not hold a button. It is a `role="button"` span
    instead, which is also what lets the row keep one hit target for "read this
    step" without the file chip stealing the whole line's clicks. */
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
  const ctx = React.useContext(FilePreviewContext)
  const target = filePath && ctx ? projectPath(filePath, ctx.scope) : null
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
  const cls =
    cn(CHIP, "harness-part-in max-w-[45%] shrink-0 text-muted-foreground")
  if (!ctx || !target) return <span className={cls} title={filePath ?? file}>{inner}</span>
  return (
    <span
      role="button"
      tabIndex={0}
      /* The disclosure is the row's, so a click here must not fold the row it
         sits in: kept from reaching the button above it, the same way the
         chip's own keyboard activation is. */
      onClick={(event) => {
        event.stopPropagation()
        ctx.open(target)
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        event.stopPropagation()
        ctx.open(target)
      }}
      aria-label={`Preview ${target}`}
      title={`Preview ${target}`}
      className={cn(
        cls,
        "cursor-pointer transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      )}
    >
      {inner}
    </span>
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
  if (!host || failed) return <GlobeIcon aria-hidden className={cn("size-3.5 shrink-0 text-muted-foreground", className)} />
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
      alt=""
      width={14}
      height={14}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={cn("size-3.5 shrink-0 rounded-md bg-background", className)}
    />
  )
}

/**
 * One page the agent used, as a chip: icon, host, and the title on hover.
 * Shared by the search results and the per-turn Sources strip so a page looks
 * the same wherever it is mentioned.
 *
 * Inside a workspace a plain click opens it in the system browser. It stays
 * an anchor either way:
 * ⌘-click, middle-click and copy-address are the browser's, not ours (see
 * `useSourceOpener`).
 */
export function SourceChip({ url, title }: { url: string; title?: string }) {
  const open = useSourceOpener()
  return (
    <Badge
      variant="outline"
      className="max-w-full min-w-0 justify-start text-muted-foreground hover:text-foreground"
      render={
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => open(event, url)}
          title={title ? `${title}\n${url}` : url}
        />
      }
    >
      <Favicon url={url} className="size-3" />
      <span className="truncate">{hostOf(url) || url}</span>
    </Badge>
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
  const view = useLayoutOptionsContext()
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
  return <div className="text-xs text-muted-foreground">[{content.type}]</div>
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
          className="max-h-64 w-fit max-w-full rounded-lg border object-contain"
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
            className="block truncate text-start font-mono text-xs"
          >
            {block.name || block.uri}
          </FileLink>
        )
      return (
        <a
          href={block.uri}
          target="_blank"
          rel="noreferrer"
          className="block truncate font-mono text-xs text-primary underline-offset-2 hover:underline"
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
          <p className="truncate font-mono text-xs text-muted-foreground">
            {block.resource.uri}
          </p>
          <CodeBlock>{block.resource.text}</CodeBlock>
        </div>
      ) : (
        <p className="truncate font-mono text-xs text-muted-foreground">
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

/* Formatters built once: a `toLocale*String` with options constructs a fresh
   `Intl.DateTimeFormat` per call, and a transcript draws a stamp per row. */
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" })
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" })
const DAY_MONTH = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" })
const DAY_MONTH_YEAR = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" })
const FULL = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

const clockOf = (date: Date) => CLOCK.format(date)

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
    return `${WEEKDAY.format(date)} ${time}`
  }
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return sameYear ? `${DAY_MONTH.format(date)} ${time}` : DAY_MONTH_YEAR.format(date)
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
export const Timestamp = React.memo(function Timestamp({ at, className }: { at?: number; className?: string }) {
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
              "shrink-0 cursor-default whitespace-nowrap text-xs tabular-nums text-muted-foreground",
              className
            )}
          />
        }
      >
        {formatStamp(at, now)}
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0 text-xs">
        <FullTime at={at} />
      </TooltipContent>
    </Tooltip>
  )
})

/* The hover's two lines, a component of their own so they are formatted when
   the popup mounts — not on every row's render while it is closed. */
function FullTime({ at }: { at: number }) {
  return (
    <>
      <span className="tabular-nums">{FULL.format(at)}</span>
      <span className="text-background/60">{formatRelative(at)}</span>
    </>
  )
}
