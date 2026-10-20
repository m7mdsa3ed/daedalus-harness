/* ── The Trajectory ──
   One thread's OpenTelemetry spans (`GET /api/sessions/:id/spans`) as a
   waterfall: every turn a root, the prompt request, model generations, tool
   calls, permission waits and subagents nested under it, each drawn as a bar
   across its turn's window. Totals across the top, an overview strip coloured
   by kind under them, and the selected span whole beside the list (or in its
   place, on a narrow panel).

   One component for both doors — the thread dock's panel and the
   `/t/:id/trace` page — reflowing on its own box (`@panel-md:`), never the
   window. The readers are `lib/trajectory.ts`; this file only draws. */
import * as React from "react"
import {
  ChevronRightIcon,
  DownloadIcon,
  RefreshCwIcon,
  RouteIcon,
  SearchIcon,
  ArrowDownToLineIcon,
} from "lucide-react"
import type { TraceSpan, TraceSpanKind } from "@daedalus/protocol"

import { ErrorNote } from "@/components/error-note"
import { Empty } from "@/components/empty"
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
  spanDuration,
  spanEnd,
  spanUsage,
  totals as sumTotals,
  visibleRows,
  type SpanNode,
} from "@/lib/trajectory"
import { cn } from "@/lib/utils"
import { useFocusedRow, useWindowedRows } from "@/lib/windowed-rows"
import { KIND, fmtMs, spanBg, spanText } from "./kinds"
import { SpanDetail } from "./span-detail"

