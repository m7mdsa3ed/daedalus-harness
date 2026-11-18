/* ── Card ──
   The one frame. The header is a band of its own, the body the one flow. It is
   `Box` plus a name, which is why a `Card` inside a `Card` is a well with a
   heading rather than a second frame. An empty title draws no band, so an
   untitled tile is the same card. `tone` tints it and dots the title (a status
   tile — what `Panel` was), `footer` is a source line under a hairline, and
   `span` crosses every column of the `Grid` it sits in. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, BoxHeader, FLOW, META, TONE_DOT, TONE_TINT, TONES, WELL_PAD } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const Card = defineComponent({
  name: "Card",
  description:
    "A titled frame holding children. An empty title draws no header. `tone` (neutral, info, success, warn, error) tints it and dots the title for a status tile, `footer` is a source or timestamp line, `span` 2+ crosses every column of a Grid.",
  props: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    children: z.array(z.any()),
    tone: z.enum(TONES).optional(),
    footer: z.string().optional(),
    span: z.number().optional(),
  }),
  component: ({ props, renderNode }) => {
    const tone = props.tone ?? "neutral"
    return (
      <Box className={cn("flex h-full flex-col", TONE_TINT[tone], Math.round(props.span ?? 1) >= 2 && "@panel-sm:col-span-full")}>
        {props.title && (
          <BoxHeader
            title={
              <span className="inline-flex min-w-0 items-center gap-1.5">
                {tone !== "neutral" && <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />}
                <span className="min-w-0 text-balance">{props.title}</span>
              </span>
            }
            meta={props.subtitle}
          />
        )}
        <div className={cn(FLOW, WELL_PAD, "flex-1")}>{renderNode(props.children)}</div>
        {props.footer && (
          <div className={cn(META, "border-t border-rule", WELL_PAD)}>
            <RichText text={props.footer} />
          </div>
        )}
      </Box>
    )
  },
})
