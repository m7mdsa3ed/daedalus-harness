/* ── The Trajectory ──
   One thread's OpenTelemetry spans (`GET /api/sessions/:id/spans`), drawn the
   way a trace viewer draws them: grouped by **trace** (the harness roots one
   per turn), each trace with its own time axis, and under it the span tree as
   a waterfall — every bar placed on its trace's window, with the span's events
   marked on it. Totals across the top; the selected span, whole, beside the
   list (or in its place, on a narrow panel).

   One component for both doors — the thread dock's panel and the
   `/t/:id/trace` page — reflowing on its own box (`@panel-md:`), never the
   window. The readers are `lib/trajectory.ts`; this file only draws, and the
   selected span's own view is `span-detail.tsx`. */
import * as React from "react"
import {
  ArrowDownToLineIcon,
  ChevronRightIcon,
  DownloadIcon,
  RefreshCwIcon,
  RouteIcon,
  SearchIcon,
} from "lucide-react"
import type { TraceSpan, TraceSpanKind } from "@daedalus/protocol"

import { Empty } from "@/components/empty"
import { ErrorNote } from "@/components/error-note"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { Toggle } from "@/components/ui/toggle"
import { PanelToolbar } from "@/components/workspace/primitives"
import { inlineFromQuery, reportError } from "@/lib/errors"
import { useFetchWholeSpans, useThreadSpans } from "@/lib/queries/trace"
import { useStoreSelect } from "@/lib/store"
import { formatTokens, formatTps } from "@/lib/tokens"
import {
  buildTree,
  flatten,
  groupTraces,
  niceTicks,
  spanDuration,
  spanUsage,
  toOtlpDocument,
  totals as sumTotals,
  traceLabel,
  visibleRows,
  type SpanNode,
  type TraceGroup,
} from "@/lib/trajectory"
import { cn } from "@/lib/utils"
import { useFocusedRow, useWindowedRows } from "@/lib/windowed-rows"
import { KIND, fmtMs, spanBg, spanText } from "./kinds"
import { SpanDetail } from "./span-detail"

const EMPTY: TraceSpan[] = []

/** One line of the list: a trace's header (with its axis), or a span in it. */
type Item =
  | { type: "trace"; group: TraceGroup; n: number }
  | { type: "span"; node: SpanNode; group: TraceGroup }

const itemKey = (item: Item) => (item.type === "trace" ? `trace:${item.group.traceId}` : item.node.span.spanId)

