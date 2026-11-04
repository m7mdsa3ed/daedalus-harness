/* ── Checks ──
   Results of things that were run or verified: tests, a build, a lint, a health
   probe, a list of requirements. `Plan` is work still to do and `Rows` is a list
   of things needing attention; this is the report after the fact, where each line
   is a name and a pass/fail and the reader's eye wants the failures. It is the
   kit's `StatusRows`, the same row a `Plan` step is, so a report and a checklist
   read as one thing. The glyph is the state by shape as well as by colour, and
   the word is kept for a screen reader. A header sentence and a tally bar total
   them, so a long list still answers "did it pass" before it is read. */
import { z } from "zod/v4"
import { Check, Loader, Minus, TriangleAlert, X } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { Box, BoxHeader, StatusRows, TallyBar, type StatusRow } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const STATES = ["pass", "fail", "warn", "skip", "running"] as const

const STATE = {
  pass: { Icon: Check, tone: "success", word: "passed" },
  fail: { Icon: X, tone: "error", word: "failed" },
  warn: { Icon: TriangleAlert, tone: "warn", word: "warning" },
  skip: { Icon: Minus, tone: "neutral", word: "skipped" },
  running: { Icon: Loader, tone: "info", word: "running" },
} as const satisfies Record<(typeof STATES)[number], Pick<StatusRow, "Icon" | "tone" | "word">>

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
    const counts = STATES.map((state) => ({ state, count: items.filter((item) => item.state === state).length }))
    const summary = counts
      .filter((entry) => entry.count > 0)
      .map(({ state, count }) => `${count} ${STATE[state].word}`)
      .join(", ")
    return (
      <Box>
        <BoxHeader title={props.title || "Checks"} meta={summary || undefined} />
        <TallyBar parts={counts.map(({ state, count }) => ({ tone: STATE[state].tone, count }))} />
        <StatusRows
          items={items.map((item) => {
            const state = STATE[item.state] ?? STATE.skip
            return {
              ...state,
              spin: item.state === "running",
              name: <RichText text={item.name} />,
              detail: item.detail ? <RichText text={item.detail} /> : undefined,
            }
          })}
        />
      </Box>
    )
  },
})
