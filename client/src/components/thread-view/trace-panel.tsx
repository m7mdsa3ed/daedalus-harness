/* ── Trace ──
   What a thread's model calls cost and where the tokens went, from whichever
   door its runtime has (docs/protocol.md "Model calls"). Three readings of the
   same records, one switch:

   - **Overview** — the totals, one bar of where the prompt went, and the
     biggest things in it (system sections, tool definitions, MCP servers),
     every figure in billed tokens (local counts anchored to the bill).
   - **Tools** — every tool and MCP server the thread carried or called: how
     often the model asked for it, what its calls and results weigh in the
     history, and what its definition costs on every call. MCP tools fold under
     their server, which wears its own mark.
   - **Calls** — one row per request with the tools it asked to run; the fold is
     that call's split, bill and prefix.

   Nothing here branches on the runtime: `source` and `missing` are drawn in
   the door's own words (`lib/trace.ts`), and a part a door could not see is
   hatched, never drawn as a smaller prompt. */
import * as React from "react"
import { ChevronRightIcon, CpuIcon, LayersIcon, ListIcon, WrenchIcon } from "lucide-react"

import { DataTable, TitleCell, type DataTableExpand, type DataTableMobile } from "@/components/ui/data-table"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Empty } from "@/components/empty"
import { Notice } from "@/components/notice"
import { McpIcon } from "@/components/entity-icon"
import { mcpTint } from "@/components/tool-parts"
import { Count, SectionHead, Segmented, StatStrip } from "@/components/settings/primitives"
import type { ColumnDef } from "@/lib/table"
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
  cacheSaved,
  calledCounts,
  costOf,
  gapsOf,
  itemsAt,
  mcpOfName,
  mergeCalls,
  missingWords,
  rowsFromStepUsage,
  serverStats,
  sumBilled,
  sumParts,
  toolStats,
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

const PART_LABEL: Record<PartKey, string> = {
  system: "System prompt",
  tools: "Tool definitions",
  mcp: "MCP definitions",
  user: "Your messages",
  assistant: "Assistant replies",
  results: "Tool results",
}
const PART_SHORT: Record<PartKey, string> = {
  system: "System",
  tools: "Tools",
  mcp: "MCP",
  user: "User",
  assistant: "Assistant",
  results: "Results",
}
const PART_COLOR: Record<PartKey, string> = {
  system: "var(--chart-1)",
  tools: "var(--chart-2)",
  mcp: "var(--chart-3)",
  user: "var(--chart-4)",
  assistant: "var(--chart-5)",
  results: "var(--primary)",
}
/** A part the door could not see: drawn as a hatch, never as a smaller prompt. */
const HATCH = { backgroundImage: "repeating-linear-gradient(45deg, transparent 0 3px, var(--border) 3px 5px)" }

const pct = (n: number, total: number) => (total > 0 ? `${Math.round((n / total) * 100)}%` : "0%")
const approx = (n: number) => `~${formatTokens(n)}`

type View = "overview" | "tools" | "calls"

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

/** `5m 2s` for the pause, with the one reason that filled most of it. */
function GapNote({ gap }: { gap: Gap | undefined }) {
  if (!gap || gap.ms < GAP_MIN_MS) return null
  const top = gap.reasons[0]
  const silence = gap.silences[0]
  const why = top && top.ms >= gap.unaccounted ? gapLabel(top) : silence ? SILENCE_WORDS[silence.where].label.toLowerCase() + ", no cause recorded" : "no cause recorded"
  return (
    <span className="block text-[11px] text-muted-foreground" title={`${formatDuration(gap.ms)} after the previous response: ${why}`}>
      +{formatDuration(gap.ms)} <span className="hidden @panel-lg:inline">· {why}</span>
    </span>
  )
}

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


