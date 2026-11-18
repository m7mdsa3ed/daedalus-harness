/* ── Trace ──
   What a thread's model calls cost, where the tokens went and where the time
   went, from whichever door its runtime has (docs/protocol.md "Model calls").
   Laid out as three bands:

   - **The bill** — the thread's total with its cache ring, a strip of figures,
     and input beside output in full (the reading kit's face, the one a turn's
     and a step's popovers wear).
   - **Every call** — one column per request, its height the prompt and its
     stack the cache, so the call that lost the cache is the one you can see.
     A click opens it in the timeline.
   - **Tabs** — *Timeline*: turns, newest first, each call a row with a
     waterfall against its turn and the pauses between calls as their own
     lines; a row's fold is that call's bill, timing, prompt and prefix.
     *Prompt*: where the prompt went, summed. *Tools*: every tool and MCP
     server the thread carried or called.

   Nothing here branches on the runtime: `source` and `missing` are drawn in
   the door's own words (`lib/trace.ts`), and a part a door could not see is
   hatched, never drawn as a smaller prompt. */
import * as React from "react"
import { BotIcon, ChevronRightIcon, CpuIcon, WrenchIcon } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty } from "@/components/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { McpIcon } from "@/components/entity-icon"
import { mcpTint } from "@/components/tool-parts"
import { Count, SectionHead, Segmented } from "@/components/settings/primitives"
import type { PrefixItem, PromptParts } from "@daedalus/protocol"
import { useMcpServers } from "@/lib/queries/catalog"
import { useThreadCalls } from "@/lib/queries/model-calls"
import { useFeature } from "@/lib/queries/surfaces"
import { inlineFromQuery } from "@/lib/errors"
import { ErrorNote } from "@/components/error-note"
import type { SessionMeta } from "@/lib/settings"
import type { ThreadItem, ThreadState } from "@/lib/store"
import { formatDuration, formatTokens, formatTps } from "@/lib/tokens"
import { stepRate } from "@daedalus/tps"
import { formatMcpName, mcpServerKey, mcpServerLabel } from "@/lib/tools"
import {
  DOOR_WORDS,
  PART_KEYS,
  anchorItems,
  billedOf,
  cacheDrops,
  cachePercent,
  calledCounts,
  costOf,
  gapsOf,
  itemsAt,
  laneOf,
  mcpOfName,
  mergeCalls,
  missingWords,
  rowsFromStepUsage,
  serverStats,
  sumBilled,
  sumParts,
  toolStats,
  usageOfCalls,
  type CacheDrop,
  type Gap,
  type GapReason,
  type SilenceWhere,
  type PartKey,
  type ServerStat,
  type ThreadCall,
  type ToolStat,
} from "@/lib/trace"
import { stepLeadOf } from "@/lib/tools"
import { cn } from "@/lib/utils"
import {
  Facts,
  HATCH,
  PART_COLOR,
  PART_LABEL,
  ReadingHero,
  ReadingTabs,
  TokenBreakdown,
  cacheTone,
  formatMs,
  sumSplits,
} from "@/components/reading-kit"

const PART_SHORT: Record<PartKey, string> = {
  system: "System",
  tools: "Tools",
  mcp: "MCP",
  user: "User",
  assistant: "Assistant",
  results: "Results",
}
const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "0%")
const approx = (n: number) => `~${formatTokens(n)}`

type View = "calls" | "prompt" | "tools"

/* ── shared pieces ── */

/** The prompt as one bar: each seen part as a slice of the billed total, the
    unseen share hatched. Every figure is ~ — local counts anchored to the bill. */
function PromptBar({ parts, total, className }: { parts: PromptParts | undefined | null; total: number; className?: string }) {
  if (!parts || total <= 0) return <div className={cn("h-1.5 w-full rounded-full bg-muted", className)} style={HATCH} aria-hidden />
  const title = PART_KEYS.map((key) => `${PART_SHORT[key]}: ${parts[key] === null ? "n/a" : approx(parts[key]!)}`).join(" · ")
  return (
    <div className={cn("flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted", className)} title={title}>
      {PART_KEYS.map((key) =>
        parts[key] ? (
          <div
            key={key}
            className="h-full origin-left animate-in fade-in duration-500"
            style={{ width: `${(parts[key]! / total) * 100}%`, background: PART_COLOR[key] }}
          />
        ) : null
      )}
      {parts.unknown > 0 && <div className="h-full" style={{ width: `${(parts.unknown / total) * 100}%`, ...HATCH }} />}
    </div>
  )
}

/** The bar's legend as rows: swatch, name, ~tokens, share. A part the door
    could not see says so instead of a zero. */
