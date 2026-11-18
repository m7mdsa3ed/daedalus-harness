/* ── Stack ──
   `root` is the container the prompt insists on wrapping every program in:
   a column by default, or with `direction: "row"` a wrapping line sized to its
   content (buttons, badges, a label beside a figure) — which is what `Row` was.
   Equal columns are `Grid`'s, which reflows on the panel's width. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { FLOW } from "@/lib/openui/kit"

export const Stack = defineComponent({
  name: "Stack",
  description:
    "Vertical container and the root of every program. `direction` \"row\" is a wrapping line of children sized to their content (buttons, badges), aligned by `align`.",
  props: z.object({
    children: z.array(z.any()),
    direction: z.enum(["column", "row"]).optional(),
    gap: z.enum(["sm", "md", "lg"]).optional(),
    align: z.enum(["start", "center", "end", "between"]).optional(),
  }),
  component: ({ props, renderNode }) => (
    <div
      className={cn(
        "w-full min-w-0",
        props.direction === "row" ? "openui-flow flex flex-wrap items-center gap-2 @panel-sm:gap-2.5 [&>*]:max-w-full [&>*]:min-w-0" : FLOW,
        props.direction === "row" && props.align === "center" && "justify-center",
        props.direction === "row" && props.align === "end" && "justify-end",
        props.direction === "row" && props.align === "between" && "justify-between",
        props.gap === "sm" && "gap-1.5 @panel-sm:gap-2",
        props.gap === "lg" && "gap-5 @panel-sm:gap-6"
      )}
    >
      {renderNode(props.children)}
    </div>
  ),
})
