/* ── List ──
   Short lines, and every list of records the library draws. One shape covers
   what used to be seven components: a line (`text`), what qualifies it
   (`meta`), a state chip (`state` + `tone`) and somewhere it goes (`href`).
   That is a glossary entry (term over definition), a key and its value, a
   triage row, a route, an agenda entry, a person and a link — the differences
   between them were which field the words sat in, not the drawing.

   The line is `text` and the qualifier `meta`, drawn under it — which is the
   one arrangement all seven wanted at the width a panel actually has. A row
   with `href` is the only thing in a drawn answer that opens a tab, and the
   host is shown because the reader deserves to know where a click goes before
   they make it.

   `code` is a copyable well under the row — a how-to step's command, which is
   what `Steps` was; a plan, a run's results and a review's findings are rows
   with a `state`, which is what `Checks` and `Findings` were. A title is the
   `Card` the list sits in.

   A status word the list knows (done, pass, fail, warn, running, pending…) is
   drawn the way an agent's plan is — a glyph where the bullet was, the word
   kept for a screen reader — so a run's results scan by shape. Any other word
   (a severity, a label) is a chip after the text. A numbered list of rich rows
   is a stepper: circled numbers on a rail, which is how a how-to reads. */
import { z } from "zod/v4"
import { ArrowRight, ArrowUpRight, Check, Circle, Loader, Minus, TriangleAlert, X, type LucideIcon } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, CodeWell, LIST_ROW, META, TONE_TEXT, ToneChip, TONES } from "@/lib/openui/kit"
import { LinkAnchor, linkTarget, RichText } from "@/lib/openui/rich-text"

type Tone = (typeof TONES)[number]

/** The status words drawn as a glyph, and the tone each implies when the
    model gave none. `dim` is work that no longer asks to be read. */
const GLYPHS: Record<string, { Icon: LucideIcon; tone: Tone; spin?: boolean; dim?: boolean }> = {}
for (const [words, glyph] of [
  [["done", "pass", "passed", "ok", "yes", "success", "complete", "completed", "fixed"], { Icon: Check, tone: "success", dim: true }],
  [["fail", "failed", "error", "no", "blocked", "broken"], { Icon: X, tone: "error" }],
  [["warn", "warning", "partial", "flaky"], { Icon: TriangleAlert, tone: "warn" }],
  [["running"], { Icon: Loader, tone: "info", spin: true }],
  [["active", "in progress", "doing", "next"], { Icon: ArrowRight, tone: "info" }],
  [["pending", "todo", "to do", "queued"], { Icon: Circle, tone: "neutral" }],
  [["skip", "skipped", "n/a"], { Icon: Minus, tone: "neutral", dim: true }],
] as const)
  for (const word of words) GLYPHS[word] = glyph

export const List = defineComponent({
  name: "List",
  description:
    "Lines and lists of records: each item a `text`, an optional `meta` line under it, a `state` word drawn as a chip in its `tone`, an `href` it opens, and a copyable `code` block (with its `language`). Numbered with `numbered`.",
  props: z.object({
    items: z.array(
      z.object({
        text: z.string(),
        meta: z.string().optional(),
        state: z.string().optional(),
        tone: z.enum(TONES).optional(),
        href: z.string().optional(),
        code: z.string().optional(),
        language: z.string().optional(),
      })
    ),
    numbered: z.boolean().optional(),
  }),
  component: ({ props }) => {
    const items = (props.items ?? []).filter((item) => item?.text)
    const Tag = props.numbered ? "ol" : "ul"
    const rich = items.some((item) => item.meta || item.href || item.state || item.code)
    const rail = props.numbered && rich
    return (
      <Tag className={cn("w-full min-w-0 list-none", rail ? "" : rich ? "divide-y divide-rule" : "space-y-1")}>
        {items.map((item, index) => {
          const url = linkTarget(item.href)
          const glyph = item.state ? GLYPHS[item.state.trim().toLowerCase()] : undefined
          const tone = item.tone ?? glyph?.tone
          const last = index === items.length - 1
          return (
            <li key={index} className={cn("flex min-w-0 items-start gap-2.5", rail ? "pb-4 last:pb-0" : rich && LIST_ROW)}>
              {rail ? (
                <span aria-hidden className="flex shrink-0 flex-col items-center self-stretch">
                  <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[0.6875rem] leading-none font-medium tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  {!last && <span className="mt-1 -mb-3 w-px flex-1 bg-rule" />}
                </span>
              ) : glyph ? (
                <glyph.Icon
                  aria-hidden
                  className={cn("mt-[0.2em] size-4 shrink-0", TONE_TEXT[tone ?? "neutral"], glyph.spin && "motion-safe:animate-spin")}
                  strokeWidth={2.5}
                />
              ) : props.numbered ? (
                <span aria-hidden className="mt-[0.35em] w-4 shrink-0 text-center text-[0.6875rem] leading-none font-medium tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
              ) : (
                <span aria-hidden className="mt-[0.6em] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
              )}
              <div className="min-w-0 flex-1 space-y-0.5">
                <span className={cn(BODY, "flex min-w-0 flex-wrap items-baseline gap-x-2", rich && "font-medium", glyph?.dim && "text-muted-foreground")}>
                  {glyph && <span className="sr-only">{item.state}: </span>}
                  {url ? (
                    <LinkAnchor url={url} underline={false} className="min-w-0 hover:underline">
                      <RichText text={item.text} />
                    </LinkAnchor>
                  ) : (
                    <span className="min-w-0">
                      <RichText text={item.text} />
                    </span>
                  )}
                  {url && <ArrowUpRight aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
                  {item.state && !glyph && <ToneChip text={item.state} tone={tone} />}
                </span>
                {item.meta && (
                  <span className={cn(META, "block text-pretty")}>
                    <RichText text={item.meta} />
                  </span>
                )}
                {item.code && (
                  <div className="pt-1.5">
                    <Box className="bg-muted/50">
                      <CodeWell code={item.code} language={item.language} />
                    </Box>
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </Tag>
    )
  },
})