/** The row's fold: its split, its bill, its prefix and the tools its history carried. */
function CallDetail({ call, calls, gap }: { call: ThreadCall; calls: ThreadCall[]; gap: Gap | undefined }) {
  const index = calls.indexOf(call)
  const items = itemsAt(calls, index)
  const b = billedOf(call.billed)
  const anchored = (list: PrefixItem[], part: number | null) =>
    anchorItems(list, part).map((i) => ({ key: i.name, label: i.name, title: i.name, tokens: i.tokens }))
  /* Its own container: it is drawn inside a table cell or under a card, and
     how much room it has is that box's width, not the panel's. */
  return (
    <div className="@container/detail min-w-0 space-y-5 py-2">
      {gap && <GapDetail gap={gap} />}
      {call.prompt ? (
        <div className="space-y-3">
          <PromptBar parts={call.prompt} total={b.prompt} className="h-2.5" />
          <PartsLegend parts={call.prompt} total={b.prompt} />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No prompt split for this call — the bill only.</p>
      )}
      {call.missing && call.missing.length > 0 && <p className="text-xs text-muted-foreground">Not visible to this door: {call.missing.join(", ")}.</p>}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs @xs/detail:grid-cols-2 @xl/detail:grid-cols-4">
        <Fact label="Fresh input" value={formatTokens(b.input)} />
        <Fact label="Cache read" value={formatTokens(b.cacheRead)} />
        <Fact label="Cache write" value={formatTokens(b.cacheWrite)} />
        <Fact label="Output" value={formatTokens(b.output)} />
        {call.output && (
          <>
            <Fact label="~ Text" value={formatTokens(call.output.text)} />
            <Fact label="Reasoning" value={formatTokens(call.output.reasoning)} />
            <Fact label="~ Tool calls" value={formatTokens(call.output.toolCalls)} />
          </>
        )}
        {call.costUsd !== undefined && <Fact label="Cost" value={`$${call.costUsd.toFixed(4)}`} />}
      </dl>
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

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

const WHO: Record<ThreadCall["who"], string> = { turn: "turn", subagent: "subagent", compaction: "compaction", title: "title" }

function CallsView({ calls, items, turnIndex, loading }: { calls: ThreadCall[]; items: ThreadItem[]; turnIndex: Map<string, number>; loading: boolean }) {
  const gaps = React.useMemo(() => gapsOf(calls, items, (tool) => stepLeadOf(tool.meta)), [calls, items])
  const columns = React.useMemo<ColumnDef<ThreadCall, unknown>[]>(
    () => [
      {
        id: "call",
        header: "Call",
        meta: { title: true, className: "min-w-36" },
        cell: ({ row }) => {
          const call = row.original
          const turn = call.turnId ? turnIndex.get(call.turnId) : undefined
          return (
            <div className="min-w-0 space-y-1">
              <TitleCell title={`${turn ? `Turn ${turn} · ` : ""}step ${call.step}`} subtitle={[WHO[call.who], call.model].join(" · ")} />
              <CalledChips call={call} />
            </div>
          )
        },
      },
      {
        id: "prompt",
        header: "~ Prompt",
        meta: { className: "min-w-40" },
        cell: ({ row }) => {
          const b = billedOf(row.original.billed)
          return (
            <div className="space-y-1">
              <PromptBar parts={row.original.prompt} total={b.prompt} />
              <p className="text-xs tabular-nums text-muted-foreground">
                {formatTokens(b.prompt)}
                {b.cacheRead ? ` · ${pct(b.cacheRead, b.prompt)} cached` : ""}
              </p>
            </div>
          )
        },
      },
      {
        id: "output",
        header: "Output",
        meta: { align: "end", className: "w-20 whitespace-nowrap" },
        cell: ({ row }) => (
          <span className="tabular-nums">
            {formatTokens(row.original.billed.outputTokens)}
            {row.original.billed.thoughtTokens ? <span className="text-muted-foreground"> +{formatTokens(row.original.billed.thoughtTokens)}</span> : null}
          </span>
        ),
      },
      {
        id: "time",
        header: "Time",
        meta: { align: "end", className: "hidden @panel-md:table-cell w-24 whitespace-nowrap" },
        cell: ({ row }) => (
          <span className="block text-end">
            <Ms value={row.original.ms ?? row.original.timing?.decodeMs} />
            {row.original.timing?.ttftMs !== undefined && (
              <span className="block text-[11px] text-muted-foreground">
                first <Ms value={row.original.timing.ttftMs} />
              </span>
            )}
            <StepRate call={row.original} className="block text-[11px]" />
            <GapNote gap={gaps.get(row.original.callId)} />
          </span>
        ),
      },
      {
        id: "finish",
        header: "Finish",
        meta: { className: "hidden @panel-lg:table-cell w-24" },
        cell: ({ row }) => <span className="font-mono text-xs text-muted-foreground">{row.original.finishReason ?? "—"}</span>,
      },
    ],
    [turnIndex, gaps]
  )
  const expand = React.useMemo<DataTableExpand<ThreadCall>>(
    () => ({ render: (call) => <CallDetail call={call} calls={calls} gap={gaps.get(call.callId)} />, cards: true }),
    [calls, gaps]
  )
  /* The narrow card: what the wide row says, stacked — step and model, the
     tools it ran, then the bar with its figures under it. */
  const mobile = React.useMemo<DataTableMobile<ThreadCall>>(
    () => ({
      renderRow: (call) => {
        const b = billedOf(call.billed)
        return (
          <div className="min-w-0 space-y-1.5 pe-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium">Step {call.step}</span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {call.ms !== undefined ? <Ms value={call.ms} /> : null}
              </span>
            </div>
            <GapNote gap={gaps.get(call.callId)} />
            <p className="truncate text-xs text-muted-foreground">{[WHO[call.who], call.model].join(" · ")}</p>
            <CalledChips call={call} />
            <PromptBar parts={call.prompt} total={b.prompt} />
            <p className="flex flex-wrap gap-x-3 text-xs tabular-nums text-muted-foreground">
              <span>{formatTokens(b.prompt)} in</span>
              {b.cacheRead > 0 && <span>{pct(b.cacheRead, b.prompt)} cached</span>}
              <span>
                {formatTokens(b.output)} out{b.reasoning ? ` +${formatTokens(b.reasoning)}` : ""}
              </span>
              <StepRate call={call} />
            </p>
          </div>
        )
      },
    }),
    [gaps]
  )
  /* Newest first: the call a reader opens this panel about is the last one. */
  const rows = React.useMemo(() => [...calls].reverse(), [calls])
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(call) => call.callId}
      isLoading={loading}
      expand={expand}
      pageSize={50}
      viewToggle={false}
      mobile={mobile}
      grouping={{
        by: (call) => call.turnId ?? undefined,
        renderHeader: (key) => <TurnHead turn={turnIndex.get(key)} calls={calls.filter((c) => c.turnId === key)} />,
        renderMobileHeader: (key) => <TurnHead turn={turnIndex.get(key)} calls={calls.filter((c) => c.turnId === key)} />,
      }}
    />
  )
}

