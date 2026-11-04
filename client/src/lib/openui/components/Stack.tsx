/* ── Stack ──
   `root` is the container the prompt insists on wrapping every program in:
   vertical by default, a wrapping grid for a cluster of cards. The panel's
   width decides the columns, never the window's, so a two-up is a two-up only
   where there is room for two. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { FLOW } from "@/lib/openui/kit"

export const Stack = defineComponent({
  name: "Stack",
  description: "Vertical container. The root element every OpenUI program starts from.",
  props: z.object({
    children: z.array(z.any()),
    direction: z.enum(["column", "row"]).optional(),
    gap: z.enum(["sm", "md", "lg"]).optional(),
  }),
  component: ({ props, renderNode }) => (
    <div
      className={cn(
        "w-full min-w-0",
        props.direction === "row"
          ? "grid grid-cols-1 items-start gap-2.5 @panel-sm:grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] @panel-sm:gap-3"
          : FLOW,
        props.gap === "sm" && "gap-1.5 @panel-sm:gap-2",
        props.gap === "lg" && "gap-5 @panel-sm:gap-6"
      )}
    >
      {renderNode(props.children)}
    </div>
  ),
})