export function Trajectory({ sessionId, variant }: { sessionId: string; variant: "panel" | "page" }) {
  const live = useStoreSelect((state) => state.threads[sessionId]?.turnActive ?? false)
  const query = useThreadSpans(sessionId, { live })
  const spans = query.data?.spans ?? EMPTY
  const now = useNow(live)

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<string>>(new Set())
  const [hidden, setHidden] = React.useState<ReadonlySet<TraceSpanKind>>(new Set())
  const [search, setSearch] = React.useState("")
  const [follow, setFollow] = React.useState(true)
  const listRef = React.useRef<HTMLDivElement>(null)

  const byId = React.useMemo(() => new Map(spans.map((s) => [s.spanId, s])), [spans])
  const roots = React.useMemo(() => buildTree(spans), [spans])
  const nodes = React.useMemo(() => new Map(flatten(roots).map((n) => [n.span.spanId, n])), [roots])
  const groups = React.useMemo(() => groupTraces(roots), [roots])
  const needle = search.trim()

  /* A trace's id is in `collapsed` beside the spans', prefixed so the two
     never collide. */
  const items = React.useMemo(() => {
    const out: Item[] = []
    groups.forEach((group, i) => {
      const list = visibleRows(flatten(group.roots, needle ? new Set() : collapsed), byId, needle, hidden)
      if ((needle || hidden.size) && list.length === 0) return
      out.push({ type: "trace", group, n: i + 1 })
      if (collapsed.has(`trace:${group.traceId}`) && !needle) return
      for (const node of list) out.push({ type: "span", node, group })
    })
    return out
  }, [groups, collapsed, byId, needle, hidden])

  const kinds = React.useMemo(
    () => (Object.keys(KIND) as TraceSpanKind[]).filter((k) => k !== "turn" && spans.some((s) => s.kind === k)),
    [spans]
  )
  const totals = React.useMemo(() => sumTotals(spans, now), [spans, now])
  const selected = selectedId ? (nodes.get(selectedId) ?? null) : null

  /* Past 200 lines only the window is drawn (and re-rendered per `now` tick);
     the selected and focused lines are pinned, so reveal() and focus keep
     their element. */
  const [focusIndex, onListFocus] = useFocusedRow(items.length, (i) => itemKey(items[i]))
  const selectedIndex = React.useMemo(
    () => (selectedId ? items.findIndex((item) => item.type === "span" && item.node.span.spanId === selectedId) : -1),
    [items, selectedId]
  )
  const w = useWindowedRows({
    count: items.length,
    threshold: 200,
    list: listRef,
    estimateSize: (i) => (items[i].type === "trace" ? TRACE_H : ROW_H),
    getItemKey: (i) => itemKey(items[i]),
    pin: [selectedIndex, focusIndex],
  })

  /* Follow: the newest line stays in view while the turn runs. Scrolling up
     is reading, and stops it. */
  React.useEffect(() => {
    const list = listRef.current
    if (follow && live && list) list.scrollTop = list.scrollHeight
  }, [follow, live, items])

  const reveal = (spanId: string) => {
    const node = nodes.get(spanId)
    if (node) {
      /* A span inside a folded trace or subtree is opened to, never hidden. */
      setCollapsed((prev) => {
        const next = new Set(prev)
        next.delete(`trace:${node.span.traceId}`)
        for (let p = node.span.parentSpanId; p; p = byId.get(p)?.parentSpanId ?? null) next.delete(p)
        return next.size === prev.size ? prev : next
      })
    }
    setSelectedId(spanId)
    setFollow(false)
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector(`[data-key="${CSS.escape(spanId)}"]`)
        ?.scrollIntoView({ block: "nearest" })
    )
  }
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const fetchWhole = useFetchWholeSpans(sessionId)
  const [exporting, setExporting] = React.useState(false)
  const exportSpans = () => {
    setExporting(true)
    fetchWhole(spans)
      .then((whole) => download(`trajectory-${sessionId}.otlp.json`, JSON.stringify(toOtlpDocument(whole), null, 2)))
      .catch((err) => reportError(err, "Couldn't export the trajectory"))
      .finally(() => setExporting(false))
  }

  const failure = React.useMemo(() => inlineFromQuery(query.error, "Couldn't read the trajectory"), [query.error])

  return (
    <div
      className={cn(
        "@container flex h-full min-h-0 flex-1 flex-col text-sm",
        variant === "panel" ? "pt-[var(--dock-content-overlap,0px)]" : "pt-[var(--app-header-h)]"
      )}
    >
      <PanelToolbar className="flex-wrap">
        {variant === "page" && (
          <h1 className="mr-2 flex items-center gap-2 text-sm font-medium">
            <RouteIcon className="size-4 text-muted-foreground" />
            Trajectory
          </h1>
        )}
        <InputGroup className="h-8 min-w-32 flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search spans"
            aria-label="Search spans"
          />
        </InputGroup>
        {groups.length > 1 && (
          <NativeSelect
            size="sm"
            aria-label="Jump to a trace"
            className="max-w-40"
            value=""
            onChange={(event) => event.target.value && jumpToTrace(groups, event.target.value, reveal)}
          >
            <NativeSelectOption value="">Jump to trace…</NativeSelectOption>
            {groups.map((group, i) => (
              <NativeSelectOption key={group.traceId} value={group.traceId}>
                {`${i + 1}. ${traceLabel(group)}`.slice(0, 60)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <Button
          variant={follow ? "secondary" : "ghost"}
          size="icon-sm"
          aria-pressed={follow}
          title={follow ? "Following the newest span" : "Follow the newest span"}
          aria-label="Follow the newest span"
          onClick={() => setFollow((f) => !f)}
        >
          <ArrowDownToLineIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Refresh"
          aria-label="Refresh"
          loading={query.isFetching && !live}
          onClick={() => void query.refetch()}
        >
          <RefreshCwIcon className={cn(query.isFetching && !live && "animate-spin")} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Export as OTLP/JSON"
          aria-label="Export as OTLP/JSON"
          disabled={exporting || spans.length === 0}
          onClick={exportSpans}
        >
          <DownloadIcon />
        </Button>
      </PanelToolbar>

      {failure && (
        <div className="p-3">
          <ErrorNote error={failure} onRetry={() => void query.refetch()} />
        </div>
      )}

      {query.isPending ? (
        <div className="space-y-2 p-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-4 w-full" />
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : spans.length === 0 ? (
        !failure && (
          <div className="p-3">
            <Empty size="lg" icon={RouteIcon}>
              No trajectory recorded yet — spans are recorded from the next turn on.
            </Empty>
          </div>
        )
      ) : (
        <>
          <div className={cn(selected && "hidden @panel-md:block")}>
            <Kpis totals={totals} traces={groups.length} />
            {kinds.length > 1 && (
              <div className="flex flex-wrap gap-1 border-b px-3 py-2">
                {kinds.map((kind) => {
                  const off = hidden.has(kind)
                  const Icon = KIND[kind].icon
                  return (
                    <Toggle
                      key={kind}
                      variant="outline"
                      size="sm"
                      pressed={!off}
                      onPressedChange={() =>
                        setHidden((prev) => {
                          const next = new Set(prev)
                          if (off) next.delete(kind)
                          else next.add(kind)
                          return next
                        })
                      }
                      className={cn("h-6 px-2 text-xs", off && "text-muted-foreground line-through")}
                    >
                      <Icon className={cn("size-3", KIND[kind].text)} />
                      {KIND[kind].label}
                    </Toggle>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col @panel-md:flex-row">
            <div
              ref={listRef}
              role="tree"
              aria-label="Traces and spans"
              onWheel={(event) => event.deltaY < 0 && setFollow(false)}
              onFocus={onListFocus}
              className={cn("min-h-0 flex-1 overflow-y-auto pb-1", selected && "hidden @panel-md:block")}
            >
              {items.length === 0 ? (
                <div className="p-3">
                  <Empty>No span matches.</Empty>
                </div>
              ) : (
                w.rows.map(({ index, key, before }) => {
                  const item = items[index]
                  return item.type === "trace" ? (
                    <TraceHeader
                      key={key}
                      index={index}
                      before={before}
                      group={item.group}
                      n={item.n}
                      now={now}
                      collapsed={collapsed.has(`trace:${item.group.traceId}`)}
                      onToggle={() => toggle(`trace:${item.group.traceId}`)}
                    />
                  ) : (
                    <Row
                      key={key}
                      index={index}
                      before={before}
                      node={item.node}
                      group={item.group}
                      now={now}
                      selected={item.node.span.spanId === selectedId}
                      collapsed={collapsed.has(item.node.span.spanId)}
                      onSelect={() => setSelectedId(item.node.span.spanId)}
                      onToggle={() => toggle(item.node.span.spanId)}
                    />
                  )
                })
              )}
              {w.after > 0 && <div aria-hidden style={{ height: w.after }} />}
            </div>
            <div
              className={cn(
                "flex min-h-0 flex-col @panel-md:w-[45%] @panel-md:shrink-0 @panel-md:border-l",
                selected ? "flex-1 @panel-md:flex-none" : "hidden @panel-md:flex"
              )}
            >
              {selected ? (
                <SpanDetail
                  key={selected.span.spanId}
                  sessionId={sessionId}
                  spans={spans}
                  node={selected}
                  now={now}
                  live={live}
                  onClose={() => setSelectedId(null)}
                  onSelect={reveal}
                />
              ) : (
                <p className="p-4 text-muted-foreground">
                  Select a span to read its identity, attributes, events, links and the raw OTLP.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const TRACE_H = 40
const ROW_H = 28
const COLUMNS = "grid-cols-[minmax(0,1fr)_minmax(3rem,35%)_3.5rem]"

function jumpToTrace(groups: TraceGroup[], traceId: string, reveal: (spanId: string) => void) {
  const group = groups.find((g) => g.traceId === traceId)
  if (group) reveal(group.roots[0].span.spanId)
}

/** Ticks while the turn runs, so open spans grow; frozen otherwise. */
function useNow(live: boolean): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!live) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
  return now
}

function Kpis({ totals: t, traces }: { totals: ReturnType<typeof sumTotals>; traces: number }) {
  const cells: [string, string, boolean?][] = [
    ["Traces", String(traces)],
    ["Model calls", String(t.modelCalls)],
    ["Tool calls", String(t.toolCalls)],
    ["Errors", String(t.errors), t.errors > 0],
    ["Model time", fmtMs(t.modelTime)],
    ["Tool time", fmtMs(t.toolTime)],
    ["Input", formatTokens(t.input)],
    ["Output", formatTokens(t.output)],
    ["Cached", formatTokens(t.cacheRead)],
    ["Avg TTFT", fmtMs(t.avgTtft)],
    ["Avg speed", t.avgTps === null ? "—" : (formatTps(t.avgTps) ?? "—")],
  ]
  return (
    <dl className="grid grid-cols-4 gap-px border-b bg-border @panel-sm:grid-cols-6 @panel-lg:grid-cols-11">
      {cells.map(([label, value, bad]) => (
        <div key={label} className="bg-background px-3 py-2">
          <dt className="truncate text-xs text-muted-foreground">{label}</dt>
          <dd className={cn("text-sm font-medium tabular-nums", bad && "text-destructive")}>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A trace's window: where its bars are placed. */
const windowOf = (group: TraceGroup, now: number) => {
  const end = group.end ?? Math.max(now, group.start)
  return { start: group.start, duration: Math.max(1, end - group.start) }
}

/* ── A trace's header ──
   Its label, span count and length, and the axis its bars are placed against:
   ticks at round numbers from 0 to the trace's end. */
function TraceHeader({
  index,
  before,
  group,
  n,
  now,
  collapsed,
  onToggle,
}: {
  index: number
  before: number
  group: TraceGroup
  n: number
  now: number
  collapsed: boolean
  onToggle: () => void
}) {
  const { duration } = windowOf(group, now)
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-selected={false}
      aria-expanded={!collapsed}
      tabIndex={0}
      data-index={index}
      data-key={`trace:${group.traceId}`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onToggle()
        }
      }}
      className={cn(
        "sticky top-0 z-10 grid cursor-pointer items-center gap-2 border-b bg-background pr-3 pl-3 outline-none hover:bg-muted focus-visible:bg-muted",
        COLUMNS,
        index > 0 && "border-t"
      )}
      style={{ height: TRACE_H, marginTop: before || undefined }}
    >
      <span className="flex min-w-0 items-center gap-1 font-medium">
        <ChevronRightIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} />
        <span className="truncate" title={traceLabel(group)}>
          {n}. {traceLabel(group)}
        </span>
        <span className="shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
          {group.spans.length} {group.spans.length === 1 ? "span" : "spans"}
          {group.errors > 0 && <span className="text-destructive"> · {group.errors} failed</span>}
        </span>
      </span>
      <Axis duration={duration} />
      <span className="text-right text-xs text-muted-foreground tabular-nums">
        {group.end === null ? "…" : fmtMs(duration)}
      </span>
    </div>
  )
}

function Axis({ duration }: { duration: number }) {
  const ticks = niceTicks(duration, 4)
  return (
    <span className="relative h-full" aria-hidden>
      {ticks.map((t) => (
        <span
          key={t}
          className="absolute inset-y-0 text-[10px] text-muted-foreground tabular-nums"
          style={{ left: `${(t / duration) * 100}%` }}
        >
          <span className="absolute inset-y-2 w-px bg-border" />
          <span className={cn("absolute bottom-0 -translate-x-1/2", t === 0 && "translate-x-0", t / duration > 0.9 && "-translate-x-full")}>
            {fmtMs(t)}
          </span>
        </span>
      ))}
    </span>
  )
}

function Row({
  index,
  before,
  node,
  group,
  now,
  selected,
  collapsed,
  onSelect,
  onToggle,
}: {
  index: number
  /** Height of the windowed-out lines above this one, 0 when adjacent. */
  before: number
  node: SpanNode
  group: TraceGroup
  now: number
  selected: boolean
  collapsed: boolean
  onSelect: () => void
  onToggle: () => void
}) {
  const { span, depth } = node
  const Icon = KIND[span.kind].icon
  const win = windowOf(group, now)
  const dur = spanDuration(span, now)
  const usage = span.kind === "model" ? spanUsage(span) : null
  const at = (ms: number) => `${Math.min(100, Math.max(0, ((ms - win.start) / win.duration) * 100))}%`
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={node.children.length ? !collapsed : undefined}
      aria-level={depth + 2}
      tabIndex={0}
      data-index={index}
      data-key={span.spanId}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "grid cursor-pointer items-center gap-2 pr-3 outline-none [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto] focus-visible:bg-muted",
        COLUMNS,
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted"
      )}
      style={{ height: ROW_H, paddingLeft: 12 + depth * 16, marginTop: before || undefined }}
    >
      <span className="flex min-w-0 items-center gap-1">
        {node.children.length ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label={collapsed ? "Expand" : "Collapse"}
            className="grid size-4 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted"
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
          >
            <ChevronRightIcon className={cn("size-3 transition-transform", !collapsed && "rotate-90")} />
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <Icon className={cn("size-3.5 shrink-0", spanText(span))} />
        <span className="truncate" title={span.name}>
          {span.name}
        </span>
        {usage?.output != null && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatTokens(usage.output)} out</span>
        )}
        {span.links?.length ? (
          <span className="shrink-0 text-xs text-muted-foreground" title={`${span.links.length} link(s)`}>
            ⛓{span.links.length}
          </span>
        ) : null}
      </span>
      <span className="relative h-2.5 rounded-full bg-muted">
        <span
          className={cn("absolute inset-y-0 min-w-0.5 rounded-full", spanBg(span), span.end === null && "animate-pulse")}
          style={{ left: at(span.start), width: `${(dur / win.duration) * 100}%` }}
        />
        {span.events.map((event, i) => (
          <span
            key={i}
            title={event.name}
            className="absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground ring-1 ring-background"
            style={{ left: at(event.at) }}
          />
        ))}
      </span>
      <span className="text-right text-xs text-muted-foreground tabular-nums">
        {span.end === null ? "…" : fmtMs(dur)}
      </span>
    </div>
  )
}

function download(name: string, body: string) {
  const href = URL.createObjectURL(new Blob([body], { type: "application/json" }))
  const a = document.createElement("a")
  a.href = href
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoked a tick later — revoking synchronously cancels the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