const EMPTY: TraceSpan[] = []

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
  const needle = search.trim()
  const rows = React.useMemo(
    () => visibleRows(flatten(roots, needle ? new Set() : collapsed), byId, needle, hidden),
    [roots, collapsed, byId, needle, hidden]
  )
  const turns = React.useMemo(() => roots.filter((n) => n.span.kind === "turn"), [roots])
  const turnNo = React.useMemo(() => new Map(turns.map((n, i) => [n.span.spanId, i + 1])), [turns])
  const kinds = React.useMemo(
    () => (Object.keys(KIND) as TraceSpanKind[]).filter((k) => k !== "turn" && spans.some((s) => s.kind === k)),
    [spans]
  )
  const totals = React.useMemo(() => sumTotals(spans, now), [spans, now])
  const selected = selectedId ? byId.get(selectedId) ?? null : null

  /* Past 200 rows only the window is drawn (and re-rendered per `now` tick);
     the selected and focused rows are pinned, so reveal() and focus keep their
     element. A root row past the first is h-7 plus its 4px top margin. */
  const [focusIndex, onListFocus] = useFocusedRow(rows.length, (i) => rows[i].span.spanId)
  const selectedIndex = React.useMemo(
    () => (selectedId ? rows.findIndex((n) => n.span.spanId === selectedId) : -1),
    [rows, selectedId]
  )
  const w = useWindowedRows({
    count: rows.length,
    threshold: 200,
    list: listRef,
    estimateSize: (i) => (rows[i].depth === 0 && i > 0 ? 32 : 28),
    getItemKey: (i) => rows[i].span.spanId,
    pin: [selectedIndex, focusIndex],
  })
  /** Each node's place among its tree siblings, for aria-posinset/setsize. */
  const siblings = React.useMemo(() => {
    const map = new Map<string, [number, number]>()
    const walk = (nodes: SpanNode[]) =>
      nodes.forEach((n, i) => {
        map.set(n.span.spanId, [i + 1, nodes.length])
        walk(n.children)
      })
    walk(roots)
    return map
  }, [roots])

  /* Follow: the newest row stays in view while the turn runs. Scrolling up is
     reading, and stops it. */
  React.useEffect(() => {
    const list = listRef.current
    if (follow && live && list) list.scrollTop = list.scrollHeight
  }, [follow, live, rows])

  const reveal = (spanId: string) => {
    setSelectedId(spanId)
    setFollow(false)
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector(`[data-span-id="${CSS.escape(spanId)}"]`)
        ?.scrollIntoView({ block: "nearest" })
    )
  }

  const fetchWhole = useFetchWholeSpans(sessionId)
  const [exporting, setExporting] = React.useState(false)
  const exportSpans = () => {
    setExporting(true)
    fetchWhole(spans)
      .then((whole) => download(`trajectory-${sessionId}.json`, JSON.stringify({ sessionId, spans: whole }, null, 2)))
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
      {/* Toolbar: search, turn jump, follow, refresh, export. */}
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
        {turns.length > 1 && (
          <NativeSelect
            size="sm"
            aria-label="Jump to a turn"
            className="max-w-40"
            value=""
            onChange={(event) => event.target.value && reveal(event.target.value)}
          >
            <NativeSelectOption value="">Jump to turn…</NativeSelectOption>
            {turns.map((n, i) => (
              <NativeSelectOption key={n.span.spanId} value={n.span.spanId}>
                {`${i + 1}. ${turnLabel(n.span)}`.slice(0, 60)}
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
          title="Export the spans as JSON"
          aria-label="Export the spans as JSON"
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
            <Kpis totals={totals} />
            <Overview roots={roots} now={now} selectedId={selectedId} onPick={reveal} />
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
              aria-label="Spans"
              onWheel={(event) => event.deltaY < 0 && setFollow(false)}
              onFocus={onListFocus}
              className={cn("min-h-0 flex-1 overflow-y-auto py-1", selected && "hidden @panel-md:block")}
            >
              {rows.length === 0 ? (
                <div className="p-3">
                  <Empty>No span matches.</Empty>
                </div>
              ) : (
                w.rows.map(({ index, key, before }) => {
                  const node = rows[index]
                  return (
                    <Row
                      key={key}
                      index={index}
                      before={before}
                      set={w.windowed ? siblings.get(node.span.spanId) : undefined}
                      node={node}
                      now={now}
                      turn={turnNo.get(node.span.spanId)}
                      selected={node.span.spanId === selectedId}
                      collapsed={collapsed.has(node.span.spanId)}
                      onSelect={() => setSelectedId(node.span.spanId)}
                      onToggle={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev)
                          if (!next.delete(node.span.spanId)) next.add(node.span.spanId)
                          return next
                        })
                      }
                    />
                  )
                })
              )}
              {w.after > 0 && <div aria-hidden style={{ height: w.after }} />}
            </div>
            <div
              className={cn(
                "min-h-0 overflow-y-auto @panel-md:w-[45%] @panel-md:shrink-0 @panel-md:border-l",
                selected ? "flex-1 @panel-md:flex-none" : "hidden @panel-md:block"
              )}
            >
              {selected ? (
                <SpanDetail
                  key={selected.spanId}
                  sessionId={sessionId}
                  spans={spans}
                  span={selected}
                  live={live}
                  onClose={() => setSelectedId(null)}
                />
              ) : (
                <p className="p-4 text-muted-foreground">Select a span to read its timing, payloads and attributes.</p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
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

const turnLabel = (span: TraceSpan) => {
  const prompt = span.attributes["daedalus.prompt"]
  return typeof prompt === "string" && prompt.trim() ? prompt.trim().replace(/\s+/g, " ") : span.name
}

function Kpis({ totals: t }: { totals: ReturnType<typeof sumTotals> }) {
  const cells: [string, string, boolean?][] = [
    ["Turns", String(t.turns)],
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

/* ── The overview strip ──
   Every root laid end to end, each as wide as it lasted (the idle gaps
   between turns are cut out — hours of nothing would flatten the work to a
   hairline), and inside it the model, tool and permission spans in three
   lanes. A click on a segment jumps to it. */
const LANE: Partial<Record<TraceSpanKind, number>> = { model: 0, tool: 1, permission: 2, shell: 2 }

function Overview({
  roots,
  now,
  selectedId,
  onPick,
}: {
  roots: SpanNode[]
  now: number
  selectedId: string | null
  onPick: (spanId: string) => void
}) {
  return (
    <div className="flex h-8 gap-px border-b px-3 py-1.5" aria-hidden>
      {roots.map((root) => {
        const start = root.span.start
        const dur = Math.max(1, spanDuration(root.span, now))
        const marks: TraceSpan[] = []
        const walk = (node: SpanNode) => {
          if (LANE[node.span.kind] !== undefined) marks.push(node.span)
          node.children.forEach(walk)
        }
        walk(root)
        return (
          <button
            key={root.span.spanId}
            type="button"
            tabIndex={-1}
            title={turnLabel(root.span)}
            onClick={() => onPick(root.span.spanId)}
            style={{ flexGrow: dur }}
            className={cn(
              "relative min-w-1 basis-0 overflow-hidden rounded-md bg-muted hover:bg-muted",
              root.span.spanId === selectedId && "ring-1 ring-ring"
            )}
          >
            {marks.map((span) => (
              <span
                key={span.spanId}
                className={cn("absolute h-1/3 min-w-px", spanBg(span))}
                style={{
                  left: `${((span.start - start) / dur) * 100}%`,
                  width: `${(spanDuration(span, now) / dur) * 100}%`,
                  top: `${(LANE[span.kind]! * 100) / 3}%`,
                }}
              />
            ))}
          </button>
        )
      })}
    </div>
  )
}

function Row({
  index,
  before,
  set,
  node,
  now,
  turn,
  selected,
  collapsed,
  onSelect,
  onToggle,
}: {
  index: number
  /** Height of the windowed-out rows above this one, 0 when adjacent. */
  before: number
  /** [posinset, setsize] among its tree siblings, only while windowed. */
  set: [number, number] | undefined
  node: SpanNode
  now: number
  turn: number | undefined
  selected: boolean
  collapsed: boolean
  onSelect: () => void
  onToggle: () => void
}) {
  const { span, root, depth } = node
  const Icon = KIND[span.kind].icon
  const rootStart = root.start
  const rootDur = Math.max(1, spanEnd(root, now) - rootStart)
  const dur = spanDuration(span, now)
  const usage = span.kind === "model" || span.kind === "turn" ? spanUsage(span) : null
  const isRoot = depth === 0
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={node.children.length ? !collapsed : undefined}
      aria-level={depth + 1}
      aria-posinset={set?.[0]}
      aria-setsize={set?.[1]}
      tabIndex={0}
      data-index={index}
      data-span-id={span.spanId}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "grid h-7 cursor-pointer grid-cols-[minmax(0,1fr)_minmax(3rem,35%)_3.5rem] items-center gap-2 pr-3 outline-none [contain-intrinsic-size:auto_1.75rem] [content-visibility:auto] focus-visible:bg-muted",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted",
        isRoot && "font-medium",
        isRoot && index > 0 && "border-t"
      )}
      style={{ paddingLeft: 12 + depth * 20, marginTop: before + (isRoot && index > 0 ? 4 : 0) || undefined }}
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
          {turn !== undefined ? `Turn ${turn} · ${turnLabel(span)}` : span.name}
        </span>
        {usage?.output != null && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatTokens(usage.output)} out
          </span>
        )}
      </span>
      <span className="relative h-2.5 rounded-full bg-muted">
        <span
          className={cn("absolute inset-y-0 min-w-0.5 rounded-full", spanBg(span), span.end === null && "animate-pulse")}
          style={{
            left: `${((span.start - rootStart) / rootDur) * 100}%`,
            width: `${(dur / rootDur) * 100}%`,
          }}
        />
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
