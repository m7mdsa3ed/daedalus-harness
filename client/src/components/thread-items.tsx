import * as React from "react"
import type * as acp from "@agentclientprotocol/sdk"
import {
  BotIcon,
  FoldVerticalIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  PlayIcon,
  RotateCwIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"
import { ChevronRightIcon, CopyIcon } from "lucide-react"
import { toast } from "sonner"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { ItemContextMenu, type MenuItemSpec } from "@/components/item-context-menu"
import { reportError } from "@/lib/errors"
import { Message, MessageContent } from "@/components/ui/message"
/* The tool-call layouts and the boxes they are built from live in their own
   files — see the header comment on each. This one keeps the transcript's own
   rows: a message, a step, a plan, a compaction. */
import {
  ContentBlockView,
  FileBadge,
  KIND_ICONS,
  KIND_LABELS,
  Prose,
  SmartBlock,
  SourceChip,
  Timestamp,
  ToolCallContent,
} from "@/components/tool-parts"
import {
  SubagentBrief,
  SubagentReport,
  ToolDetail,
  ToolSources,
  TodoList,
  toolHasDetail,
  toolOpensByDefault,
} from "@/components/tool-views"
import {
  childToolTitle,
  extractSubagent,
  parseTaskNotification,
  shortPath,
  toolKindOf,
  toolHeading,
  webInput,
  type TaskNotification,
  type TodoEntry,
} from "@/lib/tools"
import type { TurnSources } from "@/lib/sources"
import type { Row, SubagentGroup, ToolRunGroup } from "@/lib/transcript-rows"
import { cn } from "@/lib/utils"
import { useViewOptionsContext } from "@/lib/view-options"
import type { CompactionItem, PlanItem, ThreadItem, ToolItem } from "@/lib/store"

/* Re-exported so the approval card and the editor panel keep importing the
   transcript's vocabulary from the transcript, not from its internals. */
export { FileBadge, KIND_ICONS, KIND_LABELS, Prose, Timestamp, ToolCallContent }

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
   step (rail geometry in index.css). The thing acted on is the headline, and
   the kind of step is the leading icon — it was also a word in the right-hand
   column, which spent a column of every row repeating what the mark beside it
   already said. Only a failure claims that column now. Everything a step
   produced is collapsed behind the row until clicked. */



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

/* Memoized: one per transcript row, and a streaming turn re-renders the whole
   list if nothing stops it. The reducer leaves untouched items referentially
   stable, so memo lets a chunk re-render only the tail. `target`, `label` and
   `metric` arrive as ReactNode from the caller and are rebuilt on every render
   of the kind components below — those wrap this in memo too, so the node props
   they pass are rebuilt once per kind render, not unusably often. */
const StepRow = React.memo(function StepRow({
  target,
  caption,
  file,
  filePath,
  label,
  status,
  metric,
  detail,
  below,
  startedAt,
  mono = true,
  defaultOpen = false,
  openSetting,
  icon: Icon,
}: {
  target: React.ReactNode
  /** A second, quieter line under the target — the literal thing invoked when
      the target is the agent's prose *about* it (see `toolHeading`). */
  caption?: string
  /** A file the row acted on, drawn as a badge chip next to the target — the
      path is elided to its basename so "Read /path/to/file" reads as "Read" +
      a `file` chip rather than an elided mono line. */
  file?: string
  /** The full path behind the badge, for its tooltip. */
  filePath?: string
  /** The trailing word. Optional: a row whose leading icon already says what
      kind of step it is (every tool, plan and compaction row does) prints
      nothing here, and only a failure claims the column. */
  label?: string
  status: string | null
  metric?: React.ReactNode
  detail?: React.ReactNode
  /** A strip under the header that stays whether or not the row is open —
      the step's outcome in chips (the pages a web search returned, the page
      a fetch read). The detail is what you open to read; this is what you
      see without opening it. */
  below?: React.ReactNode
  startedAt?: number
  mono?: boolean
  /** Start expanded — edits show their diff without a click (see ToolStep). */
  defaultOpen?: boolean
  /** The view option behind `defaultOpen`, when one of them is. Changing it
      re-applies `defaultOpen` to a row that is already on screen; see below for
      why that is a separate prop rather than just watching `defaultOpen`. */
  openSetting?: boolean
  /** Leading mark. On an expandable row it swaps for a chevron on hover, so
      the disclosure affordance appears where the eye already is instead of at
      the far end of the line. */
  icon?: React.ComponentType<{ className?: string }>
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  /* `useState` reads its argument once, so a `defaultOpen` that later changes
     is thrown away — which is why "Show thinking" and "Expand tool output"
     appeared to do nothing: the context update reached every row and every row
     ignored it, so only steps that mounted *after* the flip honoured it.

     The re-sync is keyed on the option, NOT on `defaultOpen`. `defaultOpen` for
     a tool is `showToolDetails || toolOpensByDefault(item)`, and the second
     half flips on its own mid-stream — a call is `generic` until its input
     arrives and an `edit` once it does — so watching the whole expression would
     yank rows open as they stream and re-open ones you had just collapsed.
     Watching the setting means a row you closed by hand stays closed until you
     actually change the setting again. Turning the setting *off* re-applies
     `defaultOpen` too, which lands on the natural default rather than closing
     everything: an edit goes back to showing its diff, a read goes back to
     folded. */
  const latestDefault = React.useRef(defaultOpen)
  latestDefault.current = defaultOpen
  React.useEffect(() => {
    // Same value on mount, so React bails out without a second render.
    setOpen(latestDefault.current)
  }, [openSetting])
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
          // items-start, not items-baseline: the target span is `truncate`
          // (overflow: hidden), so its baseline is its bottom edge — baseline
          // alignment lifted the title ~5px above the "edit"/"run" label. Every
          // child is a leading-6 line box (the icon is given the same height),
          // so starting them lines them up exactly — and a row that grew a
          // caption keeps its label and metric pinned to the first line rather
          // than drifting to the middle of two, which `items-center` did.
          // The width is calc(100% + 12px) so the -mx-1.5/px-1.5 hover bleed
          // cancels on BOTH sides: a `w-full` box only shifts left under a
          // negative start margin, which left the row's content edge 12px shy
          // of the right edge that messages run to.
          "group/step -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-start gap-2 rounded-md px-1.5 py-0.5 text-start transition-colors duration-150",
          expandable && "hover:bg-muted/40"
        )}
      >
        {Icon && (
          <span
            className={cn(
              // h-6, not size-3.5: the mark has to occupy a whole line box, or
              // `items-start` would hang it off the top of the text it marks.
              "relative flex h-6 w-3.5 shrink-0 items-center justify-center",
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
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span
              className={cn(
                "min-w-0 truncate text-xs leading-6",
                mono && "font-mono",
                failed ? "text-destructive" : "text-muted-foreground",
                active && "harness-shimmer"
              )}
            >
              {target}
            </span>
            {/* The file a step acted on, as a chip: the path is gone in the
                basename, so the row says "Read" + `package.json` instead of an
                elided "/var/www/…/package.json". Baseline-aligned with the
                title so it reads on the same line, never on a second row. */}
            {file && <FileBadge file={file} filePath={filePath} />}
          </span>
          {/* The command under its description. One notch quieter and one notch
              smaller than the title, and always mono — it is the literal thing
              that ran, so it is read as code even when the line above it is
              prose. `-mt-1` claws back the slack in the two leadings so the
              pair reads as one row rather than as two. */}
          {caption && (
            <span className="-mt-1 min-w-0 truncate font-mono text-[11px] leading-5 text-muted-foreground/55">
              {caption}
            </span>
          )}
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
        {(failed || label) && (
          <span
            className={cn(
              "shrink-0 text-[11px] leading-6",
              failed ? "text-destructive" : "text-muted-foreground/50"
            )}
          >
            {failed ? "failed" : label}
          </span>
        )}
      </button>

      {below && <div className="mb-1 min-w-0 pl-[1.375rem]">{below}</div>}
      {expandable && open && <div className="mt-1 mb-2.5 min-w-0 space-y-2">{detail}</div>}
    </div>
  )
})
StepRow.displayName = "StepRow"


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
const TaskNotificationCard = React.memo(function TaskNotificationCard({
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
})
TaskNotificationCard.displayName = "TaskNotificationCard"

/* The row shapes are `lib/transcript-rows`' — the transform that builds them
   is shared with the nested transcript a subagent step draws, and both this
   file and thread-view read them. Re-exported so callers keep importing the
   transcript's vocabulary from the transcript. */
export type { Row, SubagentGroup, ToolRunGroup }

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
  websearch: "searching the web",
  webfetch: "reading",
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
  websearch: "time",
  webfetch: "page",
}

const KIND_NOUNS_PLURAL: Record<string, string> = {
  search: "searches",
  fetch: "fetches",
  time: "times",
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
    // The web's two acts are named apart from the `fetch` kind they share:
    // "searching the web 3 times, reading 2 pages" says what a run of
    // globe-icon rows did; "fetching 5 fetches" did not.
    const web = webInput(item)
    const kind = web?.query ? "websearch" : web?.url ? "webfetch" : toolKindOf(item)
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

/** The rail nested steps hang off: one for a run and for a subagent's
    transcript alike, so a subagent's steps read as steps and not as a second
    kind of list. `ml-[calc(0.75rem-1px)]` puts the line under the parent
    row's icon column, and a rail inside a rail indents once more. */
const RAIL_CLASS = "mt-0.5 ml-[calc(0.75rem-1px)] space-y-0.5 border-l border-border/60 pl-2.5"

/** "N earlier steps" — the top of a peeking rail. */
function EarlierSteps({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-1 block rounded px-1 text-[11px] leading-5 text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      {count} earlier {count === 1 ? "step" : "steps"}
    </button>
  )
}

export const ToolRun = React.memo(function ToolRun({
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
        <div className={RAIL_CLASS}>
          {hidden > 0 && <EarlierSteps count={hidden} onClick={() => setOpen(true)} />}
          {showing.map((item) => (
            <ToolStep key={item.id} item={item} showTimestamp={showTimestamps} />
          ))}
        </div>
      )}
    </div>
  )
})
ToolRun.displayName = "ToolRun"

/**
 * One row of the transcript, whichever shape `buildRows` gave it. The top
 * level and every subagent's rail draw through this, which is what makes a
 * nested transcript the same transcript — same step rows, same prose, same
 * grouping — and not a summary of one.
 */
export const RowView = React.memo(function RowView({
  row,
  onContinue,
  onRetry,
  onDismiss,
  showTimestamps,
  streaming,
}: {
  row: Row
  onContinue?: () => void
  onRetry?: () => void
  onDismiss?: () => void
  showTimestamps?: boolean
  /** This row is the transcript's tail and the turn is still open — it is the
      one thing still being written. Only a thought draws differently for it
      (see ThreadItemView); prose streams visibly on its own. */
  streaming?: boolean
}) {
  if (row.kind === "run") return <ToolRun items={row.items} showTimestamps={showTimestamps} />
  if (row.kind === "subagent-group") return <SubagentStep group={row} showTimestamps={showTimestamps} />
  return (
    <ThreadItemView
      item={row}
      onContinue={onContinue}
      onRetry={onRetry}
      onDismiss={onDismiss}
      showTimestamps={showTimestamps}
      streaming={streaming}
    />
  )
})
RowView.displayName = "RowView"

/** Every tool step a subagent ran, out of its rows — for the count on the
    step's header line. Its own subagents' steps count too: they are its work. */
function collectTools(rows: Row[]): ToolItem[] {
  const out: ToolItem[] = []
  for (const row of rows) {
    if (row.kind === "tool") out.push(row)
    else if (row.kind === "run") out.push(...row.items)
    else if (row.kind === "subagent-group") {
      if (row.head.kind === "tool") out.push(row.head)
      out.push(...collectTools(row.children))
    }
  }
  return out
}

/**
 * A subagent: the step that launched it, with everything it did underneath.
 *
 * Brief, then the rail of steps and prose, then the report — the order the
 * work happened in. Open while it runs (a worker's rail is the one live thing
 * on screen; folded, the transcript would go quiet exactly where the agent
 * is busiest) and left as it is when it finishes: StepRow reads its default
 * once, so a rail you were watching does not snap shut under you. The rail
 * peeks its last few steps while live, like a run does.
 *
 * `head` is a Task tool call (Claude Code, OpenCode, Codex's legacy rows) or
 * the session the agent announced (the ACP subagent RFD). The RFD's has no
 * brief or report of its own — the child's prose IS the report, and it is in
 * the rail — so those two halves are drawn only for a tool head.
 */
export const SubagentStep = React.memo(function SubagentStep({
  group,
  showTimestamps,
}: {
  group: SubagentGroup
  showTimestamps?: boolean
}) {
  const { head, children } = group
  const view = useViewOptionsContext()
  const tool = head.kind === "tool" ? head : null
  const session = head.kind === "subagent" ? head : null
  const call = tool ? extractSubagent(tool) : null
  /* The RFD's states onto the step vocabulary: `failed` is a failure,
     `cancelled`/`disconnected` are endings that are not — they get the word
     in the label column, in the quiet colour, rather than "failed". */
  const status = tool
    ? tool.status
    : session!.state === "running"
      ? "in_progress"
      : session!.state === "failed"
        ? "failed"
        : "completed"
  const label =
    session && (session.state === "cancelled" || session.state === "disconnected") ? session.state : undefined
  const active = status === "in_progress" || status === "pending"

  const target = tool ? (call?.description ?? toolHeading(tool).title) : session!.task || session!.name
  const caption = tool
    ? [call?.agentType, call?.model].filter(Boolean).join(" · ") || undefined
    : session!.name
  const steps = collectTools(children)
  const prose = summarise(steps)
    .map(({ verb, noun, count }) => `${verb} ${count} ${pluralNoun(noun, count)}`)
    .join(", ")
  const hasBody = tool !== null || children.length > 0 || active

  return (
    <StepRow
      icon={BotIcon}
      status={status}
      label={label}
      target={target}
      caption={caption}
      mono={false}
      startedAt={head.startedAt}
      metric={
        prose || showTimestamps ? (
          <>
            {prose}
            {prose && showTimestamps && " · "}
            {showTimestamps && <Timestamp at={head.at} />}
          </>
        ) : undefined
      }
      detail={
        hasBody ? (
          <div className="space-y-2">
            {tool && <SubagentBrief item={tool} />}
            {/* The rail is drawn while the subagent is live even with nothing
                on it yet, so the working line at its foot has somewhere to sit
                and the first step lands in place rather than opening a rail. */}
            {(children.length > 0 || active) && (
              <SubagentTranscript rows={children} active={active} showTimestamps={showTimestamps} />
            )}
            {tool && <SubagentReport item={tool} active={active} />}
          </div>
        ) : undefined
      }
      defaultOpen={active || view.showToolDetails}
      openSetting={view.showToolDetails}
    />
  )
})
SubagentStep.displayName = "SubagentStep"

/** A subagent's rows, on a rail. Peeks the tail while the subagent is live;
    the whole thing once it is done, or once asked. */
function SubagentTranscript({
  rows,
  active,
  showTimestamps,
}: {
  rows: Row[]
  active: boolean
  showTimestamps?: boolean
}) {
  const [expanded, setExpanded] = React.useState(false)
  const showing = expanded || !active ? rows : rows.slice(-PEEK)
  const hidden = rows.length - showing.length
  return (
    <div className={RAIL_CLASS}>
      {hidden > 0 && <EarlierSteps count={hidden} onClick={() => setExpanded(true)} />}
      {showing.map((row, i) => (
        <RowView
          key={row.id}
          row={row}
          showTimestamps={showTimestamps}
          streaming={active && i === showing.length - 1}
        />
      ))}
      {/* The subagent's own working line, at the foot of its rail: the thread's
          indicator under the composer says the *turn* is running, which is
          true whether or not this worker is — and between two of its steps,
          or before its first, its rail would otherwise just stop. */}
      {active && (
        <div
          aria-label="Subagent working"
          className="flex items-center gap-2 px-1.5 py-0.5 text-[11px] leading-6 text-primary"
        >
          <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 animate-spin" />
          <span className="harness-shimmer">{rows.length === 0 ? "Starting…" : "Working…"}</span>
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
const ErrorRow = React.memo(function ErrorRow({
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
})
ErrorRow.displayName = "ErrorRow"

/* Memoized — the transcript's row discriminator, and the thing that makes
   memo work up the tree: `item` is referentially stable for everything the
   reducer did not touch, so a streaming chunk re-renders only the changed rows
   instead of all n. The `useViewOptionsContext` inside reads the same
   context value across a re-render storm, so it does not break memo. */
const THOUGHT_SNIPPET = 96

/** The line of a thought that stands for it in a folded row: the first while
    it is settled, the tail of the newest while it streams (see the `thought`
    case). Markdown marks are stripped — the row is one plain line. */
function thoughtPreview(reasoning: string, streaming: boolean): string {
  const lines = reasoning.split("\n").filter((line) => line.trim())
  if (lines.length === 0) return streaming ? "Thinking…" : "…"
  const line = (streaming ? lines[lines.length - 1] : lines[0]).replace(/[`*_~#>]/g, "").trim()
  if (!streaming || line.length <= THOUGHT_SNIPPET) return line
  return "…" + line.slice(-THOUGHT_SNIPPET).replace(/^\S*\s/, "")
}

export const ThreadItemView = React.memo(function ThreadItemView({
  item,
  onContinue,
  onRetry,
  onDismiss,
  showTimestamps = false,
  streaming = false,
}: {
  item: ThreadItem
  /** Present only on the transcript's last interrupt notice — see ThreadView. */
  onContinue?: () => void
  /** Present on an error row that knows the prompt it killed. */
  onRetry?: () => void
  onDismiss?: () => void
  showTimestamps?: boolean
  /** See RowView. */
  streaming?: boolean
}) {
  const view = useViewOptionsContext()
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
      /* The title is a snippet of the detail. Settled, it is the opening
         line — what the thought was about. Still streaming, it is the
         *newest* line's tail instead, so a folded row reads as a ticker of
         what the agent is thinking right now rather than freezing on the
         first words for a minute of silence; the whole item is rebuilt per
         chunk anyway (appendText replaces the tail item), so this costs no
         extra render. Clipped from the front because `truncate` cuts the
         end, and the end is the part that is new. */
      const preview = thoughtPreview(reasoning, streaming)

      return (
        <StepRow
          icon={KIND_ICONS.think}
          status={streaming ? "in_progress" : null}
          label={streaming ? "thinking" : undefined}
          startedAt={streaming ? item.at : undefined}
          mono={false}
          defaultOpen={view.showThinking}
          openSetting={view.showThinking}
          target={
            streaming ? (
              <span className="harness-shimmer text-primary">{preview}</span>
            ) : (
              preview
            )
          }
          detail={
            <Prose
              text={reasoning}
              className="text-xs leading-relaxed text-muted-foreground"
            />
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
    case "subagent":
      // An announced session with nothing filed under it yet — `buildRows`
      // wraps every one it sees, so this is the bare item reaching a row view
      // directly (a rail's own list). Same step, empty rail.
      return (
        <SubagentStep
          group={{ kind: "subagent-group", id: item.id, head: item, children: [] }}
          showTimestamps={showTimestamps}
        />
      )
  }
})
ThreadItemView.displayName = "ThreadItemView"

/** A context compaction, in the place in the transcript where it happened —
    the marker saying the history above it is no longer what the agent can see.
    A step row like any other, with the retained summary folded behind it: the
    summary is the only part anyone reads twice, and it can be long. */
const CompactionStep = React.memo(function CompactionStep({
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
      icon={FoldVerticalIcon}
      status={running ? "in_progress" : failed ? "failed" : null}
      mono={false}
      target={label}
      metric={showTimestamp && item.at !== undefined ? <Timestamp at={item.at} /> : undefined}
      detail={detail}
    />
  )
})
CompactionStep.displayName = "CompactionStep"

// ─── Per-kind layouts ────────────────────────────────────────────────────────




const ToolStep = React.memo(function ToolStep({
  item,
  showTimestamp,
}: {
  item: ToolItem;
  showTimestamp?: boolean;
}) {
  const active = item.status === "in_progress" || item.status === "pending"
  const kind = toolKindOf(item)
  const KindIcon = KIND_ICONS[kind] ?? WrenchIcon
  const view = useViewOptionsContext()
  /* Both of these are `tool-views`' to answer, not this row's: whether an
     expansion would hold anything, and whether it should start open, both
     depend on which layout the call resolved to — and a chevron that opens an
     empty box is worse than no chevron. "Expand tool output" overrides the
     second, so the body is there to read without a click. */
  const hasBody = toolHasDetail(item)
  /* What the agent said it was doing beats what it typed: a Bash call carries
     both, and the command truncates to nothing useful in a row this wide.
     A subagent's step drops the child's name its runtime may have prefixed —
     the rail it sits in is already headed by that name. */
  const heading = toolHeading(item.parentId ? { ...item, title: childToolTitle(item) } : item)

  return (
    <StepRow
      status={item.status}
      icon={KindIcon}
      target={heading.title}
      caption={heading.detail}
      file={heading.file}
      filePath={heading.filePath}
      mono={!heading.prose}
      /* No outcome here. The header line is the title and the command that
         produced it; churn counts and echoed output lines competed with both
         for the same strip of row, and a long one pushed the command it
         belonged to out of view. What happened is in the body — the diff, the
         output, the matches — where it is the thing being read rather than a
         teaser for it. `failed` still reaches the row, as the label. */
      metric={showTimestamp ? <Timestamp at={item.at} /> : undefined}
      startedAt={item.startedAt}
      detail={hasBody || active ? <ToolDetail item={item} active={active} /> : undefined}
      below={<ToolSources item={item} />}
      defaultOpen={view.showToolDetails || toolOpensByDefault(item)}
      openSetting={view.showToolDetails}
    />
  )
})
ToolStep.displayName = "ToolStep"


/**
 * The pages a turn's answer rests on, under the answer: what the agent read
 * and what it cited, as chips (see lib/sources for what counts). A search row
 * above lists everything the agent *saw*; this is the short list of what it
 * used, which is the one a reader wants to follow. Drawn only once the turn
 * has ended — mid-turn the list would grow under the reader's cursor.
 */
export const SourcesStrip = React.memo(function SourcesStrip({ turn }: { turn: TurnSources }) {
  if (turn.sources.length === 0) return null
  const consulted = [
    turn.searches > 0 && `${turn.searches} ${turn.searches === 1 ? "search" : "searches"}`,
    turn.fetches > 0 && `${turn.fetches} ${turn.fetches === 1 ? "page read" : "pages read"}`,
  ].filter(Boolean)
  return (
    <div className="mt-1 mb-2 flex min-w-0 flex-wrap items-center gap-1.5 pl-1">
      <span className="mr-0.5 text-[10px] font-semibold tracking-[0.08em] uppercase text-muted-foreground/50">
        Sources
      </span>
      {turn.sources.map((source) => (
        <SourceChip key={source.url} url={source.url} title={source.title} />
      ))}
      {consulted.length > 0 && (
        <span className="ml-auto text-[10px] text-muted-foreground/50">{consulted.join(" · ")}</span>
      )}
    </div>
  )
})
SourcesStrip.displayName = "SourcesStrip"

/** ACP's own plan entries, in the shape `TodoList` draws. The two vocabularies
    already agree on `content` and on all three statuses; this is the cast that
    says so. */
const toTodo = (entry: acp.PlanEntry): TodoEntry => ({
  content: entry.content,
  status: entry.status,
  priority: entry.priority,
})

const PlanStep = React.memo(function PlanStep({ item }: { item: PlanItem }) {
  /* A plan the agent wrote as prose, or parked in a file. Neither has entries,
     so there is no progress to count and nothing to tick off — the content IS
     the plan. Rendering it as an empty checklist (which is what happened before
     these two variants were handled) said the agent had planned nothing. */
  if (item.markdown !== undefined || item.uri !== undefined) {
    return (
      <StepRow
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
      icon={ListTodoIcon}
      status={current ? "in_progress" : next ? null : "completed"}
      mono={false}
      target={next?.content ?? "all steps complete"}
      metric={`${done}/${item.entries.length}`}
      /* The same drawing a `TodoWrite` gets. Codex sends its checklist down
         ACP's plan channel and Claude Code and OpenCode send theirs as tool
         input, and a reader should not be able to tell which — where the list
         was read from is `lib/tools`' problem, not a difference in how a
         checklist looks. */
      detail={<TodoList todos={item.entries.map(toTodo)} />}
    />
  )
})
PlanStep.displayName = "PlanStep"
