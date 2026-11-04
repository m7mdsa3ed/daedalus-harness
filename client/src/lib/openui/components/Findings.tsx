/* ── Findings ──
   What a review hands back: problems, worst first, each with where it is and
   what to do about it. `Rows` is a triage list for anything with a state; this
   is the shape a code review, an audit or a security pass takes, and it earns a
   component because three things are fixed by the genre — a severity scale, a
   `file:line` location, and a fix set apart from the diagnosis. The order is the
   severity's, stably, so a model that lists findings as it found them still
   draws them worst-first.

   It is a reader, not a stack: an index of findings beside the one being read,
   the way a review tool lays out its comments. The index is the scan (severity
   mark, title, location); the pane is the read (the diagnosis and the fix, with
   a step to the next). The index is a vertical tablist — one tab stop, arrows,
   Home and End — and on a panel too narrow for two columns the open finding
   unfolds under its own row instead of beside the list. Picking one is the
   view's own state; nothing is sent. */
import { useId, useState, type KeyboardEvent, type ReactNode } from "react"
import { z } from "zod/v4"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, BoxHeader, LABEL, META, PAD, TITLE, ToneChip, type TONE_DOT } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const
type Severity = (typeof SEVERITIES)[number]

/** Two weights of the destructive token, so critical and high are one family
    and still two steps; the chip's tone is the kit's five. */
const SEVERITY: Record<Severity, { fill: string; tone: keyof typeof TONE_DOT }> = {
  critical: { fill: "bg-destructive", tone: "error" },
  high: { fill: "bg-destructive/55", tone: "error" },
  medium: { fill: "bg-warning", tone: "warn" },
  low: { fill: "bg-primary/60", tone: "info" },
  info: { fill: "bg-muted-foreground/40", tone: "neutral" },
}

type Item = { title: string; severity: Severity; location?: string; text?: string; fix?: string }
type Row = { item: Item; key: number }

export const Findings = defineComponent({
  name: "Findings",
  description:
    "Review findings, worst first: each a title, a severity, an optional file location, the explanation and a suggested fix.",
  props: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        severity: z.enum(SEVERITIES),
        location: z.string().optional(),
        text: z.string().optional(),
        fix: z.string().optional(),
      })
    ),
    title: z.string().optional(),
  }),
  component: ({ props }) => <FindingsView items={props.items} title={props.title} />,
})

