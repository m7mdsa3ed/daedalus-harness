/* ── Details ──
   A folded section: native `<details>`, so it needs no state and survives the
   streaming re-render. The summary is the band a `Card`'s header would be, and
   the marker turns rather than swapping glyphs. */
import { z } from "zod/v4"
import { ChevronRight } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, FLOW, PAD_ROW, WELL_PAD } from "@/lib/openui/kit"

export const Details = defineComponent({
  name: "Details",
  description: "A collapsible section, closed unless `open` is true.",
  props: z.object({
    summary: z.string(),
    children: z.array(z.any()),
    open: z.boolean().optional(),
  }),
  component: ({ props, renderNode }) => (
    <Box>
      <details open={props.open} className="group/details">
        <summary
          className={cn(
            "flex cursor-pointer list-none items-center gap-1.5 text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] leading-snug font-medium select-none hover:bg-wash-strong [&::-webkit-details-marker]:hidden",
            PAD_ROW
          )}
        >
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none group-open/details:rotate-90" />
          <span className="min-w-0 break-words">{props.summary}</span>
        </summary>
        <div className={cn(FLOW, "border-t border-rule", WELL_PAD)}>{renderNode(props.children)}</div>
      </details>
    </Box>
  ),
})
