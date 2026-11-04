/* ── Compare ──
   Options side by side: one frame each, name and verdict as its header band,
   pros and cons marked by glyph as well as by colour. Stacks below `@panel-sm`
   rather than shrinking four columns into a phone panel.

   The glyph is what carries the side — a tinted `+` and `−` — because a
   paragraph of green text under a paragraph of red text reads as two more
   sentences of the answer. */
import { z } from "zod/v4"
import { Minus, Plus } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, BoxHeader, PAD, ToneChip } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const Compare = defineComponent({
  name: "Compare",
  description: "Options side by side, each with a name, optional verdict, pros and cons.",
  props: z.object({
    options: z.array(
      z.object({
        name: z.string(),
        verdict: z.string().optional(),
        pros: z.array(z.string()).optional(),
        cons: z.array(z.string()).optional(),
      })
    ),
  }),
  component: ({ props }) => (
    <div className="grid w-full min-w-0 gap-2.5 @panel-sm:grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] @panel-sm:gap-3">
      {props.options.map((option, index) => (
        <Box key={index} className="h-full">
          <BoxHeader title={option.name} meta={option.verdict && <ToneChip text={option.verdict} tone="info" />} />
          <ul className={cn("min-w-0 space-y-2", PAD)}>
            {option.pros?.map((pro, i) => (
              <li key={`p${i}`} className="flex min-w-0 gap-2.5">
                <span className="mt-[0.2em] flex size-4 shrink-0 items-center justify-center rounded-full bg-success/12"><Plus aria-hidden className="size-2.5 text-success" strokeWidth={3.5} /></span>
                <span className={cn(BODY, "min-w-0")}>
                  <RichText text={pro} />
                </span>
              </li>
            ))}
            {option.cons?.map((con, i) => (
              <li key={`c${i}`} className="flex min-w-0 gap-2.5">
                <span className="mt-[0.2em] flex size-4 shrink-0 items-center justify-center rounded-full bg-destructive/12"><Minus aria-hidden className="size-2.5 text-destructive" strokeWidth={3.5} /></span>
                <span className={cn(BODY, "min-w-0")}>
                  <RichText text={con} />
                </span>
              </li>
            ))}
          </ul>
        </Box>
      ))}
    </div>
  ),
})
