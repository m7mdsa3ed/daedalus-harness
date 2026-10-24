/* ── What a folded thing says about itself ── the sentence and the avatar
   stack that stand for a collapsed run, and the one line that stands for a
   folded thought. None of it recurses back into the row tree, so it lives
   apart from the mutually recursive cluster in `rows.tsx`, which imports from
   here — never the reverse. */
import * as React from "react"
import { BrainIcon, WrenchIcon } from "lucide-react"
import { AvatarGroup } from "@/components/ui/avatar"
import { McpIcon } from "@/components/entity-icon"
import { KIND_CHIPS, KIND_COLORS, KIND_ICONS, mcpTint } from "@/components/tool-parts"
import { useMcpServers } from "@/lib/queries/catalog"
import {
  extractMcpCall,
  mcpServerKey,
  mcpServerLabel,
  toolKindOf,
  toolViewOf,
  webInput,
} from "@/lib/tools"
import type { McpCall } from "@/lib/tools"
import { cn } from "@/lib/utils"
import type { RunItem } from "@/lib/transcript-rows"
import type { ToolItem } from "@/lib/store"

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

/** A call into an MCP server, when that is the layout it resolved to — the same
    test `runKeyOf` makes, so a fold's runs and its sentence never disagree about
    what a call is. The web's servers are not integrations here: a `web_search`
    is a search, whichever server answered it. */
const mcpOf = (item: ToolItem): McpCall | null =>
  toolViewOf(item) === "mcp" ? extractMcpCall(item) : null

/** What the run actually did: "reading 10 files, running 28 shell commands", in the
    order the groups first appeared. */
export function summarise(items: ToolItem[]): { verb: string; noun: string; count: number }[] {
  const groups = new Map<string, { verb: string; noun: string; count: number }>()
  for (const item of items) {
    /* An MCP call is counted by the integration that took it — "Clickup 4
       calls · Bugsnag 6 calls" — because that is the fact a reader of a mixed
       stretch is counting, and `kind` files every one of them under `other`,
       which said "Running 30 tools" about four integrations' work. */
    const mcp = mcpOf(item)
    // toolKindOf, not the raw field: a run of Bash calls from an agent that
    // omits `kind` should still summarise as "running 3 shell commands", not "3 tools".
    // The web's two acts are named apart from the `fetch` kind they share:
    // "searching the web 3 times, reading 2 pages" says what a run of
    // globe-icon rows did; "fetching 5 fetches" did not.
    const web = webInput(item)
    const key = mcp
      ? `mcp:${mcpServerKey(mcp.server)}`
      : web?.query
        ? "websearch"
        : web?.url
          ? "webfetch"
          : toolKindOf(item)
    const group =
      groups.get(key) ??
      (mcp
        ? { verb: mcpServerLabel(mcp.server), noun: "call", count: 0 }
        : {
            verb: KIND_VERBS[key] ?? KIND_VERBS.other,
            noun: KIND_NOUNS[key] ?? KIND_NOUNS.other,
            count: 0,
          })
    group.count += 1
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** What the source strip does for pages, this does for calls: one small mark
    per tool in arrival order, overlapped like avatars, with overflow folded
    into a count. The tool's kind and tint match its step row. */
const RUN_AVATARS = 6

/** One circular mark per call, in arrival order, like the web source stack —
    except an MCP call, which wears its *integration's* mark and appears once per
    server however many calls went to it. Four BugSnag calls and two GitHub ones
    were six identical wrenches; the question a folded run raises is which
    integrations it talked to, and one logo each answers it. Remaining marks
    collapse into a `+N` avatar. */
export function RunAvatarStack({ items, single }: { items: RunItem[]; single?: boolean }) {
  const servers = useMcpServers()
  /* One mark per call: a run holds calls and setting changes, and a setting
     change is a rule in the list rather than an act to draw a mark for. */
  const marks: { key: string; title: string; disc: string; node: React.ReactNode }[] = []
  const integrations = new Set<string>()
  for (const item of items) {
    if (item.kind !== "tool") continue
    const mcp = mcpOf(item)
    if (mcp) {
      const key = mcpServerKey(mcp.server)
      if (integrations.has(key)) continue
      integrations.add(key)
      const server = servers.find((entry) => mcpServerKey(entry.name) === key) ?? null
      /* The wash is the integration's own colour (`mcpTint`), which is what
         tells two servers apart in a stack this small — the logos are 12px and
         their art is often monochrome. It rides the inner circle, not the disc:
         the discs overlap, so the disc itself has to stay opaque. */
      marks.push({
        key: `mcp:${key}`,
        title: mcpServerLabel(mcp.server),
        disc: "bg-background ring-1 ring-background group-hover/fold:bg-muted group-hover/fold:ring-muted",
        node: (
          <span
            className={cn(
              "grid size-full place-items-center rounded-full",
              mcpTint(mcp.server).wash
            )}
          >
            <McpIcon server={server} catalog={false} className="size-3" />
          </span>
        ),
      })
      continue
    }
    const kind = toolKindOf(item)
    const webSearch = toolViewOf(item) === "websearch"
    const colorKind = webSearch ? "search" : kind
    const Icon = KIND_ICONS[kind] ?? WrenchIcon
    marks.push({
      key: item.id,
      title: item.title,
      disc: "bg-background ring-1 ring-background group-hover/fold:bg-muted group-hover/fold:ring-muted",
      node: (
        <span
          className={cn(
            "grid size-full place-items-center rounded-full",
            KIND_CHIPS[colorKind] ?? KIND_CHIPS.other,
            KIND_COLORS[colorKind] ?? KIND_COLORS.other
          )}
        >
          <Icon className="size-3" />
        </span>
      ),
    })
  }
  /* `single`: a header drawn inside another run's rail sits in the same title
     column as the one-mark step rows beside it, so it wears one mark (its
     first call's) and its sentence says the rest; a stack would push its title
     off that column. */
  const shown = marks.slice(0, single ? 1 : RUN_AVATARS)
  const hidden = single ? 0 : marks.length - shown.length
  if (shown.length === 0) return null
  return (
    /* No "N tools" beside it: the summary the header draws next already
       counts the run, group by group. */
    <div aria-hidden className="flex min-w-0 items-center">
      <AvatarGroup className="-space-x-1.5">
        {shown.map((mark, index) => (
          /* The tints are translucent, so each mark stands on an opaque disc of
             the page's ground — an overlapped neighbour must not show through. */
          <span
            key={`${mark.key}-${index}`}
            title={mark.title}
            className={cn(
              "relative grid size-5 shrink-0 place-items-center rounded-full transition-colors duration-150",
              mark.disc
            )}
          >
            {mark.node}
          </span>
        ))}
        {hidden > 0 && (
          <span className="relative flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-medium text-foreground ring-1 ring-background transition-colors duration-150 group-hover/fold:bg-background group-hover/fold:ring-muted">
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
