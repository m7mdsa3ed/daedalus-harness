/* ── What a folded thing says about itself ── the sentence and the avatar
   stack that stand for a collapsed run, and the one line that stands for a
   folded thought. None of it recurses back into the row tree, so it lives
   apart from the mutually recursive cluster in `rows.tsx`, which imports from
   here — never the reverse. */
import * as React from "react"
import { BrainIcon, WrenchIcon } from "lucide-react"
import { AvatarGroup } from "@/components/ui/avatar"
import { KIND_CHIPS, KIND_COLORS, KIND_ICONS } from "@/components/tool-parts"
import { toolKindOf, toolViewOf, webInput } from "@/lib/tools"
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

/** What the source strip does for pages, this does for calls: one small mark
    per tool in arrival order, overlapped like avatars, with overflow folded
    into a count. The tool's kind and tint match its step row. */
const RUN_AVATARS = 6

/** One circular tool mark per call, in arrival order, like the web source
    stack. Remaining calls collapse into a `+N` avatar. */
export function RunAvatarStack({ items }: { items: Array<ToolItem | TextItem> }) {
  const marks = items.flatMap((item) => {
    if (item.kind === "tool") {
      const kind = toolKindOf(item)
      const webSearch = toolViewOf(item) === "websearch"
      return [{ id: item.id, title: item.title, kind, colorKind: webSearch ? "search" : kind }]
    }
    if (item.kind === "thought") return [{ id: item.id, title: "Thinking", kind: "think", colorKind: "think" }]
    return []
  })
  const shown = marks.slice(0, RUN_AVATARS)
  const hidden = marks.length - shown.length
  if (shown.length === 0) return null
  return (
    /* No "N tools" beside it: the summary the header draws next already
       counts the run, kind by kind. */
    <div aria-hidden className="flex min-w-0 items-center">
      <AvatarGroup className="-space-x-1.5">
        {shown.map((item, index) => {
          const Icon = KIND_ICONS[item.kind] ?? WrenchIcon
          return (
            /* The kind tints are translucent, so each mark stands on an opaque
               disc of the page's ground — an overlapped neighbour must not
               show through. */
            <span
              key={`${item.id}-${index}`}
              title={item.title}
              className="relative size-5 shrink-0 rounded-full bg-background ring-1 ring-background transition-colors duration-150 group-hover/fold:bg-muted group-hover/fold:ring-muted"
            >
              <span
                className={cn(
                  "grid size-full place-items-center rounded-full",
                  KIND_CHIPS[item.colorKind] ?? KIND_CHIPS.other,
                  KIND_COLORS[item.colorKind] ?? KIND_COLORS.other
                )}
              >
                <Icon className="size-3" />
              </span>
            </span>
          )
        })}
        {hidden > 0 && (
          <span className="relative flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground ring-1 ring-background transition-colors duration-150 group-hover/fold:bg-background group-hover/fold:ring-muted">
            +{hidden}
          </span>
        )}
      </AvatarGroup>
    </div>
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
          {i > 0 && <span className="text-muted-foreground">{" · "}</span>}
          {verb.charAt(0).toUpperCase() + verb.slice(1)}{" "}
          <span className="text-foreground">{count}</span> {pluralNoun(noun, count)}
        </React.Fragment>
      ))}
    </>
  )
}