function PartsLegend({ parts, total }: { parts: PromptParts; total: number }) {
  const rows = [
    ...PART_KEYS.map((key) => ({ key, label: PART_LABEL[key], value: parts[key], style: parts[key] === null ? HATCH : { background: PART_COLOR[key] } })),
    ...(parts.unknown > 0 ? [{ key: "unknown", label: "Not seen", value: parts.unknown as number | null, style: HATCH }] : []),
  ]
  return (
    <dl className="grid gap-x-6 gap-y-1.5 text-xs @panel-sm:grid-cols-2">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <span aria-hidden className="size-2.5 shrink-0 rounded-[3px]" style={row.style} />
          <dt className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</dt>
          <dd className="tabular-nums">{row.value === null ? <span className="text-muted-foreground">not visible</span> : approx(row.value)}</dd>
          <dd className="w-9 shrink-0 text-end tabular-nums text-muted-foreground">{row.value === null ? "" : pct(row.value, total)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A ranked list of named token figures with a share bar each — the one shape
    for "what is the big one", whether sections, definitions or servers. */
function RankList({
  rows,
  total,
  limit = 6,
  color = "var(--foreground)",
  format = approx,
}: {
  rows: { key: string; label: React.ReactNode; title?: string; tokens: number; mark?: React.ReactNode }[]
  total: number
  limit?: number
  color?: string
  /** How a row's figure is worded; tokens by default. */
  format?: (n: number) => string
}) {
  const [all, setAll] = React.useState(false)
  if (rows.length === 0) return null
  const shown = all ? rows : rows.slice(0, limit)
  const max = Math.max(...rows.map((r) => r.tokens), 1)
  /* Sized on its own box: a rank list sits in a card, a fold or a third of a
     row, and the panel's width says nothing about which. Narrow, the bar goes
     under the name rather than squeezing it to nothing. */
  return (
    <div className="@container/rank min-w-0">
      <ul className="space-y-2 text-xs @xs/rank:space-y-1.5">
        {shown.map((row) => (
          <li
            key={row.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 @xs/rank:grid-cols-[minmax(0,1fr)_5rem_3.25rem] @md/rank:grid-cols-[minmax(0,1fr)_8rem_3.5rem_2.5rem]"
          >
            <span className="flex min-w-0 items-center gap-1.5" title={row.title}>
              {row.mark}
              <span className="truncate">{row.label}</span>
            </span>
            <span className="order-last col-span-2 block h-1.5 overflow-hidden rounded-full bg-muted @xs/rank:order-none @xs/rank:col-span-1">
              <span
                className="block h-full rounded-full opacity-70 transition-[width] duration-500"
                style={{ width: `${(row.tokens / max) * 100}%`, background: color }}
              />
            </span>
            <span className="text-end tabular-nums">{format(row.tokens)}</span>
            <span className="hidden text-end tabular-nums text-muted-foreground @md/rank:block">{pct(row.tokens, total)}</span>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="mt-2 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {all ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  )
}

/** A card holding one block of the overview. */
function Block({ title, hint, children, className }: { title: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10", className)}>
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
      </header>
      {children}
    </section>
  )
}

/** An MCP server's face: its own mark on its tint, or a wrench for built-ins. */
function ServerMark({ server, className }: { server: string | null; className?: string }) {
  const servers = useMcpServers()
  if (server === null)
    return (
      <span className={cn("grid size-5 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground", className)}>
        <WrenchIcon className="size-3" />
      </span>
    )
  const def = servers.find((entry) => mcpServerKey(entry.name) === mcpServerKey(server)) ?? null
  return (
    <span className={cn("grid size-5 shrink-0 place-items-center rounded-md", mcpTint(server).wash, className)}>
      <McpIcon server={def} catalog={false} className="size-3" />
    </span>
  )
}

/** A tool name as people read it: `Search` for an MCP tool (its server says
    where), the identifier for a built-in. */
function toolLabel(name: string): string {
  const mcp = mcpOfName(name)
  return mcp ? formatMcpName(mcp.tool || "guidance") : name
}
const serverLabel = (server: string | null) => (server === null ? "Built-in tools" : mcpServerLabel(server))

/** The tools one response asked to run, as chips — MCP ones in their server's tint. */
function CalledChips({ call, max = 3 }: { call: ThreadCall; max?: number }) {
  const counts = calledCounts(call)
  if (counts.length === 0) return null
  const shown = counts.slice(0, max)
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {shown.map(([name, n]) => {
        const mcp = mcpOfName(name)
        return (
          <span
            key={name}
            title={name}
            className={cn(
              "inline-flex max-w-full items-center gap-1 truncate rounded-md @panel-sm:max-w-40 px-1.5 py-0.5 font-mono text-[11px] leading-none",
              mcp ? cn(mcpTint(mcp.server).wash, mcpTint(mcp.server).accent) : "bg-muted text-foreground/80"
            )}
          >
            <span className="truncate">{mcp ? `${mcpServerLabel(mcp.server)} · ${toolLabel(name)}` : name}</span>
            {n > 1 && <span className="opacity-70">×{n}</span>}
          </span>
        )
      })}
      {counts.length > max && <span className="text-[11px] text-muted-foreground">+{counts.length - max}</span>}
    </span>
  )
}

/* ── Overview ── */

function Overview({ calls, onTools }: { calls: ThreadCall[]; onTools: () => void }) {
  const billed = sumBilled(calls)
  const parts = sumParts(calls)
  const tools = React.useMemo(() => toolStats(calls), [calls])
  const servers = React.useMemo(() => serverStats(tools), [tools])
  /* The prefix as the newest split call carried it, in billed tokens. */
  const prefix = React.useMemo(() => {
    let index = -1
    for (let i = calls.length - 1; i >= 0 && index < 0; i--) if (calls[i].prompt) index = i
    if (index < 0) return null
    const items = itemsAt(calls, index)
    const prompt = calls[index].prompt!
    return items ? { system: anchorItems(items.system, prompt.system), total: billedOf(calls[index].billed).prompt } : null
  }, [calls])
  const called = tools.filter((t) => t.called > 0).sort((a, b) => b.called - a.called)
  const totalCalled = called.reduce((n, t) => n + t.called, 0)
  const toolWeight = (t: { args: number; results: number; schema: number | null }) => t.args + t.results + (t.schema ?? 0)
  const lastPrompt = calls.length ? billedOf(calls.at(-1)!.billed).prompt : 0

  return (
    <div className="space-y-4">
      {parts && (
        <Block title="Where the prompt went" hint="Summed over every call · ~ counted locally, anchored to the bill">
          <PromptBar parts={parts} total={billed.prompt} className="mb-4 h-3" />
          <PartsLegend parts={parts} total={billed.prompt} />
        </Block>
      )}
      <div className="grid gap-4 @panel-md:grid-cols-2">
        {servers.length > 0 && (
          <Block
            title="Tools & MCP servers"
            hint={
              <button type="button" onClick={onTools} className="hover:text-foreground hover:underline">
                Details
              </button>
            }
          >
            <RankList
              total={lastPrompt}
              color="var(--chart-3)"
              rows={servers
                .filter((g) => toolWeight(g) > 0)
                .map((g) => ({ key: g.server ?? "builtin", label: serverLabel(g.server), tokens: toolWeight(g), mark: <ServerMark server={g.server} className="size-4 rounded" /> }))}
            />
            <p className="mt-3 text-xs text-muted-foreground">Definitions plus calls and results, in the newest call's prompt.</p>
          </Block>
        )}
        {called.length > 0 && (
          <Block title="Most called" hint={`${totalCalled} tool call${totalCalled === 1 ? "" : "s"}`}>
            <ul className="space-y-1.5 text-xs">
              {called.slice(0, 6).map((t) => (
                <li key={t.name} className="flex items-center gap-2" title={t.name}>
                  <ServerMark server={t.server} className="size-4 rounded" />
                  <span className="min-w-0 flex-1 truncate">
                    {t.server && <span className="text-muted-foreground">{mcpServerLabel(t.server)} · </span>}
                    {toolLabel(t.name)}
                  </span>
                  <span className="tabular-nums">×{t.called}</span>
                </li>
              ))}
            </ul>
          </Block>
        )}
        {prefix && prefix.system.length > 0 && (
          <Block title="System prompt" hint="Newest call, biggest sections">
            <RankList total={prefix.total} color="var(--chart-1)" rows={prefix.system.map((i) => ({ key: i.name, label: i.name, title: i.name, tokens: i.tokens }))} />
          </Block>
        )}
      </div>
    </div>
  )
}

/* ── Tools ── */

function ToolRow({ tool }: { tool: ToolStat }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-2 text-xs @panel-sm:grid-cols-[minmax(0,1fr)_3rem_4.5rem_4.5rem_4.5rem]">
      <span className="min-w-0 truncate font-mono" title={tool.name}>
        {tool.server ? toolLabel(tool.name) : tool.name}
      </span>
      <span className="text-end tabular-nums @panel-sm:text-end">{tool.called > 0 ? `×${tool.called}` : <span className="text-muted-foreground">—</span>}</span>
      <Figure label="Def" value={tool.schema} />
      <Figure label="Calls" value={tool.args || null} />
      <Figure label="Results" value={tool.results || null} />
    </li>
  )
}

/** One figure, labelled inline on a narrow panel (where the header row is hidden). */
function Figure({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="col-span-2 flex justify-between tabular-nums @panel-sm:col-span-1 @panel-sm:block @panel-sm:text-end">
      <span className="text-muted-foreground @panel-sm:hidden">{label}</span>
      {value === null ? <span className="text-muted-foreground">—</span> : approx(value)}
    </span>
  )
}

function ServerGroup({ group, total, defaultOpen }: { group: ServerStat; total: number; defaultOpen: boolean }) {
  const weight = group.args + group.results + (group.schema ?? 0)
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-2xl bg-card text-card-foreground ring-1 ring-foreground/10">
      <CollapsibleTrigger className="group/trigger flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-start outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50">
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]/trigger:rotate-90" />
        <ServerMark server={group.server} className="size-6 rounded-lg" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{serverLabel(group.server)}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {group.tools.length} tool{group.tools.length === 1 ? "" : "s"}
            {group.called > 0 && ` · called ${group.called}×`}
          </span>
        </span>
        <span className="text-end">
          <span className="block text-sm tabular-nums">{approx(weight)}</span>
          <span className="block text-xs tabular-nums text-muted-foreground">{pct(weight, total)} of prompt</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-4 pb-1">
        <div className="hidden grid-cols-[minmax(0,1fr)_3rem_4.5rem_4.5rem_4.5rem] gap-x-3 pt-2 text-[11px] font-medium text-muted-foreground @panel-sm:grid">
          <span>Tool</span>
          <span className="text-end">Called</span>
          <span className="text-end" title="What its definition costs on every call">Definition</span>
          <span className="text-end" title="Its calls' arguments in the history">Calls</span>
          <span className="text-end" title="Its results in the history">Results</span>
        </div>
        <ul className="divide-y">
          {group.tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} />
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolsView({ calls }: { calls: ThreadCall[] }) {
  const tools = React.useMemo(() => toolStats(calls), [calls])
  const servers = React.useMemo(() => serverStats(tools), [tools])
  const [filter, setFilter] = React.useState<"all" | "used">("all")
  if (tools.length === 0)
    return (
      <Empty>
        No tool data in these calls. It is recorded where the door sees the request or the reply — the agent itself, the gateway, or a
        runtime's session files.
      </Empty>
    )
  const lastPrompt = billedOf(calls.at(-1)!.billed).prompt
  const shown = servers
    .map((g) => (filter === "used" ? { ...g, tools: g.tools.filter((t) => t.called > 0 || t.inHistory > 0) } : g))
    .filter((g) => g.tools.length > 0)
  const mcp = servers.filter((g) => g.server !== null)
  const schema = servers.reduce((n, g) => n + (g.schema ?? 0), 0)
  const history = servers.reduce((n, g) => n + g.args + g.results, 0)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <MiniStat label="MCP servers" value={String(mcp.length)} />
        <MiniStat label="Definitions" value={approx(schema)} hint="every call" />
        <MiniStat label="Calls + results" value={approx(history)} hint="in history" />
      </div>
      <div className="flex items-center justify-between gap-3">
        <SectionHead label="By server" count={servers.length} />
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "used", label: "Used" },
          ]}
        />
      </div>
      <div className="space-y-2">
        {shown.map((group, i) => (
          <ServerGroup key={group.server ?? "builtin"} group={group} total={lastPrompt} defaultOpen={i === 0} />
        ))}
      </div>
      <p className="px-1 text-xs text-muted-foreground">
        ~ Figures are billed tokens in the newest call's prompt. A tool's definition is paid on every call; its calls and results ride
        the history until compaction drops them.
      </p>
    </div>
  )
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-muted/50 px-3 py-2">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-base font-semibold tabular-nums">{value}</p>
      {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

/* ── Calls ── */

/* ── The time between calls ── */

const GAP_KIND: Record<GapReason["kind"], string> = {
  tool: "Ran tool",
  permission: "Waited for your answer on",
  subagent: "Subagent",
  compaction: "Compacted",
  idle: "Idle",
  paused: "Paused:",
  retry: "Retry:",
}

/** Where time with no recorded cause fell, in words a reader can act on. */
const SILENCE_WORDS: Record<SilenceWhere, { label: string; title: string }> = {
  quiet: {
    label: "Nothing ran",
    title: "No tool, subagent or wait was recorded in this time: the provider queueing the request, the network, or the harness stalled",
  },
  "before-tools": {
    label: "Before the tools started",
    title: "After the response ended and before its first tool began: the harness dispatching the call, or a tool slow to start",
  },
  "between-tools": {
    label: "Between tools",
    title: "While tools were running one after another: the harness or a tool's own startup between them",
  },
  "after-tools": {
    label: "After the last tool",
    title: "After the last tool settled and before the next request: the harness preparing the step, or the provider queueing it",
  },
}

const gapLabel = (r: GapReason) => (r.kind === "idle" ? r.label : `${GAP_KIND[r.kind]} ${r.label}`)

/** Only a pause worth a second look is drawn: under 1s is the loop turning over. */
const GAP_MIN_MS = 1000

/** Where the silence before this call went, each cause as a share of it. */
function GapDetail({ gap }: { gap: Gap }) {
  if (gap.ms < GAP_MIN_MS) return null
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted-foreground">
        {formatDuration(gap.ms)} since the previous response
      </p>
      <RankList
        total={gap.ms}
        color="var(--chart-4)"
        rows={[
          ...gap.reasons.map((r) => ({
            key: `${r.kind}:${r.label}`,
            title: `${gapLabel(r)}: ${formatDuration(r.ms)}`,
            label: gapLabel(r),
            tokens: r.ms,
          })),
          ...gap.silences
            .filter((x) => x.ms >= GAP_MIN_MS)
            .map((x) => ({
              key: `silence:${x.where}`,
              title: SILENCE_WORDS[x.where].title,
              label: `No cause recorded - ${SILENCE_WORDS[x.where].label.toLowerCase()}`,
              tokens: x.ms,
            })),
        ]}
        format={(ms) => formatDuration(ms)}
      />
    </div>
  )
}


/** A call's fold: why it waited, its bill in full, its timing, where its prompt
    went, the tools it asked for and the prefix it carried. */
function CallDetail({ call, calls, gap }: { call: ThreadCall; calls: ThreadCall[]; gap: Gap | undefined }) {
  const index = calls.indexOf(call)
  const items = itemsAt(calls, index)
  const b = billedOf(call.billed)
  const rate = stepRate(call)
  const anchored = (list: PrefixItem[], part: number | null) =>
    anchorItems(list, part).map((i) => ({ key: i.name, label: i.name, title: i.name, tokens: i.tokens }))
  /* Its own container: how much room it has is the fold's width, not the panel's. */
  return (
    <div className="@container/detail min-w-0 space-y-4 py-3">
      <Facts
        items={[
          call.timing?.ttftMs !== undefined && { label: "First token", value: formatMs(call.timing.ttftMs) },
          call.timing?.decodeMs !== undefined && { label: "Writing", value: formatMs(call.timing.decodeMs) },
          call.ms !== undefined && { label: "Request", value: formatMs(call.ms) },
          rate !== null && { label: "Speed", value: formatTps(rate) ?? "—" },
          call.costUsd !== undefined && { label: "Cost", value: `$${call.costUsd.toFixed(4)}` },
        ]}
      />
      <TokenBreakdown usage={call.billed} split={call.output} />
      {gap && <GapDetail gap={gap} />}
      {call.prompt ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground">Where the prompt went</p>
          <PromptBar parts={call.prompt} total={b.prompt} className="h-2" />
          <PartsLegend parts={call.prompt} total={b.prompt} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No prompt split for this call — the bill only.</p>
      )}
      {call.missing && call.missing.length > 0 && <p className="text-xs text-muted-foreground">Not visible to this door: {call.missing.join(", ")}.</p>}
      {call.called && call.called.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Asked to run</p>
          <CalledChips call={call} max={12} />
        </div>
      )}
      {call.toolUse && call.toolUse.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Tool calls and results in this prompt</p>
          <RankList
            total={b.prompt}
            color="var(--primary)"
            rows={call.toolUse.map((t) => {
              const mcp = mcpOfName(t.name)
              return {
                key: t.name,
                title: `${t.name}: ${t.calls} call${t.calls === 1 ? "" : "s"}, ~${formatTokens(t.args)} args, ~${formatTokens(t.results)} results`,
                label: mcp ? `${mcpServerLabel(mcp.server)} · ${toolLabel(t.name)}` : t.name,
                tokens: t.args + t.results,
                mark: <ServerMark server={mcp?.server ?? null} className="size-4 rounded" />,
              }
            })}
          />
        </div>
      )}
      {items && call.prompt && (
        <div className="grid gap-4 @3xl/detail:grid-cols-3">
          {!call.items && <p className="text-xs text-muted-foreground @3xl/detail:col-span-3">Prefix as last sent — it did not change on this call.</p>}
          <PrefixList title="System prompt" rows={anchored(items.system, call.prompt.system)} total={b.prompt} color="var(--chart-1)" />
          <PrefixList title="Tool definitions" rows={anchored(items.tools, call.prompt.tools)} total={b.prompt} color="var(--chart-2)" />
          <PrefixList title="MCP definitions" rows={anchored(items.mcp, call.prompt.mcp)} total={b.prompt} color="var(--chart-3)" />
        </div>
      )}
    </div>
  )
}

