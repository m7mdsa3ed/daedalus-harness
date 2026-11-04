/**
 * A triage list. One row is a thing that needs something done about it — an
 * issue, a ticket, a PR, a follow-up, a source — so its name comes first, its
 * state is a chip, and what qualifies it, what it says and where it lives
 * follow. A `Table` is the right shape when every row is one line of a few
 * cells; this is the shape a row takes when two of the cells are paragraphs,
 * which is what a five-column table of triage turned out to be.
 *
 * It is a list, not a frame: inside a `Card` its rows sit on the card's ground
 * under the card's one inset, and beside prose its lines reach the margin the
 * words do.
 */
import { z } from "zod/v4"
import { ArrowUpRight } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, META, ToneChip } from "@/lib/openui/kit"
import { LinkAnchor, linkTarget, RichText } from "@/lib/openui/rich-text"
import { dominantTextDir } from "@/lib/text-direction"

export const Rows = defineComponent({
  name: "Rows",
  description: "A triage list: each row a name, an optional state chip, a line of facts, a detail and a link out.",
  props: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        status: z.string().optional(),
        tone: z.enum(["neutral", "info", "success", "warn", "error"]).optional(),
        meta: z.string().optional(),
        text: z.string().optional(),
        href: z.string().optional(),
      })
    ),
  }),
  component: ({ props }) => (
    <div className="w-full divide-y divide-border/70 rounded-lg border border-border/70">
      {props.items.map((item, index) => {
        const url = linkTarget(item.href)
        const facts = [item.meta, url?.host].filter(Boolean).join(" · ")
        return (
          <div key={index} className={cn("min-w-0 space-y-1 px-3.5 py-3 transition-colors duration-150 @panel-sm:px-4", url && "hover:bg-muted/30")}>
            {/* The name starts every row at the same margin and the state sits
                at the end of it: a chip in front sized each title differently
                (`urgent` is wider than `high`), so a column of rows read as a
                ragged column of headings. */}
            <div className="flex min-w-0 flex-col items-start gap-x-3 gap-y-1.5 @panel-sm:flex-row @panel-sm:justify-between">
              {url ? (
                <LinkAnchor
                  url={url}
                  underline={false}
                  className="flex min-w-0 items-start gap-1 text-[length:calc(var(--text-sm,0.875rem)+0.0625rem)] leading-snug font-semibold underline-offset-2 hover:underline"
                >
                  <span dir={dominantTextDir(item.title)} className="min-w-0 break-words text-start">{item.title}</span>
                  <ArrowUpRight className="mt-0.5 size-3 shrink-0" />
                </LinkAnchor>
              ) : (
                <span dir={dominantTextDir(item.title)} className="min-w-0 text-start text-[length:calc(var(--text-sm,0.875rem)+0.0625rem)] leading-snug font-semibold break-words text-foreground">
                  <RichText text={item.title} />
                </span>
              )}
              {item.status && (
                <span className="shrink-0">
                  <ToneChip text={item.status} tone={item.tone} />
                </span>
              )}
            </div>
            {facts && (
              <p dir={dominantTextDir(facts)} className={cn(META, "text-start text-pretty")}>
                <RichText text={facts} />
              </p>
            )}
            {item.text && (
              <p dir={dominantTextDir(item.text)} className={cn(BODY, "text-start text-pretty text-muted-foreground")}>
                <RichText text={item.text} />
              </p>
            )}
          </div>
        )
      })}
    </div>
  ),
})
