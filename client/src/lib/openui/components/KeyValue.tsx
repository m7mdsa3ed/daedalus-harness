/* ── KeyValue ──
   A definition list, set like a receipt: the name at the start, the value at the
   end, and a value too long for the line wraps under its name on its own — no
   breakpoint, the flex-wrap is the reflow. Inside a frame it is the frame's
   body; beside prose it is a table with no edges. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Box, PAD_ROW } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const KeyValue = defineComponent({
  name: "KeyValue",
  description: "A list of named facts.",
  props: z.object({
    items: z.array(z.object({ key: z.string(), value: z.string() })),
  }),
  component: ({ props }) => (
    <Box>
      <dl className="w-full divide-y divide-border/70">
        {props.items.map((item, index) => (
          <div key={index} className={cn("flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5", PAD_ROW)}>
            <dt className="min-w-0 text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] break-words text-muted-foreground">{item.key}</dt>
            <dd className="ms-auto min-w-0 text-end text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] font-medium break-words text-foreground tabular-nums">
              <RichText text={item.value} />
            </dd>
          </div>
        ))}
      </dl>
    </Box>
  ),
})
