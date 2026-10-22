/* How each span kind is drawn: a glyph and a `--chart-*` swatch, the same
   pair in the waterfall, the overview strip and the filter chips. A failed span
   wears the destructive colour whatever its kind. */
import {
  BotIcon,
  BoxIcon,
  CircleDotIcon,
  CpuIcon,
  FootprintsIcon,
  LayersIcon,
  MessageSquareIcon,
  ShieldQuestionIcon,
  SparklesIcon,
  SquareTerminalIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"
import type { TraceSpan, TraceSpanKind, TraceSpanOtelKind } from "@daedalus/protocol"

export const KIND: Record<TraceSpanKind, { label: string; icon: LucideIcon; bg: string; text: string }> = {
  turn: { label: "Turn", icon: MessageSquareIcon, bg: "bg-muted-foreground/50", text: "text-muted-foreground" },
  request: { label: "Request", icon: LayersIcon, bg: "bg-chart-5", text: "text-chart-5" },
  agent: { label: "Agent", icon: BotIcon, bg: "bg-chart-4", text: "text-chart-4" },
  step: { label: "Step", icon: FootprintsIcon, bg: "bg-chart-4", text: "text-chart-4" },
  model: { label: "Model", icon: SparklesIcon, bg: "bg-chart-1", text: "text-chart-1" },
  tool: { label: "Tool", icon: WrenchIcon, bg: "bg-chart-2", text: "text-chart-2" },
  permission: { label: "Permission", icon: ShieldQuestionIcon, bg: "bg-chart-3", text: "text-chart-3" },
  process: { label: "Process", icon: CpuIcon, bg: "bg-chart-5", text: "text-chart-5" },
  session: { label: "Session", icon: BoxIcon, bg: "bg-chart-5", text: "text-chart-5" },
  shell: { label: "Shell", icon: SquareTerminalIcon, bg: "bg-chart-3", text: "text-chart-3" },
  other: { label: "Other", icon: CircleDotIcon, bg: "bg-muted-foreground/40", text: "text-muted-foreground" },
}

/** OTel's own `SpanKind`, as the spec words it. */
export const OTEL_KIND_LABEL: Record<TraceSpanOtelKind, string> = {
  internal: "Internal",
  server: "Server",
  client: "Client",
  producer: "Producer",
  consumer: "Consumer",
}

export const spanBg = (span: TraceSpan) => (span.status === "error" ? "bg-destructive" : KIND[span.kind].bg)
export const spanText = (span: TraceSpan) => (span.status === "error" ? "text-destructive" : KIND[span.kind].text)

/** `340ms`, `4.2s`, `2m 3s`. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** Wall clock to the millisecond. */
export function fmtClock(at: number): string {
  const d = new Date(at)
  return `${d.toLocaleTimeString(undefined, { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`
}
