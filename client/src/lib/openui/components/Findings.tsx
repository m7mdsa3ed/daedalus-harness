/* ── Findings ──
   What a review hands back: problems, worst first, each with where it is and
   what to do about it. `Rows` is a triage list for anything with a state; this
   is the shape a code review, an audit or a security pass takes, and it earns a
   component because three things are fixed by the genre — a severity scale, a
   `file:line` location in a monospace line of its own, and a fix set apart from
   the diagnosis. The order is the severity's, stably, so a model that lists
   findings as it found them still draws them worst-first. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, BoxHeader, INSET, LABEL, META, PAD_ROW, ToneChip, type TONE_DOT } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const
type Severity = (typeof SEVERITIES)[number]

const SEVERITY: Record<Severity, { tone: keyof typeof TONE_DOT }> = {
  critical: { tone: "error" },
  high: { tone: "error" },
  medium: { tone: "warn" },
  low: { tone: "info" },
  info: { tone: "neutral" },
}

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
  component: ({ props }) => {
    // The view streams in: a row may exist before its title or severity does.
    const items = (props.items ?? [])
      .filter((item) => item?.title)
      .map((item, index) => ({ item, index, rank: Math.max(0, SEVERITIES.indexOf(item.severity)) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map(({ item }) => item)
    const counts = SEVERITIES.map((severity) => ({
      severity,
      count: items.filter((item) => item.severity === severity).length,
    })).filter((entry) => entry.count > 0)
    return (
      <Box>
        <BoxHeader
          title={props.title || "Findings"}
          meta={
            counts.length > 0 && (
              <span className="flex min-w-0 flex-wrap gap-1.5 pt-0.5">
                {counts.map(({ severity, count }) => (
                  <ToneChip key={severity} text={`${count} ${severity}`} tone={SEVERITY[severity].tone} />
                ))}
              </span>
            )
          }
        />
        {items.length > 0 && (
          <ol className="w-full min-w-0 list-none divide-y">
            {items.map((item, index) => (
              <li key={index} className={cn("min-w-0 space-y-1.5", PAD_ROW)}>
                <div className="flex min-w-0 items-start justify-between gap-x-3">
                  <span className="min-w-0 text-sm leading-snug font-medium break-words text-foreground">
                    <RichText text={item.title} />
                  </span>
                  <span className="shrink-0">
                    <ToneChip text={item.severity} tone={SEVERITY[item.severity]?.tone} />
                  </span>
                </div>
                {item.location && <p className={cn(META, "font-mono break-all")}>{item.location}</p>}
                {item.text && (
                  <p className={cn(BODY, "text-pretty")}>
                    <RichText text={item.text} />
                  </p>
                )}
                {item.fix && (
                  <div className={cn(INSET, "min-w-0 space-y-0.5 px-3 py-2")}>
                    <p className={LABEL}>Suggested fix</p>
                    <p className={cn(BODY, "text-pretty")}>
                      <RichText text={item.fix} />
                    </p>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </Box>
    )
  },
})