function PrefixList({ title, rows, total, color }: { title: string; rows: { key: string; label: string; title: string; tokens: number }[]; total: number; color: string }) {
  if (rows.length === 0) return null
  return (
    <div className="min-w-0">
      <p className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        {title} <Count>{rows.length}</Count>
      </p>
      <RankList rows={rows} total={total} color={color} limit={5} />
    </div>
  )
}

const WHO: Record<ThreadCall["who"], string> = { turn: "turn", subagent: "subagent", compaction: "compaction", title: "title" }

/* ── Every call, as one chart ──
   A column per request, in order, its height the prompt it sent and its stack
   what of that came from the cache, was written to it and went uncached. A
   turn starts after a gap. The question this answers at a glance is the one a
   table of rows made the reader assemble: *which* call lost the cache — it is
   the tall column with no green in it. A click opens that call below. */
const CACHE_PARTS = [
  { key: "cacheRead", label: "Cache read", color: "var(--chart-2)" },
  { key: "cacheWrite", label: "Cache write", color: "var(--chart-3)" },
  { key: "input", label: "Uncached", color: "var(--chart-1)" },
] as const

function CallChart({
  calls,
  drops,
  openId,
  onOpen,
}: {
  calls: ThreadCall[]
  drops: Map<string, CacheDrop>
  openId: string | null
  onOpen: (callId: string) => void
}) {
  const bills = calls.map((call) => billedOf(call.billed))
  const max = Math.max(1, ...bills.map((b) => b.prompt))
  return (
    <div className="space-y-2">
      <div className="flex h-24 items-end gap-px overflow-x-auto pb-px [scrollbar-width:thin]" role="list" aria-label="Prompt per call">
        {calls.map((call, i) => {
          const b = bills[i]
          const cache = cachePercent(call.billed)
          const newTurn = i > 0 && call.turnId !== calls[i - 1].turnId
          const drop = drops.get(call.callId)
          return (
            <button
              key={call.callId}
              type="button"
              role="listitem"
              onClick={() => onOpen(call.callId)}
              title={`Step ${call.step} · ${formatTokens(b.prompt)} prompt${cache !== null ? ` · ${cache}% cached` : ""} · ${formatTokens(b.output)} out${drop ? ` · cache fell from ${drop.from}% to ${drop.to}%` : ""}`}
              className={cn(
                "group/col flex h-full max-w-5 min-w-1.5 flex-1 flex-col justify-end rounded-t-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                newTurn && "ms-1.5"
              )}
            >
              {/* The marker sits on the column it names, above its stack, so a
                  drop reads as a flag on the call rather than a second chart. */}
              {drop && <DropMark className="mx-auto mb-0.5" />}
              <span
                className={cn(
                  "flex w-full flex-col-reverse overflow-hidden rounded-t-[3px] transition-opacity",
                  openId === null || openId === call.callId ? "opacity-100" : "opacity-45 group-hover/col:opacity-100"
                )}
                style={{ height: `${Math.max(2, (b.prompt / max) * 100)}%` }}
              >
                {CACHE_PARTS.map((part) =>
                  b[part.key] > 0 ? <span key={part.key} className="w-full shrink-0" style={{ height: `${(b[part.key] / b.prompt) * 100}%`, background: part.color }} /> : null
                )}
              </span>
            </button>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {CACHE_PARTS.map((part) => (
          <span key={part.key} className="inline-flex items-center gap-1">
            <span aria-hidden className="size-2 rounded-[3px]" style={{ background: part.color }} />
            {part.label}
          </span>
        ))}
        {drops.size > 0 && (
          <span className="inline-flex items-center gap-1 text-destructive">
            <DropMark />
            {drops.size} cache drop{drops.size === 1 ? "" : "s"}
          </span>
        )}
        <span className="ms-auto tabular-nums">peak {formatTokens(max)}</span>
      </div>
    </div>
  )
}

/** Where a call's cache fell away from the one before it on its lane. */
function DropMark({ className }: { className?: string }) {
  return <span aria-hidden className={cn("block size-0 shrink-0 border-x-[4px] border-t-[5px] border-x-transparent border-t-destructive", className)} />
}

/* ── The timeline ──
   Turns, newest first, each a fold of its calls in the order they were made.
   A call's row carries a waterfall: where in the turn it started, its wait for
   a first token (pale) and its writing (solid), against the turn's own span —
   so overlap (a subagent's calls beside the parent's) and the silences between
   requests are drawn, not inferred from two timestamps. A pause worth a look
   sits between the rows as its own line, with what filled it. */

/** Why the time before a call went where it did, in a few words. */
function gapWhy(gap: Gap): string {
  const top = gap.reasons[0]
  const silence = gap.silences[0]
  if (top && top.ms >= gap.unaccounted) return gapLabel(top)
  return silence ? `${SILENCE_WORDS[silence.where].label.toLowerCase()}, no cause recorded` : "no cause recorded"
}

function GapRow({ gap }: { gap: Gap | undefined }) {
  if (!gap || gap.ms < GAP_MIN_MS) return null
  const why = gapWhy(gap)
  return (
    <li className="flex items-center gap-2 px-3 py-1 text-[11px] text-muted-foreground" title={`${formatDuration(gap.ms)} after the previous response: ${why}`}>
      <span aria-hidden className="w-6 shrink-0 border-t border-dashed" />
      <span className="shrink-0 tabular-nums">+{formatDuration(gap.ms)}</span>
      <span className="min-w-0 truncate">{why}</span>
      <span aria-hidden className="min-w-4 flex-1 border-t border-dashed" />
    </li>
  )
}

function Waterfall({ call, start, span, child, className }: { call: ThreadCall; start: number; span: number; child: boolean; className?: string }) {
  const at = span > 0 ? ((call.at - start) / span) * 100 : 0
  const share = (ms: number | undefined) => (ms !== undefined && span > 0 ? (ms / span) * 100 : 0)
  const ttft = share(call.timing?.ttftMs)
  const writing = share(call.timing?.decodeMs)
  const whole = share(call.ms)
  const timed = ttft + writing > 0
  return (
    <span className={cn("relative block h-2 w-full rounded-full bg-muted", className)} aria-hidden>
      <span className="absolute inset-y-0 flex min-w-0.5" style={{ left: `${Math.min(at, 99.5)}%`, width: `${Math.max(timed ? ttft + writing : whole, 0.5)}%` }}>
        {timed ? (
          <>
            <span className="h-full rounded-s-full bg-chart-1/45" style={{ flexGrow: ttft }} />
            <span className={cn("h-full rounded-e-full", child ? "bg-chart-4" : "bg-chart-2")} style={{ flexGrow: Math.max(writing, 0.01) }} />
          </>
        ) : (
          <span className="h-full flex-1 rounded-full bg-muted-foreground/40" />
        )}
      </span>
    </span>
  )
}

function CallRow({
  call,
  calls,
  start,
  span,
  open,
  onToggle,
  gap,
  drop,
}: {
  call: ThreadCall
  calls: ThreadCall[]
  start: number
  span: number
  open: boolean
  onToggle: () => void
  gap: Gap | undefined
  drop: CacheDrop | undefined
}) {
  const ref = React.useRef<HTMLLIElement>(null)
  /* Opened from the chart above, the row may be far below: bring it in. */
  React.useEffect(() => {
    if (open) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [open])
  const b = billedOf(call.billed)
  const cache = cachePercent(call.billed)
  return (
    <li ref={ref} className={cn(open && "bg-muted/30")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="grid w-full grid-cols-[2.25rem_minmax(0,1fr)_3.5rem_2.75rem] items-center gap-x-2 gap-y-1.5 px-3 py-2 text-start text-xs outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset @panel-sm:grid-cols-[2.25rem_minmax(0,1fr)_minmax(5rem,38%)_3.5rem_2.75rem]"
      >
        <span className="flex items-center gap-0.5 tabular-nums text-muted-foreground">
          <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
          {call.step}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          {call.who !== "turn" && call.who !== "subagent" && (
            <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] leading-none text-muted-foreground">{WHO[call.who]}</span>
          )}
          {call.called?.length ? <CalledChips call={call} max={2} /> : <span className="truncate font-mono text-[11px] text-muted-foreground">{call.finishReason ?? "—"}</span>}
        </span>
        <Waterfall call={call} start={start} span={span} child={call.childId !== undefined} className="order-last col-span-4 @panel-sm:order-none @panel-sm:col-span-1" />
        <span className="text-end tabular-nums" title={`${formatTokens(b.prompt)} prompt · ${formatTokens(b.output)} out`}>
          {formatTokens(b.prompt)}
        </span>
        <span
          className={cn("flex items-center justify-end gap-1 tabular-nums", cacheTone(cache) ?? "text-muted-foreground")}
          title={drop ? `Cache fell from ${drop.from}% on the previous call` : undefined}
        >
          {drop && <DropMark />}
          {cache === null ? "—" : `${cache}%`}
        </span>
      </button>
      {open && (
        <div className="border-t border-dashed px-3">
          <CallDetail call={call} calls={calls} gap={gap} />
        </div>
      )}
    </li>
  )
}

function TurnBlock({
  label,
  turnCalls,
  calls,
  gaps,
  drops,
  laneNames,
  openId,
  onOpen,
  defaultOpen,
}: {
  label: string
  turnCalls: ThreadCall[]
  calls: ThreadCall[]
  gaps: Map<string, Gap>
  drops: Map<string, CacheDrop>
  laneNames: Map<string, string>
  openId: string | null
  onOpen: (callId: string | null) => void
  defaultOpen: boolean
}) {
  const holdsOpen = openId !== null && turnCalls.some((call) => call.callId === openId)
  const [open, setOpen] = React.useState(defaultOpen)
  React.useEffect(() => {
    if (holdsOpen) setOpen(true)
  }, [holdsOpen])
  const start = turnCalls[0].at
  const end = Math.max(...turnCalls.map((call) => call.at + (call.ms ?? 0)))
  const span = end - start
  const b = sumBilled(turnCalls)
  const cache = cachePercent(usageOfCalls(turnCalls)!)
  const lanes = lanesOf(turnCalls)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2.5 text-start outline-none hover:bg-muted/40 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset">
        <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{label}</span>
          <span className="block truncate text-[11px] tabular-nums text-muted-foreground">
            {turnCalls.length} call{turnCalls.length === 1 ? "" : "s"}
            {span > 0 && ` · ${formatDuration(span)}`} · {formatTokens(b.output)} out
          </span>
        </span>
        <span className="shrink-0 text-end">
          <span className="block text-xs font-medium tabular-nums">{formatTokens(b.prompt + b.output)}</span>
          {cache !== null && <span className={cn("block text-[11px] tabular-nums", cacheTone(cache))}>{cache}% cached</span>}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t">
        <div className="hidden grid-cols-[2.25rem_minmax(0,1fr)_minmax(5rem,38%)_3.5rem_2.75rem] gap-x-2 px-3 pt-2 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase @panel-sm:grid">
          <span>Step</span>
          <span>Asked for</span>
          <span>Waterfall</span>
          <span className="text-end">Prompt</span>
          <span className="text-end">Cache</span>
        </div>
        {/* A lane per conversation: the thread's own calls, then each
            subagent's under its name. Every waterfall is still drawn against
            the turn's whole span, so a child running beside its parent shows
            as two bars over the same stretch — and a gap row is only ever
            between two calls of one lane, which is what `gapsOf` measured. */}
        <ul className="pb-1">
          {lanes.map(([lane, laneCalls], index) => (
            <li key={lane || "own"} className={cn(lanes.length > 1 && index > 0 && "mt-1 border-t border-dashed pt-1")}>
              {(lanes.length > 1 || lane !== "") && (
                <p className="flex items-center gap-1.5 px-3 pt-1.5 pb-0.5 text-[11px] font-medium text-muted-foreground">
                  {lane ? <BotIcon className="size-3 shrink-0 text-chart-4" /> : <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-chart-2" />}
                  <span className="min-w-0 truncate">{lane ? (laneNames.get(lane) ?? `Subagent ${lanes[0][0] === "" ? index : index + 1}`) : "This thread"}</span>
                  <span className="shrink-0 font-normal tabular-nums">
                    · {laneCalls.length} call{laneCalls.length === 1 ? "" : "s"}
                  </span>
                </p>
              )}
              <ul className={cn(lane && "ms-3 border-s border-chart-4/40")}>
                {laneCalls.map((call) => (
                  <React.Fragment key={call.callId}>
                    <GapRow gap={gaps.get(call.callId)} />
                    <CallRow
                      call={call}
                      calls={calls}
                      start={start}
                      span={span}
                      open={openId === call.callId}
                      onToggle={() => onOpen(openId === call.callId ? null : call.callId)}
                      gap={gaps.get(call.callId)}
                      drop={drops.get(call.callId)}
                    />
                  </React.Fragment>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** A turn's calls by lane: the thread's own first, then each subagent in the
    order it first called the model. */
function lanesOf(turnCalls: ThreadCall[]): [string, ThreadCall[]][] {
  const lanes = new Map<string, ThreadCall[]>([["", []]])
  for (const call of turnCalls) {
    const lane = laneOf(call)
    lanes.set(lane, [...(lanes.get(lane) ?? []), call])
  }
  return [...lanes].filter(([, list]) => list.length > 0)
}

/** Turns drawn before "show older": a long thread is hundreds of calls. */
const TURNS_SHOWN = 8

function Timeline({
  calls,
  items,
  turnIndex,
  drops,
  openId,
  onOpen,
}: {
  calls: ThreadCall[]
  items: ThreadItem[]
  turnIndex: Map<string, number>
  drops: Map<string, CacheDrop>
  openId: string | null
  onOpen: (callId: string | null) => void
}) {
  const gaps = React.useMemo(() => gapsOf(calls, items, (tool) => stepLeadOf(tool.meta)), [calls, items])
  /* A lane is named by the child the runtime announced, where it did; a
     runtime whose children are only tool calls leaves it numbered. */
  const laneNames = React.useMemo(() => {
    const names = new Map<string, string>()
    for (const item of items) if (item.kind === "subagent") names.set(item.sessionId, item.name)
    return names
  }, [items])
  /* Newest turn first: the call a reader opens this panel about is the last one. */
  const turns = React.useMemo(() => {
    const byTurn = new Map<string, ThreadCall[]>()
    for (const call of calls) {
      const key = call.turnId ?? ""
      byTurn.set(key, [...(byTurn.get(key) ?? []), call])
    }
    return [...byTurn].reverse()
  }, [calls])
  const [limit, setLimit] = React.useState(TURNS_SHOWN)
  const openAt = openId === null ? -1 : turns.findIndex(([, list]) => list.some((call) => call.callId === openId))
  React.useEffect(() => {
    if (openAt >= limit) setLimit(openAt + 1)
  }, [openAt, limit])
  return (
    <div className="space-y-2">
      {turns.slice(0, limit).map(([key, list], i) => (
        <TurnBlock
          key={key || "outside"}
          label={key ? `Turn ${turnIndex.get(key) ?? "?"}` : "Outside a turn"}
          turnCalls={list}
          calls={calls}
          gaps={gaps}
          drops={drops}
          laneNames={laneNames}
          openId={openId}
          onOpen={onOpen}
          defaultOpen={i < 2}
        />
      ))}
      {turns.length > limit && (
        <button
          type="button"
          onClick={() => setLimit((n) => n + TURNS_SHOWN)}
          className="w-full rounded-xl py-2 text-xs text-muted-foreground border border-dashed hover:bg-muted/40 hover:text-foreground"
        >
          Show {Math.min(TURNS_SHOWN, turns.length - limit)} older turn{turns.length - limit === 1 ? "" : "s"} of {turns.length - limit}
        </button>
      )}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="h-1.5 w-3 rounded-full bg-chart-1/45" /> waiting for first token
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="h-1.5 w-3 rounded-full bg-chart-2" /> writing
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="h-1.5 w-3 rounded-full bg-chart-4" /> a subagent writing
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="h-1.5 w-3 rounded-full bg-muted-foreground/40" /> untimed
        </span>
      </p>
    </div>
  )
}

/* ── the panel ──
   Three bands, top to bottom: the thread's bill (the same face a turn's and a
   step's popover wear, so the three never read as three products), every call
   as one chart of its prompt and cache, and the detail behind tabs — the
   timeline of turns and calls, where the prompt went, and the tools. */

export default function TracePanel({ thread, meta }: { thread: ThreadState; meta: SessionMeta }) {
  /* The route answers the turns the window withheld and a retired thread's
     whole ledger; the socket's own records are merged on top. Gated on the
     server having the route: a stored layout can name this panel against an
     older server, and a 404 retried forever drew as "no calls". */
  const stored = useThreadCalls(meta.id, useFeature("modelCalls"))
  const storedError = React.useMemo(() => inlineFromQuery(stored.error, "Couldn't read this thread's stored calls"), [stored.error])
  const calls = React.useMemo(() => {
    const merged = mergeCalls(stored.data ?? [], thread.calls)
    return merged.length > 0 ? merged : rowsFromStepUsage(thread.items, thread.stepUsage, thread.stepAt, meta.model)
  }, [stored.data, thread.calls, thread.items, thread.stepUsage, thread.stepAt, meta.model])
  /* The turn's ordinal in the journal's whole table of contents, falling back
     to first-seen order for a turn the contents do not list. */
  const turnIndex = React.useMemo(() => {
    const index = new Map<string, number>()
    thread.turns.forEach((turn, i) => index.set(turn.turnId, i + 1))
    for (const call of calls) if (call.turnId && !index.has(call.turnId)) index.set(call.turnId, index.size + 1)
    return index
  }, [thread.turns, calls])
  const [view, setView] = React.useState<View>("calls")
  const [openId, setOpenId] = React.useState<string | null>(null)

  const billed = sumBilled(calls)
  const usage = React.useMemo(() => usageOfCalls(calls), [calls])
  const split = React.useMemo(() => sumSplits(calls.map((call) => call.output)), [calls])
  const drops = React.useMemo(() => cacheDrops(calls), [calls])
  const cost = costOf(calls)
  const missing = missingWords(calls)
  const door = thread.callsVia ?? calls.at(-1)?.source ?? null
  const toolCount = React.useMemo(() => toolStats(calls).length, [calls])
  const turnCount = new Set(calls.map((call) => call.turnId).filter(Boolean)).size
  const modelMs = calls.reduce((n, call) => n + (call.ms ?? 0), 0)
  const openCall = (callId: string) => {
    setView("calls")
    setOpenId(callId)
  }

  if (calls.length === 0)
    return (
      <div className="@container min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {storedError && <ErrorNote error={storedError} onRetry={() => void stored.refetch()} />}
        {stored.isPending ? (
          <div className="space-y-3" aria-busy>
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-32 rounded-2xl" />
          </div>
        ) : (
          <Empty>No model calls recorded in this thread yet.</Empty>
        )}
      </div>
    )

  return (
    <div className="@container min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {storedError && <ErrorNote error={storedError} onRetry={() => void stored.refetch()} />}
      <section className="space-y-3 rounded-2xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="font-medium">This thread</span>
          {door && (
            <span className="flex min-w-0 items-center gap-1" title={DOOR_WORDS[door]}>
              <CpuIcon className="size-3.5 shrink-0" />
              <span className="truncate">via {door}</span>
            </span>
          )}
        </div>
        <ReadingHero
          value={formatTokens(billed.prompt + billed.output)}
          unit="tokens billed"
          caption={`${calls.length} call${calls.length === 1 ? "" : "s"}${turnCount ? ` · ${turnCount} turn${turnCount === 1 ? "" : "s"}` : ""}`}
          cache={usage ? cachePercent(usage) : null}
        />
        <Facts
          items={[
            { label: "Prompt", value: formatTokens(billed.prompt) },
            { label: "Output", value: formatTokens(billed.output) },
            modelMs > 0 && { label: "Model time", value: formatDuration(modelMs) },
            cost !== null && { label: "Cost", value: `$${cost.toFixed(cost < 1 ? 4 : 2)}` },
          ]}
        />
        {usage && <TokenBreakdown usage={usage} split={split} />}
        {door && (missing.length > 0 || door === "usage") && (
          <p className="border-t pt-2 text-[11px] leading-4 text-muted-foreground">
            {DOOR_WORDS[door]}
            {missing.length > 0 && ` Not visible: ${missing.join(", ")}.`}
          </p>
        )}
      </section>
      <section className="space-y-2 rounded-2xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="font-medium text-muted-foreground">Every call</span>
          <span className="text-muted-foreground">prompt sent, by cache · click one to open it</span>
        </div>
        <CallChart calls={calls} drops={drops} openId={openId} onOpen={openCall} />
      </section>
      <ReadingTabs
        value={view}
        onChange={(id) => setView(id as View)}
        tabs={[
          { id: "calls", label: "Timeline", meta: `${calls.length} calls`, content: <Timeline calls={calls} items={thread.items} turnIndex={turnIndex} drops={drops} openId={openId} onOpen={setOpenId} /> },
          { id: "prompt", label: "Prompt", meta: "~ anchored to the bill", content: <Overview calls={calls} onTools={() => setView("tools")} /> },
          toolCount > 0 && { id: "tools", label: "Tools", meta: `${toolCount}`, content: <ToolsView calls={calls} /> },
        ]}
      />
    </div>
  )
}
