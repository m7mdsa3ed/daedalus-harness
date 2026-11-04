/* ── Divider ──
   A rule between two runs of a view that are not framed. Thinner and lighter
   than a frame's hairline: a divider is punctuation, not an edge. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Rule } from "@/lib/openui/kit"

export const Divider = defineComponent({
  name: "Divider",
  description: "A horizontal rule.",
  props: z.object({}),
  component: () => <Rule />,
})
