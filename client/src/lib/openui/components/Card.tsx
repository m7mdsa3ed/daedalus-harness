/* ── Card ──
   A titled frame: the header is a band of its own, the body the one flow. It is
   `Box` plus a name, which is why a `Card` inside a `Card` is a well with a
   heading rather than a second frame. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, BoxHeader, FLOW, WELL_PAD } from "@/lib/openui/kit"

export const Card = defineComponent({
  name: "Card",
  description: "A titled panel holding a group of sections.",
  props: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    children: z.array(z.any()),
  }),
  component: ({ props, renderNode }) => (
    <Box>
      <BoxHeader title={props.title} meta={props.subtitle} />
      <div className={cn(FLOW, WELL_PAD)}>{renderNode(props.children)}</div>
    </Box>
  ),
})