function FindingsView({ items: raw, title }: { items?: Partial<Item>[]; title?: string }) {
  const id = useId()
  // The view streams in: a row may exist before its title or severity does.
  // The key is the row's place in the source, which streaming only appends to,
  // so the open finding stays open when a worse one arrives above it.
  const rows: Row[] = (raw ?? [])
    .flatMap((item, key) =>
      item?.title ? [{ item: { ...item, severity: SEVERITIES.includes(item.severity as Severity) ? item.severity : "info" } as Item, key }] : []
    )
    .sort((a, b) => SEVERITIES.indexOf(a.item.severity) - SEVERITIES.indexOf(b.item.severity) || a.key - b.key)
  const [picked, setPicked] = useState<number | null>(null)
  const at = Math.max(0, rows.findIndex((row) => row.key === picked))
  const current = rows[at]

  const counts = SEVERITIES.map((severity) => ({ severity, count: rows.filter((row) => row.item.severity === severity).length })).filter(
    (entry) => entry.count > 0
  )
  const summary = rows.length > 0 ? `${rows.length} ${rows.length === 1 ? "finding" : "findings"} · ${counts.map((c) => `${c.count} ${c.severity}`).join(", ")}` : undefined

  const go = (index: number, focus = false) => {
    const row = rows[(index + rows.length) % rows.length]
    if (!row) return
    setPicked(row.key)
    if (focus) document.getElementById(`${id}-tab-${row.key}`)?.focus()
  }
  const onKey = (event: KeyboardEvent) => {
    const step = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[event.key]
    if (step === undefined) return
    event.preventDefault()
    go(step, true)
  }

  return (
    <Box>
      <BoxHeader title={title || "Findings"} meta={summary} />
      {rows.length > 0 && (
        <div aria-hidden className="flex h-1 w-full gap-px bg-border/40">
          {counts.map(({ severity, count }) => (
            <span
              key={severity}
              className={cn(SEVERITY[severity].fill, "transition-[width] duration-500 ease-out motion-reduce:transition-none")}
              style={{ width: `${(count / rows.length) * 100}%` }}
            />
          ))}
        </div>
      )}
      {current && (
        <div className="grid min-w-0 @panel-sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
          <ol
            role="tablist"
            aria-orientation="vertical"
            aria-label="Findings"
            onKeyDown={onKey}
            className="min-w-0 list-none divide-y divide-border/50 @panel-sm:max-h-[32rem] @panel-sm:overflow-y-auto @panel-sm:border-e @panel-sm:border-border/70"
          >
            {rows.map((row, index) => {
              const selected = index === at
              return (
                <li key={row.key} role="presentation" className="min-w-0">
                  <button
                    type="button"
                    role="tab"
                    id={`${id}-tab-${row.key}`}
                    aria-selected={selected}
                    aria-controls={selected ? `${id}-pane ${id}-inline-${row.key}` : `${id}-pane`}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => setPicked(row.key)}
                    className={cn(
                      "relative flex w-full min-w-0 items-start gap-2.5 px-3.5 py-2.5 text-start transition-colors outline-none @panel-sm:px-4",
                      "hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      selected && "bg-muted/60 hover:bg-muted/60"
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn("mt-1 h-3.5 shrink-0 rounded-full transition-[width]", selected ? "w-1.5" : "w-1", SEVERITY[row.item.severity].fill)}
                    />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="sr-only">{row.item.severity}: </span>
                      <span className={cn("line-clamp-2 text-[length:var(--text-sm,0.875rem)] leading-snug break-words", selected ? "font-semibold text-foreground" : "font-medium text-foreground/85")}>
                        <RichText text={row.item.title} />
                      </span>
                      {row.item.location && <span className={cn(META, "block truncate font-mono text-[0.75rem]")}>{row.item.location}</span>}
                    </span>
                  </button>
                  {selected && (
                    <div id={`${id}-inline-${row.key}`} role="tabpanel" aria-labelledby={`${id}-tab-${row.key}`} className="border-t border-border/50 bg-muted/20 @panel-sm:hidden">
                      <Detail item={row.item} position={index + 1} total={rows.length} onStep={(d) => go(at + d)} compact />
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
          <div id={`${id}-pane`} role="tabpanel" aria-labelledby={`${id}-tab-${current.key}`} className="hidden min-w-0 @panel-sm:block">
            <Detail item={current.item} position={at + 1} total={rows.length} onStep={(d) => go(at + d)} />
          </div>
        </div>
      )}
    </Box>
  )
}

function Detail({
  item,
  position,
  total,
  onStep,
  compact,
}: {
  item: Item
  position: number
  total: number
  onStep: (delta: number) => void
  compact?: boolean
}) {
  return (
    <article className={cn("min-w-0 space-y-3.5", compact ? "px-3.5 py-3" : PAD)}>
      <header className="flex min-w-0 items-center justify-between gap-3">
        <ToneChip text={item.severity} tone={SEVERITY[item.severity].tone} />
        {total > 1 && (
          <span className="flex items-center gap-0.5">
            <span className={cn(META, "me-1 tabular-nums")}>
              {position} / {total}
            </span>
            <StepButton label="Previous finding" onClick={() => onStep(-1)}>
              <ChevronLeft className="size-4" />
            </StepButton>
            <StepButton label="Next finding" onClick={() => onStep(1)}>
              <ChevronRight className="size-4" />
            </StepButton>
          </span>
        )}
      </header>
      {/* The index already says the title on a phone, right above this. */}
      {!compact && (
        <div className="min-w-0 space-y-1">
          <h4 className={TITLE}>
            <RichText text={item.title} />
          </h4>
          {item.location && <p className={cn(META, "font-mono text-[0.75rem] break-all")}>{item.location}</p>}
        </div>
      )}
      {compact && item.location && <p className={cn(META, "font-mono text-[0.75rem] break-all")}>{item.location}</p>}
      {item.text && (
        <p className={cn(BODY, "text-pretty")}>
          <RichText text={item.text} />
        </p>
      )}
      {item.fix && (
        <div className="min-w-0 space-y-1 border-s-2 border-success/60 ps-3">
          <p className={cn(LABEL, "text-success")}>Fix</p>
          <p className={cn(BODY, "text-pretty")}>
            <RichText text={item.fix} />
          </p>
        </div>
      )}
    </article>
  )
}

function StepButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:size-9"
    >
      {children}
    </button>
  )
}
