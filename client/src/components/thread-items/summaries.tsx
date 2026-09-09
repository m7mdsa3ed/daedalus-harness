/* ── What a folded thing says about itself ── the sentence and the avatar
   stack that stand for a collapsed run, and the one line that stands for a
   folded thought. None of it recurses back into the row tree, so it lives
   apart from the mutually recursive cluster in `rows.tsx`, which imports from
   here — never the reverse. */
import * as React from "react"
import { BrainIcon, SquareTerminalIcon, WrenchIcon } from "lucide-react"
import { toolKindOf, webInput } from "@/lib/tools"
import { cn } from "@/lib/utils"
import type { TextItem, ToolItem } from "@/lib/store"

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

export const pluralNoun = (noun: string, count: number) =>
  count === 1 ? noun : (KIND_NOUNS_PLURAL[noun] ?? `${noun}s`)

/** What the run actually did: "reading 10 files, running 28 shell commands", in the
    order the kinds first appeared. */
export function summarise(items: ToolItem[]): { verb: string; noun: string; count: number }[] {
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

/** The three acts a folded run can hold, as the avatar stack below draws them:
    shell commands, thoughts, and everything else a tool call does. Each avatar
    is one act that is in the run, not one call — "12 reads" is one wrench, the
    way a people stack is one face per person rather than a face per message.
    Each carries the app's accent for that act — a thought is the same blue a
    thinking step row shimmers with, a failed shell command the same red the
    row would claim — so a glance at the stack reads the run's shape. */
const RUN_BUCKETS = {
  command: {
    icon: SquareTerminalIcon,
    noun: "shell command",
    className: "text-step-command",
    chip: "bg-step-command/25",
  },
  thought: {
    icon: BrainIcon,
    noun: "thought",
    className: "text-step-think",
    chip: "bg-step-think/25",
  },
  tool: {
    icon: WrenchIcon,
    noun: "tool",
    className: "text-step-tool",
    chip: "bg-step-tool/25",
  },
} as const
type RunBucket = keyof typeof RUN_BUCKETS

function bucketOf(item: ToolItem | TextItem): RunBucket {
  if (item.kind === "thought") return "thought"
  if (item.kind === "tool") {
    /* A `think` call is a thought in this vocabulary everywhere else — the
       summary line counts it as "thinking N thoughts" — so it stacks with the
       thoughts rather than with the tools. */
    if (toolKindOf(item) === "think") return "thought"
    if (toolKindOf(item) === "execute") return "command"
  }
  return "tool"
}

/** What a folded run contains, as a stack of overlapping marks: one avatar per
    act present — commands, thoughts, tools — in the order they first happened,
    each telling its count on hover. The at-a-glance reading of the run; the
    sentence next to it is the same fact in words ("running 8 shell commands"). */
export function RunAvatarStack({ items }: { items: Array<ToolItem | TextItem> }) {
  const slots = React.useMemo(() => {
    const order: RunBucket[] = []
    const counts = new Map<RunBucket, number>()
    for (const item of items) {
      const bucket = bucketOf(item)
      if (!counts.has(bucket)) order.push(bucket)
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
    }
    return order.map((bucket) => ({ bucket, count: counts.get(bucket)! }))
  }, [items])
  if (slots.length === 0) return null
  return (
    /* Decorative on purpose: the sentence beside it says the same thing for a
       screen reader, so the marks are not read twice. Hover still tells each
       count, because the sentence groups by kind only for the tools. */
    <span aria-hidden className="flex shrink-0 items-center -space-x-1.5">
      {slots.map(({ bucket, count }) => {
        const { icon: Icon, noun, className, chip } = RUN_BUCKETS[bucket]
        return (
          <span
            key={bucket}
            title={`${count} ${count === 1 ? noun : `${noun}s`}`}
            className={cn(
              "grid size-4 shrink-0 place-items-center rounded-full ring-2 ring-background",
              chip,
              className
            )}
          >
            <Icon className="size-2.5" />
          </span>
        )
      })}
    </span>
  )
}

/** The group's title as a sentence: "Reading 10 files · Running 28 shell
    commands". The verbs stay in the row's muted voice and the counts take the
    foreground, so a scanned transcript reads the numbers first; the segments
    join on dots rather than commas, which keeps several kinds reading as one
    title instead of a run-on list. Drawn as markup rather than the plain
    string the metric column builds (SubagentStep), because the emphasis is
    per-word — a sentence-cased string could not carry it. */
export function RunSummary({ summary }: { summary: ReturnType<typeof summarise> }) {
  return (
    <>
      {summary.map(({ verb, noun, count }, i) => (
        <React.Fragment key={`${verb}:${noun}`}>
          {i > 0 && <span className="text-muted-foreground/40">{" · "}</span>}
          {verb.charAt(0).toUpperCase() + verb.slice(1)}{" "}
          <span className="text-foreground/80">{count}</span> {pluralNoun(noun, count)}
        </React.Fragment>
      ))}
    </>
  )
}

const THOUGHT_SNIPPET = 96

/** The line of a thought that stands for it in a folded row: the first while
    it is settled, the tail of the newest while it streams (see the `thought`
    case). Markdown marks are stripped — the row is one plain line. */
export function thoughtPreview(reasoning: string, streaming: boolean): string {
  const lines = reasoning.split("\n").filter((line) => line.trim())
  if (lines.length === 0) return streaming ? "Thinking…" : "…"
  const line = (streaming ? lines[lines.length - 1] : lines[0]).replace(/[`*_~#>]/g, "").trim()
  if (!streaming || line.length <= THOUGHT_SNIPPET) return line
  return "…" + line.slice(-THOUGHT_SNIPPET).replace(/^\S*\s/, "")
}
