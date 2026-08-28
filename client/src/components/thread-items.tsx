import * as React from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import type * as acp from "@agentclientprotocol/sdk"
import {
  ArrowLeftRightIcon,
  BrainIcon,
  FileTextIcon,
  FoldVerticalIcon,
  GlobeIcon,
  ChevronRightIcon,
  CopyIcon,
  CornerDownRightIcon,
  ListTodoIcon,
  PencilLineIcon,
  PlayIcon,
  RotateCwIcon,
  SearchIcon,
  SquareTerminalIcon,
  Trash2Icon,
  ToggleLeftIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { reportError } from "@/lib/errors"
import { useThreadLinks } from "@/lib/workspace/thread-links"
import { Message, MessageContent } from "@/components/ui/message"
import { ToolCallSkeleton } from "@/components/ui/skeletons"
import { DiffView } from "@/components/ui/diff-view"
import {
  extractBackgroundTask,
  extractEditInput,
  shortPath,
  splitCommand,
  parseTaskNotification,
  taskAgentRows,
  taskFindings,
  toolLanguage,
  toolKindOf,
  toolOutputText,
  toolPrimaryText,
  toolSummary,
  toolTarget,
  type BackgroundTask,
  type TaskNotification,
} from "@/lib/tools"
import { useTaskEvents, watchTask } from "@/lib/task-events"
import { loadSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import type { CompactionItem, PlanItem, ThreadItem, ToolItem } from "@/lib/store"

/* Right-clicking text the user has selected keeps the browser's own menu —
   native Copy works there. Ours only claims clicks on unselected content.
   stopPropagation keeps Base UI's document-level listener from cancelling
   the native menu. */
function yieldToTextSelection(event: React.MouseEvent & { preventBaseUIHandler?: () => void }) {
  const selection = window.getSelection()
  if (selection && !selection.isCollapsed && selection.toString().trim()) {
    event.preventBaseUIHandler?.()
    event.stopPropagation()
  }
}

function copyText(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success("Copied"))
    .catch((err) => reportError(err, "Couldn't copy"))
}

/* Steps read as one timeline: a hairline rail down the gutter with a node per
   step (rail geometry in index.css). The thing acted on is the headline — the
   kind is demoted to a right-hand label so those form their own scan column.
   Everything a step produced is collapsed behind the row until clicked. */

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


function useElapsed(startedAt: number, active: boolean): number | null {
  const [ms, setMs] = React.useState<number | null>(null)
  React.useEffect(() => {
    if (!active) {
      setMs(null)
      return
    }
    const tick = () => setMs(Date.now() - startedAt)
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [startedAt, active])
  return ms
}

function formatElapsed(ms: number): string {
  return ms < 60_000
    ? `${Math.round(ms / 1000)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function StepRow({
  target,
  label,
  status,
  metric,
  detail,
  startedAt,
  mono = true,
  defaultOpen = false,
  icon: Icon,
}: {
  target: React.ReactNode
  label: string
  status: string | null
  metric?: React.ReactNode
  detail?: React.ReactNode
  startedAt?: number
  mono?: boolean
  /** Start expanded — edits show their diff without a click (see ToolStep). */
  defaultOpen?: boolean
  /** Leading mark. On an expandable row it swaps for a chevron on hover, so
      the disclosure affordance appears where the eye already is instead of at
      the far end of the line. */
  icon?: React.ComponentType<{ className?: string }>
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const expandable = detail !== undefined && detail !== null && detail !== false
  const active = status === "in_progress" || status === "pending"
  const failed = status === "failed"
  const elapsedMs = useElapsed(startedAt ?? 0, active && startedAt !== undefined)

  return (
    <div>
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          // items-center, not items-baseline: the target span is `truncate`
          // (overflow: hidden), so its baseline is its bottom edge — baseline
          // alignment lifted the title ~5px above the "edit"/"run" label. Every
          // child is leading-6, so centring lines them up exactly.
          // The width is calc(100% + 12px) so the -mx-1.5/px-1.5 hover bleed
          // cancels on BOTH sides: a `w-full` box only shifts left under a
          // negative start margin, which left the row's content edge 12px shy
          // of the right edge that messages run to.
          "group/step -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-start transition-colors duration-150",
          expandable && "hover:bg-muted/40"
        )}
      >
        {Icon && (
          <span
            className={cn(
              "relative flex size-3.5 shrink-0 items-center justify-center",
              failed ? "text-destructive" : active ? "text-primary" : "text-muted-foreground/60"
            )}
          >
            <Icon
              className={cn(
                "size-3.5 transition-opacity duration-100",
                expandable && (open ? "opacity-0" : "group-hover/step:opacity-0")
              )}
            />
            {expandable && (
              <ChevronRightIcon
                aria-hidden
                className={cn(
                  "absolute size-3.5 text-muted-foreground transition-[opacity,transform] duration-100",
                  open ? "rotate-90 opacity-100" : "opacity-0 group-hover/step:opacity-100"
                )}
              />
            )}
          </span>
        )}
        {/* Steps are what the agent did, not what it said: the whole row sits at
            caption weight so prose stays the thing you read. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-6",
            mono && "font-mono",
            failed ? "text-destructive" : "text-muted-foreground",
            active && "harness-shimmer"
          )}
        >
          {target}
        </span>

        {elapsedMs !== null && elapsedMs >= 2000 && (
          <span className="shrink-0 text-[11px] leading-6 tabular-nums text-muted-foreground/60">
            {formatElapsed(elapsedMs)}
          </span>
        )}
        {metric && (
          <span className="shrink-0 text-[11px] leading-6 tabular-nums text-muted-foreground/60">
            {metric}
          </span>
        )}
        <span
          className={cn(
            "shrink-0 text-[11px] leading-6",
            failed ? "text-destructive" : "text-muted-foreground/50"
          )}
        >
          {failed ? "failed" : label}
        </span>
      </button>

      {expandable && open && <div className="mt-1 mb-2.5 min-w-0 space-y-2">{detail}</div>}
    </div>
  )
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
const PANE_MAX_H = "max-h-[min(60vh,28rem)]"

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
const MARKDOWN_COMPONENTS = {
  table: ({ node: _node, ...props }: React.ComponentProps<"table"> & { node?: unknown }) => (
    <div className="harness-table">
      <table {...props} />
    </div>
  ),
  a: ({ node: _node, href, ...props }: React.ComponentProps<"a"> & { node?: unknown }) =>
    /^https?:\/\//i.test(href ?? "") ? (
      <a {...props} href={href} target="_blank" rel="noreferrer noopener" />
    ) : (
      <a {...props} href={href} />
    ),
} as never

export function Prose({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("prose prose-sm max-w-none", className)}>
      <Markdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={MARKDOWN_COMPONENTS}>
        {text}
      </Markdown>
    </div>
  )
}

/* Explanatory agents emit their insight box as two backticked rule lines around
   the body — as markdown that's a pair of code chips with a wall of dashes.
   The rules are the frame, so drop them and render the body as a callout.
   Unterminated matches (still streaming) run to the end of the text. */
const INSIGHT_RE = /`?★[^\n]*?Insight[^\n]*\n([\s\S]*?)(?:\n?`?[─—–-]{5,}`?|$)/g

/* Codex's Plan mode wraps its proposal in a `<proposed_plan>` tag inside an
   ordinary assistant message. It is NOT an ACP plan: codex-acp sends no `plan`
   or `plan_update` frame for it, just the text with the tag in it — so without
   this the single most important thing in the turn arrives as undifferentiated
   prose wrapped in visible markup.

   Anchored to its own line at both ends, because agents talk ABOUT the tag as
   well as with it — this very thread contains "Wrap in <proposed_plan> so it
   renders…" in a question, and a loose pattern runs from that sentence to the
   real closing tag and swallows the conversation in between.

   Unterminated matches run to the end of the text, so a plan renders while it
   is still streaming instead of appearing only once it closes. That end-of-text
   test is `(?![\s\S])` and not `$` on purpose: `$` would need the `m` flag to
   pair with the line anchor, and under `m` it means end-of-LINE, which cuts
   every plan off after its first line. */
const PROPOSED_PLAN_RE =
  /(?:^|\n)<proposed_plan>[ \t]*\n([\s\S]*?)(?:\n[ \t]*<\/proposed_plan>|(?![\s\S]))/g

/* Structured output that agents demarcate inside plain text, because the
   protocol has no channel carrying it. Kept as a table rather than a chain of
   per-agent branches: a convention that earns a panel gets a row here, and the
   renderer never learns which agent it came from. */
const AGENT_BLOCKS = [
  { re: INSIGHT_RE, label: "Insight", mark: "★", accent: false },
  { re: PROPOSED_PLAN_RE, label: "Proposed plan", mark: "◆", accent: true },
] as const

function AgentBlock({
  label,
  mark,
  body,
  accent,
}: {
  label: string
  mark: string
  body: string
  accent: boolean
}) {
  return (
    <aside
      className={cn(
        "rounded-lg border px-4 py-3",
        // A proposal is waiting on a decision, so it reads a shade louder than
        // an aside that is only explaining something.
        accent ? "border-primary/30 border-l-2 border-l-primary/60 bg-primary/[0.03]" : "border-border/60 bg-muted/30"
      )}
    >
      <p
        className={cn(
          "mb-1.5 text-[11px] font-medium tracking-wider uppercase",
          accent ? "text-primary/80" : "text-muted-foreground"
        )}
      >
        <span aria-hidden>{mark}</span> {label}
      </p>
      <Prose text={body} />
    </aside>
  )
}

function AgentText({ text }: { text: string }) {
  const blocks = AGENT_BLOCKS.flatMap(({ re, label, mark, accent }) =>
    [...text.matchAll(re)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      body: m[1],
      label,
      mark,
      accent,
    }))
  ).sort((a, b) => a.start - b.start)
  if (blocks.length === 0) return <Prose text={text} />

  const parts: React.ReactNode[] = []
  let cut = 0
  for (const block of blocks) {
    // Two conventions claiming the same span: the earlier one already took it.
    if (block.start < cut) continue
    if (block.start > cut) parts.push(<Prose key={cut} text={text.slice(cut, block.start)} />)
    parts.push(<AgentBlock key={block.start} {...block} />)
    cut = block.end
  }
  if (cut < text.length) parts.push(<Prose key={cut} text={text.slice(cut)} />)
  return <div className="space-y-3">{parts}</div>
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

/** A run of consecutive tool steps, folded into one row (view-options). */
export interface ToolRunGroup {
  id: string
  items: ToolItem[]
}

/** Natural-language summary: "reading 10 files, running 28 shell commands". */
const KIND_VERBS: Record<string, string> = {
  read: "reading",
  edit: "editing",
  delete: "deleting",
  move: "moving",
  search: "searching",
  execute: "running",
  think: "thinking",
  fetch: "fetching",
  switch_mode: "switching mode",
  other: "running",
}

const KIND_NOUNS: Record<string, string> = {
  read: "file",
  edit: "file",
  delete: "file",
  move: "file",
  search: "search",
  execute: "shell command",
  think: "thought",
  fetch: "fetch",
  switch_mode: "mode change",
  other: "tool",
}

const KIND_NOUNS_PLURAL: Record<string, string> = {
  search: "searches",
  fetch: "fetches",
}

const pluralNoun = (noun: string, count: number) =>
  count === 1 ? noun : (KIND_NOUNS_PLURAL[noun] ?? `${noun}s`)

/** What the run actually did: "reading 10 files, running 28 shell commands", in the
    order the kinds first appeared. */
function summarise(items: ToolItem[]): { verb: string; noun: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    // toolKindOf, not the raw field: a run of Bash calls from an agent that
    // omits `kind` should still summarise as "running 3 shell commands", not "3 tools".
    const kind = toolKindOf(item)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
  }
  return [...counts.entries()].map(([kind, count]) => ({
    verb: KIND_VERBS[kind] ?? KIND_VERBS.other,
    noun: KIND_NOUNS[kind] ?? KIND_NOUNS.other,
    count,
  }))
}

/** How much of a running group stays on screen without being expanded. */
const PEEK = 3

export function ToolRun({
  items,
  showTimestamps,
}: {
  items: ToolItem[]
  showTimestamps?: boolean
}) {
  /* Open by default. A group is only ever a run of tool calls with NOTHING
     between them — `groupToolRuns` breaks the run on the first non-tool item —
     so the summary line is a heading for steps that belong together, not a
     drawer to hide them in. Collapsing by default made the transcript go quiet
     exactly where the agent was busiest; text between tool calls is what
     separates one run from the next, and that already happens by splitting
     them into two groups. The disclosure stays: a 40-step run is still worth
     folding away by hand. */
  const [open, setOpen] = React.useState(true)
  const failed = items.filter((item) => item.status === "failed").length
  const active = items.some((item) => item.status === "in_progress" || item.status === "pending")
  const summary = summarise(items)

  const prose = summary
    .map(({ verb, noun, count }) => `${verb} ${count} ${pluralNoun(noun, count)}`)
    .join(", ")

  /* While the run is still going, the tail of it stays visible without being
     asked for. Collapsed-by-default is right for a finished run — it is
     history, and "read 12 files" is the whole of what you need from it — but
     the group the agent is working in right now is the one thing on screen
     that is actually happening, and folding it into a single counting line
     turns a live process into a number that ticks. Three: enough to see what
     it just did and what it is doing, few enough that the transcript is not
     re-expanding itself behind your back.

     `active` is the whole test — only the run the agent is inside has a
     pending or in_progress step — so this needs no notion of "the last
     group". The peek closes on its own when the run finishes. */
  const showing = open ? items : active ? items.slice(-PEEK) : []
  const hidden = active && !open ? items.length - showing.length : 0

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="-mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-start transition-colors duration-150 hover:bg-muted/40"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground/60 transition-transform duration-200",
            open && "rotate-90"
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground",
            active && "harness-shimmer"
          )}
        >
          {prose}
        </span>
        {failed > 0 && (
          <span className="shrink-0 text-[11px] leading-6 text-destructive">{failed} failed</span>
        )}
      </button>
      {showing.length > 0 && (
        /* One rail for both states, so expanding a peeking run grows the list
           in place instead of swapping one layout for another. */
        <div className="mt-0.5 ml-[calc(0.75rem-1px)] space-y-0.5 border-l border-border/60 pl-2.5">
          {hidden > 0 && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="-mx-1 block rounded px-1 text-[11px] leading-5 text-muted-foreground/70 transition-colors hover:text-foreground"
            >
              {hidden} earlier {hidden === 1 ? "step" : "steps"}
            </button>
          )}
          {showing.map((item) => (
            <ToolStep key={item.id} item={item} showTimestamp={showTimestamps} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A failure, in the flow of the conversation. Loud enough not to be missed and
 * quiet enough not to be a modal: the headline says what the app was trying to
 * do, the line under it says why it failed, and the agent's own account of it
 * (a stack, a JSON-RPC `data` blob) stays folded until asked for — that text is
 * for debugging, and putting it on screen unbidden buries the sentence that
 * actually helps. Retry re-sends the exact prompt that died.
 */
function ErrorRow({
  item,
  onRetry,
  onDismiss,
  showTimestamp = false,
}: {
  item: Extract<ThreadItem, { kind: "error" }>
  onRetry?: () => void
  onDismiss?: () => void
  showTimestamp?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  // The pill buttons stay — they are the discoverable path. The menu repeats them.
  const menuItems: MenuItemSpec[] = [
    ...(onRetry ? [{ label: "Retry", icon: <RotateCwIcon />, onClick: onRetry }] : []),
    ...(item.detail
      ? [
          {
            label: "Copy",
            icon: <CopyIcon />,
            onClick: () =>
              copyText([item.title, item.reason, item.detail].filter(Boolean).join("\n")),
          },
        ]
      : []),
    ...(onDismiss ? [{ label: "Dismiss", onClick: onDismiss }] : []),
  ]
  return (
    <ItemContextMenu
      items={menuItems}
      className="select-text"
      onContextMenu={yieldToTextSelection}
    >
      <div className="my-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs">
        <div className="flex items-start gap-2">
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium text-destructive">{item.title}</p>
            {item.reason && <p className="text-muted-foreground">{item.reason}</p>}
            {item.detail && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="flex items-center gap-1 text-[11px] text-muted-foreground/80 hover:text-foreground"
              >
                <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
                {open ? "Hide details" : "Show details"}
              </button>
            )}
            {open && item.detail && (
              <pre className="max-h-56 overflow-auto rounded-md border border-destructive/20 bg-background/60 p-2 font-mono text-[11px] whitespace-pre-wrap">
                {item.detail}
              </pre>
            )}
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {onRetry && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1 rounded-full px-2 text-[11px]"
                  onClick={onRetry}
                  title="Send that message again"
                >
                  <RotateCwIcon className="size-3" />
                  Retry
                </Button>
              )}
              {item.detail && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 rounded-full px-2 text-[11px]"
                  onClick={() =>
                    void navigator.clipboard
                      ?.writeText([item.title, item.reason, item.detail].filter(Boolean).join("\n"))
                      .catch(() => {})
                  }
                >
                  <CopyIcon className="size-3" />
                  Copy
                </Button>
              )}
              {onDismiss && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 rounded-full px-2 text-[11px] text-muted-foreground"
                  onClick={onDismiss}
                >
                  Dismiss
                </Button>
              )}
              {showTimestamp && <Timestamp at={item.at} />}
            </div>
          </div>
        </div>
      </div>
    </ItemContextMenu>
  )
}

export function ThreadItemView({
  item,
  onContinue,
  onRetry,
  onDismiss,
  showTimestamps = false,
}: {
  item: ThreadItem
  /** Present only on the transcript's last interrupt notice — see ThreadView. */
  onContinue?: () => void
  /** Present on an error row that knows the prompt it killed. */
  onRetry?: () => void
  onDismiss?: () => void
  showTimestamps?: boolean
}) {
  switch (item.kind) {
    case "error":
      return (
        <ErrorRow
          item={item}
          onRetry={onRetry}
          onDismiss={onDismiss}
          showTimestamp={showTimestamps}
        />
      )
    case "user":
      return (
        <ItemContextMenu
          items={[{ label: "Copy text", icon: <CopyIcon />, onClick: () => copyText(item.text) }]}
          className="select-text"
          onContextMenu={yieldToTextSelection}
        >
          {/* Tinted, not filled: a soft wash of the accent with foreground text
              rather than the primary-on-primary-foreground pair, which is the
              loudest thing the theme has and made every prompt shout over the
              answer under it. Width, alignment and the corner tail are as they
              were — the bubble still hugs the right edge at 80%. */}
          <Message align="end" className="flex-col items-end gap-0.5 py-2">
            <MessageContent>
              <Bubble variant="tinted" align="end">
                <BubbleContent className="rounded-2xl rounded-br-sm px-4 py-2.5 text-sm whitespace-pre-wrap">
                  {item.text}
                </BubbleContent>
              </Bubble>
            </MessageContent>
            {showTimestamps && <Timestamp at={item.at} className="pr-1" />}
          </Message>
        </ItemContextMenu>
      )
    case "agent":
      return (
        <ItemContextMenu
          items={[{ label: "Copy text", icon: <CopyIcon />, onClick: () => copyText(item.text) }]}
          className="select-text"
          onContextMenu={yieldToTextSelection}
        >
          {/* The transcript is ONE column: prose, steps and notices all start on
              the same left edge, with nothing inset for a gutter. */}
          <Message className="flex-col items-start gap-0.5 py-2">
            <MessageContent>
              <Bubble variant="ghost">
                <BubbleContent className="text-sm leading-relaxed">
                  <AgentText text={item.text} />
                </BubbleContent>
              </Bubble>
            </MessageContent>
            {showTimestamps && <Timestamp at={item.at} />}
          </Message>
        </ItemContextMenu>
      )
    case "notice": {
      // Two things arrive as agent-authored transcript events: an interrupt
      // (one line, a rule) and a background task reporting back (a card — see
      // TaskNotificationCard). The store keeps the raw block; this is where it
      // becomes one or the other.
      const task = parseTaskNotification(item.text)
      if (task) {
        return <TaskNotificationCard task={task} at={item.at} showTimestamp={showTimestamps} />
      }
      // A break in the conversation, so it reads as one: hairline across the
      // column with the reason inline. An interrupt you can still resume gets
      // the resume button right there in the rule — picking the turn back up
      // is the only thing anyone wants after stopping it.
      return (
        <div className="flex items-center gap-2.5 py-2 text-[11px] text-muted-foreground/70">
          <span aria-hidden className="h-px flex-1 bg-border" />
          <span className="shrink-0">{item.text}</span>
          {showTimestamps && <Timestamp at={item.at} />}
          {onContinue && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 shrink-0 gap-1 rounded-full px-2 text-[11px]"
              onClick={onContinue}
              title="Ask the agent to pick up where it stopped"
            >
              <PlayIcon className="size-3" />
              Continue
            </Button>
          )}
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
      )
    }
    case "thought": {
      const reasoning = item.text.trim()

      return (
        <StepRow
          label="think"
          status={null}
          mono={false}
          target={reasoning.split("\n").find((line) => line.trim()) ?? "…"}
          detail={
            <p className="text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {reasoning}
            </p>
          }
        />
      )
    }
    case "tool":
      return <ToolStep item={item} showTimestamp={showTimestamps} />
    case "plan":
      return <PlanStep item={item} />
    case "compaction":
      return <CompactionStep item={item} showTimestamp={showTimestamps} />
  }
}

