/* ── Checks ──
   Results of things that were run or verified: tests, a build, a lint, a health
   probe, a list of requirements. `Plan` is work still to do and `Rows` is a list
   of things needing attention; this is the report after the fact, where each line
   is a name and a pass/fail and the reader's eye wants the failures. The glyph
   is the state by shape as well as by colour, and the word is kept for a screen
   reader. A header sentence totals them, so a long list still answers "did it
   pass" before it is read. */
import { z } from "zod/v4"
import { Check, Loader, Minus, TriangleAlert, X } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, BoxHeader, META, PAD_ROW } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const STATES = ["pass", "fail", "warn", "skip", "running"] as const
type CheckState = (typeof STATES)[number]

const STATE = {
  pass: { Icon: Check, tone: "text-success", word: "passed", spin: false },
  fail: { Icon: X, tone: "text-destructive", word: "failed", spin: false },
  warn: { Icon: TriangleAlert, tone: "text-warning", word: "warning", spin: false },
  skip: { Icon: Minus, tone: "text-muted-foreground", word: "skipped", spin: false },
  running: { Icon: Loader, tone: "text-primary", word: "running", spin: true },
} as const

export const Checks = defineComponent({
  name: "Checks",
  description:
    "Results of things run or verified: each a name, a state (pass, fail, warn, skip or running) and an optional detail, under a header that totals them.",
  props: z.object({
    items: z.array(
      z.object({
        name: z.string(),
        state: z.enum(STATES),
        detail: z.string().optional(),
      })
    ),
    title: z.string().optional(),
  }),
  component: ({ props }) => {
    const items = (props.items ?? []).filter((item) => item?.name)
    const summary = STATES.map((state) => ({ state, count: items.filter((item) => item.state === state).length }))
      .filter((entry) => entry.count > 0)
      .map(({ state, count }) => `${count} ${STATE[state].word}`)
      .join(", ")
    return (
      <Box>
        <BoxHeader title={props.title || "Checks"} meta={summary || undefined} />
        {items.length > 0 && (
          <ul className="w-full min-w-0 list-none divide-y">
            {items.map((item, index) => {
              const { Icon, tone, word, spin } = STATE[item.state] ?? STATE.skip
              return (
                <li key={index} className={cn("flex min-w-0 items-start gap-2.5", PAD_ROW)}>
                  <Icon
                    aria-hidden
                    className={cn("mt-[0.2em] size-4 shrink-0", tone, spin && "motion-safe:animate-spin")}
                    strokeWidth={2.5}
                  />
                  <span className="sr-only">{word}:</span>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="min-w-0 text-sm leading-snug font-medium break-words text-foreground">
                      <RichText text={item.name} />
                    </p>
                    {item.detail && (
                      <p className={cn(META, "text-pretty")}>
                        <RichText text={item.detail} />
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Box>
    )
  },
})