function TurnHead({ turn, calls }: { turn: number | undefined; calls: ThreadCall[] }) {
  const b = sumBilled(calls)
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs font-medium text-muted-foreground">
      {turn ? `Turn ${turn}` : "Turn"}
      <span className="font-normal tabular-nums">
        {calls.length} call{calls.length === 1 ? "" : "s"} · {formatTokens(b.prompt)} in · {formatTokens(b.output)} out
      </span>
    </div>
  )
}

/** The step's output speed, after its first chunk; nothing where no decode was timed. */
function StepRate({ call, className }: { call: ThreadCall; className?: string }) {
  const rate = stepRate(call)
  const text = rate === null ? null : formatTps(rate)
  return text ? (
    <span className={cn("tabular-nums text-muted-foreground", className)} title="Output tokens per second after the first chunk">
      {text}
    </span>
  ) : null
}

function Ms({ value }: { value: number | undefined }) {
  return <span className="tabular-nums text-muted-foreground">{value === undefined ? "—" : value >= 10_000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`}</span>
}

/* ── the panel ── */

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
  const [view, setView] = React.useState<View>("overview")

  const billed = sumBilled(calls)
  const saved = cacheSaved(billed)
  const cost = costOf(calls)
  const missing = missingWords(calls)
  const door = thread.callsVia ?? calls.at(-1)?.source ?? null
  const loading = stored.isPending && calls.length === 0
  const toolCount = React.useMemo(() => toolStats(calls).length, [calls])

  return (
    <div className="@container min-h-0 flex-1 overflow-y-auto p-3">
      {storedError && <ErrorNote error={storedError} onRetry={() => void stored.refetch()} className="mb-4" />}
      <StatStrip
        stats={[
          { label: "Prompt", value: formatTokens(billed.prompt), hint: `${formatTokens(billed.input)} fresh`, loading },
          {
            label: "Cache hit",
            value: saved === null ? "—" : `${Math.round(saved * 100)}%`,
            hint: `${formatTokens(billed.cacheRead)} read`,
            tone: saved !== null && saved >= 0.5 ? "ok" : "default",
            loading,
          },
          { label: "Output", value: formatTokens(billed.output), hint: billed.reasoning > 0 ? `${formatTokens(billed.reasoning)} reasoning` : undefined, loading },
          { label: "Calls", value: calls.length, hint: cost !== null ? `$${cost.toFixed(4)}` : undefined, loading },
        ]}
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented<View>
          label="Trace view"
          value={view}
          onChange={setView}
          options={[
            { value: "overview", label: "Overview", icon: LayersIcon },
            { value: "tools", label: "Tools", icon: WrenchIcon, count: toolCount || undefined },
            { value: "calls", label: "Calls", icon: ListIcon, count: calls.length || undefined },
          ]}
        />
        {door && (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" title={DOOR_WORDS[door]}>
            <CpuIcon className="size-3.5 shrink-0" />
            <span className="truncate">via {door}</span>
          </span>
        )}
      </div>
      {door && (missing.length > 0 || door === "usage") && (
        <Notice tone="neutral" className="mb-4">
          {DOOR_WORDS[door]}
          {missing.length > 0 && ` Not visible: ${missing.join(", ")}.`}
        </Notice>
      )}
      {calls.length === 0 && !stored.isPending ? (
        <Empty>No model calls recorded in this thread yet.</Empty>
      ) : view === "overview" ? (
        <Overview calls={calls} onTools={() => setView("tools")} />
      ) : view === "tools" ? (
        <ToolsView calls={calls} />
      ) : (
        <CallsView calls={calls} items={thread.items} turnIndex={turnIndex} loading={loading} />
      )}
    </div>
  )
}