/** A context compaction, in the place in the transcript where it happened —
    the marker saying the history above it is no longer what the agent can see.
    A step row like any other, with the retained summary folded behind it: the
    summary is the only part anyone reads twice, and it can be long. */
function CompactionStep({
  item,
  showTimestamp,
}: {
  item: CompactionItem
  showTimestamp?: boolean
}) {
  const running = item.status === "in_progress"
  const failed = item.status === "failed"
  const cancelled = item.status === "cancelled"
  const label = running
    ? "Compacting context…"
    : failed
      ? "Compaction failed"
      : cancelled
        ? "Compaction cancelled"
        : "Context compacted"
  // A failure explains itself even with no summary; a summary is worth opening
  // on any status. Nothing to show means a plain rule with no affordance.
  const detail =
    item.summary.length > 0 || item.error ? (
      <div className="min-w-0 space-y-2">
        {item.error && <p className="text-xs text-destructive">{item.error}</p>}
        {item.summary.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
      </div>
    ) : undefined

  return (
    <StepRow
      label="context"
      icon={FoldVerticalIcon}
      status={running ? "in_progress" : failed ? "failed" : null}
      mono={false}
      target={label}
      metric={showTimestamp && item.at !== undefined ? <Timestamp at={item.at} /> : undefined}
      detail={detail}
    />
  )
}

/* Agents stream output as many small text blocks (one per result, per line).
   Rendering a bordered box per block turns six one-liners into six panels —
   consecutive text is one stream, so it gets one block. */
function mergeText(content: acp.ToolCallContent[]): acp.ToolCallContent[] {
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
function DetailSection({ label, children }: { label: string; children: React.ReactNode }) {
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
function ToolInput({ item }: { item: ToolItem }) {
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
function ToolLocations({ item }: { item: ToolItem }) {
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
function ToolProse({ text }: { text: string }) {
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
function ShellScript({ command, className }: { command: string; className?: string }) {
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

function CodeBlock({
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
function SmartBlock({
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
const OUTPUT_LIMIT = 8_000

function useShowAll(text: string, limit = OUTPUT_LIMIT): [string, boolean, () => void] {
  const [all, setAll] = React.useState(false)
  const over = !all && text.length > limit
  return [over ? `${text.slice(0, limit).trimEnd()}\n…` : text, over, () => setAll(true)]
}

function ShowAll({ onClick }: { onClick: () => void }) {
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

const PANE = "overflow-hidden rounded-md border border-border/50 bg-muted/30"

// ─── Per-kind layouts ────────────────────────────────────────────────────────

/**
 * A shell run: the command on a `$` line, its stream underneath behind a
 * hairline. One pane, so the command and what it printed read as one event —
 * which is what a shell run is.
 */
function RunDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const command = toolPrimaryText(item) ?? toolTarget(item)
  const failed = item.status === "failed"
  const [out, over, showAll] = useShowAll(toolOutputText(item, 200_000).text)

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
      {!out.trim() && active && <ToolCallSkeleton className="border-t border-inherit p-2.5" />}
      {over && <ShowAll onClick={showAll} />}
    </div>
  )
}

/**
 * A file read: numbered lines, starting at the requested offset so the numbers
 * match the editor. Reading a file is the one case where "which line" is the
 * whole point, and a flat pre throws that away.
 */
function ReadDetail({ item }: { item: ToolItem }) {
  const input =
    item.rawInput && typeof item.rawInput === "object" && !Array.isArray(item.rawInput)
      ? (item.rawInput as Record<string, unknown>)
      : null
  const first = typeof input?.offset === "number" ? input.offset : 1
  const [body, over, showAll] = useShowAll(toolOutputText(item, 200_000).text)
  if (!body.trim()) return null

  const lines = body.split("\n")
  // Agents often return content already prefixed with `NNN\t`; don't number twice.
  const preNumbered = lines.length > 1 && /^\s*\d+\t/.test(lines[0])

  const language = toolLanguage(item)

  return (
    <div className={PANE}>
      {/* The gutter is a sibling column, not a prefix on each line: that keeps
          the code a single fence the highlighter can colour, and `whitespace-pre`
          on both halves means one screen line per source line, so the numbers
          stay aligned. */}
      <div className="flex max-h-80 overflow-auto">
        {!preNumbered && (
          <pre
            aria-hidden
            className="shrink-0 py-1 pe-3 ps-2 text-end font-mono text-[11.5px] leading-5 tabular-nums whitespace-pre text-muted-foreground/45 select-none"
          >
            {lines.map((_, index) => first + index).join("\n")}
          </pre>
        )}
        <div className="min-w-max flex-1 py-1 pe-3">
          <Highlighted
            code={body}
            language={language}
            className="[&_pre]:whitespace-pre [&_pre]:leading-5 [&_pre]:text-[11.5px]"
          />
        </div>
      </div>
      {over && <ShowAll onClick={showAll} />}
    </div>
  )
}

/** Highlight every occurrence of the search pattern inside one result line. */
function MarkedLine({ text, pattern }: { text: string; pattern: string | null }) {
  if (!pattern) return <>{text}</>
  // The pattern is a regex the agent wrote; compiling it is the point, but a
  // bad one must not take the transcript down with it.
  let re: RegExp
  try {
    re = new RegExp(`(${pattern})`, "gi")
  } catch {
    return <>{text}</>
  }
  return (
    <>
      {text.split(re).map((part, index) =>
        index % 2 === 1 ? (
          <mark key={index} className="bg-primary/20 text-foreground">
            {part}
          </mark>
        ) : (
          <React.Fragment key={index}>{part}</React.Fragment>
        )
      )}
    </>
  )
}

const MAX_MATCHES = 200

/**
 * Search hits as located matches, not a wall of text. `path:line:match` is
 * split so the paths form a scannable column and the matched text reads as
 * content — the shape ripgrep output actually has.
 */
function SearchDetail({ item }: { item: ToolItem }) {
  const input =
    item.rawInput && typeof item.rawInput === "object" && !Array.isArray(item.rawInput)
      ? (item.rawInput as Record<string, unknown>)
      : null
  const pick = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : null)
  const pattern = pick("pattern") ?? pick("query")
  const scope = pick("path") ?? pick("glob")
  const lines = toolOutputText(item, 60_000)
    .text.split("\n")
    .filter((line) => line.trim().length > 0)
  const shown = lines.slice(0, MAX_MATCHES)

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
        {pattern && <code className="font-mono text-foreground">{pattern}</code>}
        {scope && (
          <span className="font-mono text-muted-foreground">in {shortPath(scope, 44)}</span>
        )}
        <span className="text-muted-foreground/70">
          {lines.length} {lines.length === 1 ? "match" : "matches"}
        </span>
      </div>
      {shown.length > 0 && (
        <div className={cn(PANE, "max-h-80 overflow-auto")}>
          <ul className="divide-y divide-border/40 font-mono text-[11.5px]">
            {shown.map((line, index) => {
              const match = /^(.*?):(\d+):(.*)$/.exec(line)
              return (
                <li key={index} className="flex gap-2 px-2.5 py-1">
                  {match ? (
                    <>
                      <span className="shrink-0 text-muted-foreground/70">
                        {shortPath(match[1], 42)}
                        <span className="text-muted-foreground/40">:{match[2]}</span>
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        <MarkedLine text={match[3].trim()} pattern={pattern} />
                      </span>
                    </>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{line}</span>
                  )}
                </li>
              )
            })}
          </ul>
          {lines.length > shown.length && (
            <div className="px-2.5 py-1 text-[11px] text-muted-foreground/60">
              …and {lines.length - shown.length} more
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A fetch: the URL as a link first, because that is the thing you want to open. */
function FetchDetail({ item }: { item: ToolItem }) {
  const input =
    item.rawInput && typeof item.rawInput === "object" && !Array.isArray(item.rawInput)
      ? (item.rawInput as Record<string, unknown>)
      : null
  const pick = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : null)
  const url = pick("url")
  const query = pick("query") ?? pick("prompt")
  const { text } = toolOutputText(item, 20_000)

  return (
    <div className="space-y-1.5">
      {url && (
        <a
          href={/^https?:\/\//.test(url) ? url : undefined}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 font-mono text-[11px] text-primary hover:underline"
        >
          <GlobeIcon className="size-3 shrink-0" />
          <span className="truncate">{url}</span>
        </a>
      )}
      {query && !url && <div className="text-[11px] text-muted-foreground">“{query}”</div>}
      <SmartBlock text={text} />
    </div>
  )
}

/** Keeps the server's tail alive through quiet stretches (a subagent can run
    for many minutes between journal lines) and backfills anything a missed
    notification or a reload dropped. The push stream is the fast path; this is
    the floor under it. */
const TASK_REFRESH_MS = 90_000

/**
 * Live progress of a background task — work the agent launched and left
 * running past the end of the turn (a Claude Code workflow, say). The turn is
 * over, so no ACP frame will ever carry this; the events come off the server's
 * tail of the task's own journal on disk. Mounting the panel starts that tail
 * (`/api/tasks/watch`), and the module store it fills is keyed by transcript
 * dir, so every peer and every remount reads the same journal.
 */
function TaskProgress({ task }: { task: BackgroundTask }) {
  const events = useTaskEvents(task.transcriptDir)
  const [unreachable, setUnreachable] = React.useState(false)
  React.useEffect(() => {
    const settings = loadSettings()
    if (!settings) return
    let cancelled = false
    const ask = () =>
      watchTask(settings, task.transcriptDir).then(
        () => !cancelled && setUnreachable(false),
        () => !cancelled && setUnreachable(true)
      )
    void ask()
    const timer = setInterval(() => void ask(), TASK_REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [task.transcriptDir])

  const rows = taskAgentRows(events)
  const findings = taskFindings(rows)
  const finished = rows.filter((row) => row.done).length

  if (rows.length === 0) {
    return (
      <p className={cn("text-[11px] text-muted-foreground/70", !unreachable && "harness-shimmer")}>
        {unreachable
          ? "Couldn't follow this task's journal on the server."
          : "Waiting for the task's journal…"}
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        {task.summary && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{task.summary}</span>
        )}
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
          {finished}/{rows.length} agents finished
        </span>
      </div>
      <ul className="space-y-0.5">
        {rows.map((row, index) => (
          <li key={row.agentId} className="flex items-center gap-2 text-[11px]">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                row.failed
                  ? "bg-destructive"
                  : row.done
                    ? "bg-primary"
                    : "harness-node-active bg-primary"
              )}
            />
            {/* The journal's agent ids are hashes; their order is the readable
                identity. The real id stays on the tooltip for cross-reference
                with the transcript dir. */}
            <span
              title={row.agentId}
              className={cn("font-mono", row.done ? "text-muted-foreground" : "harness-shimmer")}
            >
              agent {index + 1}
            </span>
            <span className={cn("text-[10px]", row.failed ? "text-destructive" : "text-muted-foreground/60")}>
              {row.failed ? "failed" : row.done ? "finished" : "running"}
            </span>
          </li>
        ))}
      </ul>
      {findings.length > 0 && (
        <div className={cn(PANE, "max-h-56 overflow-auto")}>
          <ul className="divide-y divide-border/40">
            {findings.map((title, index) => (
              <li key={index} className="px-2.5 py-1 text-[11px] text-muted-foreground">
                {title}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const compactTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1000)}k` : String(n)

/**
 * A background task reporting back.
 *
 * The runtime announces the end of the task as a synthetic user turn holding a
 * `<task-notification>` block (parsed in lib/tools). It is the other half of
 * the launch — the Workflow row started it, this says how it went — so it gets
 * a card of its own rather than a rule, and the failures are the point of it:
 * an audit where every stage died on a rate limit produced nothing, and the
 * only honest way to show that is to say so.
 */
function TaskNotificationCard({
  task,
  at,
  showTimestamp,
}: {
  task: TaskNotification
  at?: number
  showTimestamp?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const failed = task.failures.length > 0
  /* Every stage of a fan-out usually fails for ONE reason (a rate limit, a
     dead endpoint). Listing it five times buries the sentence; the stages that
     share a message are named together in front of it. */
  const grouped = React.useMemo(() => {
    const byMessage = new Map<string, string[]>()
    for (const failure of task.failures) {
      byMessage.set(failure.message, [...(byMessage.get(failure.message) ?? []), failure.label])
    }
    return [...byMessage.entries()].map(([message, labels]) => ({ message, labels }))
  }, [task.failures])

  const stats = [
    task.agentCount !== undefined && `${task.agentCount} agents`,
    task.agentsDone ? `${task.agentsDone} finished` : null,
    task.agentsError ? `${task.agentsError} failed` : null,
    task.durationMs !== undefined && formatElapsed(task.durationMs),
    task.subagentTokens !== undefined && `${compactTokens(task.subagentTokens)} tokens`,
  ].filter((entry): entry is string => typeof entry === "string")

  return (
    <div
      className={cn(
        "my-2 rounded-xl border px-3 py-2.5 text-xs",
        failed ? "border-destructive/30 bg-destructive/5" : "border-border/60 bg-muted/30"
      )}
    >
      <div className="flex items-start gap-2">
        {failed ? (
          <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-destructive" />
        ) : (
          <ListTodoIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className={cn("font-medium", failed ? "text-destructive" : "text-foreground")}>
            {task.summary ?? "Background task finished"}
          </p>
          {stats.length > 0 && (
            <p className="text-[11px] tabular-nums text-muted-foreground">{stats.join(" · ")}</p>
          )}
          {grouped.map(({ message, labels }, index) => (
            <div key={index} className="space-y-0.5">
              <p className="flex flex-wrap gap-1">
                {labels.map((label) => (
                  <span
                    key={label}
                    className="rounded bg-destructive/10 px-1.5 py-px font-mono text-[10px] text-destructive"
                  >
                    {label}
                  </span>
                ))}
              </p>
              <p className="text-[11px] text-muted-foreground">{message}</p>
            </div>
          ))}
          {task.result && (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground/80 hover:text-foreground"
            >
              <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
              {open ? "Hide result" : "Show result"}
            </button>
          )}
          {open && task.result && <SmartBlock text={task.result} />}
          {/* The per-agent journal is still on disk, and the panel on the
              launch row above is already tailing it — so this says where the
              detail lives rather than repeating it here. */}
          {task.transcriptDir && (
            <p className="truncate font-mono text-[10px] text-muted-foreground/50" title={task.transcriptDir}>
              {shortPath(task.transcriptDir, 60)}
            </p>
          )}
          {showTimestamp && <Timestamp at={at} />}
        </div>
      </div>
    </div>
  )
}

/** Diffs and inline content blocks — the payload a code block cannot show. */
function ToolContentBlocks({ item }: { item: ToolItem }) {
  if (item.content.length === 0) return null
  return (
    <div className="space-y-2">
      {mergeText(item.content).map((block, index) => (
        <ToolContentView key={index} content={block} />
      ))}
    </div>
  )
}

/**
 * The body of an expanded step. Dispatch is on the ACP `kind` (or the kind
 * inferred from the tool's name) rather than on a table of vendor tool names:
 * `kind` is the part of this that is actually protocol, and every runtime that
 * sends it gets the right layout for free.
 */
function ToolDetail({ item, active }: { item: ToolItem; active: boolean }) {
  const failed = item.status === "failed"
  const kind = toolKindOf(item)

  // An edit is its diff, whichever tool produced it and wherever it arrived.
  const diffs = item.content.filter((block) => block.type === "diff")
  if (diffs.length > 0) {
    return (
      <div className="space-y-1.5">
        <ToolContentBlocks item={item} />
        {failed && <SmartBlock text={toolOutputText(item).text} tone="error" />}
      </div>
    )
  }
  const edit = extractEditInput(item)
  if (edit) {
    return (
      <div className="space-y-1.5">
        <DiffView
          oldText={edit.oldText}
          newText={edit.newText}
          path={edit.path ? shortPath(edit.path, 80) : undefined}
        />
        {failed && <SmartBlock text={toolOutputText(item).text} tone="error" />}
      </div>
    )
  }

  switch (kind) {
    case "execute":
      return <RunDetail item={item} active={active} />
    case "read":
      return <ReadDetail item={item} />
    case "search":
      return <SearchDetail item={item} />
    case "fetch":
      return <FetchDetail item={item} />
    default: {
      // Everything else, MCP tools included: what went in, what came back.
      const { text, truncated } = toolOutputText(item)
      const hasInput = JSON.stringify(item.rawInput ?? null) !== "null"
      const task = extractBackgroundTask(item)
      return (
        <>
          {task && (
            <DetailSection label={task.workflowName ? `Task · ${task.workflowName}` : "Background task"}>
              <TaskProgress task={task} />
            </DetailSection>
          )}
          {hasInput && (
            <DetailSection label="Input">
              <ToolInput item={item} />
            </DetailSection>
          )}
          {item.locations.length > 0 && (
            <DetailSection label={item.locations.length === 1 ? "File" : "Files"}>
              <ToolLocations item={item} />
            </DetailSection>
          )}
          {(text.trim() || item.content.length > 0) && (
            <DetailSection label={failed ? "Error" : active ? "Output so far" : "Output"}>
              <ToolContentBlocks item={item} />
              {item.content.length === 0 && (
                <SmartBlock
                text={truncated ? `${text}\n\n… output truncated` : text}
                tone={failed ? "error" : undefined}
                language={toolLanguage(item)}
              />
              )}
            </DetailSection>
          )}
          {!text.trim() && item.content.length === 0 && active && (
            <ToolCallSkeleton className="py-1" />
          )}
        </>
      )
    }
  }
}

function ToolStep({ item, showTimestamp }: { item: ToolItem; showTimestamp?: boolean }) {
  const active = item.status === "in_progress" || item.status === "pending"
  const kind = toolKindOf(item)
  const KindIcon = KIND_ICONS[kind] ?? WrenchIcon
  const summary = toolSummary(item, active)
  const hasBody =
    item.content.length > 0 ||
    item.locations.length > 0 ||
    JSON.stringify(item.rawInput ?? null) !== "null" ||
    toolOutputText(item, 1).text.length > 0

  return (
    <StepRow
      label={KIND_LABELS[kind] ?? KIND_LABELS.other}
      status={item.status}
      icon={KindIcon}
      target={toolTarget(item)}
      metric={
        <span className="flex items-center gap-1.5">
          {/* The closed row already says what happened, so opening it is for
              reading the content rather than for learning the outcome. */}
          {summary && <span className="truncate">{summary}</span>}
          {showTimestamp && <Timestamp at={item.at} />}
        </span>
      }
      startedAt={item.startedAt}
      detail={hasBody || active ? <ToolDetail item={item} active={active} /> : undefined}
      /* A diff is the point of an edit — collapsing it hides the only thing
         worth reviewing. A background task is still producing after its turn
         ends — folded, the only live thing on screen would be invisible. Every
         other kind stays folded: a read or a search is a fact, not something
         you check line by line. */
      defaultOpen={kind === "edit" || extractBackgroundTask(item) !== null}
    />
  )
}

/** Everything a tool call produced, rendered the way the transcript renders it.
    Shared with the approval card so a diff looks the same before and after. */
export function ToolCallContent({ content }: { content: acp.ToolCallContent[] }) {
  return mergeText(content).map((part, i) => <ToolContentView key={i} content={part} />)
}

function ToolContentView({ content }: { content: acp.ToolCallContent }) {
  if (content.type === "diff") {
    return (
      <DiffView
        oldText={content.oldText}
        newText={content.newText}
        path={content.path ? shortPath(content.path, 80) : undefined}
      />
    )
  }
  if (content.type === "content") return <ContentBlockView block={content.content} />
  return <div className="text-[11px] text-muted-foreground">[{content.type}]</div>
}

/** The non-text halves of an ACP ContentBlock. These used to fall through to a
    `[content]` placeholder, which hid an image the tool actually returned. */
function ContentBlockView({ block }: { block: acp.ContentBlock }) {
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

function PlanStep({ item }: { item: PlanItem }) {
  /* A plan the agent wrote as prose, or parked in a file. Neither has entries,
     so there is no progress to count and nothing to tick off — the content IS
     the plan. Rendering it as an empty checklist (which is what happened before
     these two variants were handled) said the agent had planned nothing. */
  if (item.markdown !== undefined || item.uri !== undefined) {
    return (
      <StepRow
        label="plan"
        icon={ListTodoIcon}
        status={null}
        mono={false}
        target={item.uri ? shortPath(item.uri) : "plan"}
        detail={
          item.markdown !== undefined ? (
            <Prose text={item.markdown} />
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{item.uri}</span>
          )
        }
      />
    )
  }

  const done = item.entries.filter((e) => e.status === "completed").length
  const current = item.entries.find((e) => e.status === "in_progress")
  // Agents often leave a plan with nothing in_progress (turn ended mid-list).
  // Headline the step that's up next, and only spin while one is actually running.
  const next = current ?? item.entries.find((e) => e.status !== "completed")
  return (
    <StepRow
      label="plan"
      icon={ListTodoIcon}
      status={current ? "in_progress" : next ? null : "completed"}
      mono={false}
      target={next?.content ?? "all steps complete"}
      metric={`${done}/${item.entries.length}`}
      detail={
        <ul className="space-y-1">
          {item.entries.map((entry, i) => (
            <li key={i} className="flex items-start gap-2 text-xs">
              <span
                className={cn(
                  "mt-1.5 size-1.5 shrink-0 rounded-full",
                  entry.status === "completed"
                    ? "bg-primary"
                    : entry.status === "in_progress"
                      ? "harness-node-active bg-primary"
                      : "bg-muted-foreground/40"
                )}
              />
              <span
                className={cn(
                  "min-w-0",
                  entry.status === "completed"
                    ? "text-muted-foreground line-through"
                    : entry.status === "in_progress"
                      ? "text-foreground"
                      : "text-muted-foreground"
                )}
              >
                {entry.content}
                {/* ACP carries a priority per entry and we were dropping it.
                    Only "high" earns ink — medium is the default nobody needs
                    telling about, and low marking itself out would be noise. */}
                {entry.priority === "high" && entry.status !== "completed" ? (
                  <span className="ml-1.5 text-[10px] uppercase tracking-wide text-primary/70">
                    high
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      }
    />
  )
}
