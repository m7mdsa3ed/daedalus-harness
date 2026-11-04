/* ── Agenda ──
   A schedule: a time (or date) in a fixed column, what happens beside it. The
   time column collapses to a line above on a phone. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, META, PAD_ROW } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const Agenda = defineComponent({
  name: "Agenda",
  description: "A schedule: each entry a time, a title and an optional detail or place.",
  props: z.object({
    items: z.array(z.object({ time: z.string(), title: z.string(), text: z.string().optional(), place: z.string().optional() })),
  }),
  component: ({ props }) => (
    <Box>
      <ul className="w-full divide-y divide-border/70">
        {(props.items ?? []).filter((item) => item?.title).map((item, index) => (
          <li key={index} className={cn("grid min-w-0 gap-x-4 gap-y-0.5 @panel-sm:grid-cols-[7rem_1fr]", PAD_ROW)}>
            <span className="text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] font-medium text-primary tabular-nums">{item.time}</span>
            <div className="min-w-0 space-y-0.5">
              <p className="text-[length:calc(var(--text-sm,0.875rem)+0.0625rem)] leading-snug font-medium break-words text-foreground"><RichText text={item.title} /></p>
              {item.place && <p className={META}>{item.place}</p>}
              {item.text && <p className={cn(BODY, "text-pretty text-muted-foreground")}><RichText text={item.text} /></p>}
            </div>
          </li>
        ))}
      </ul>
    </Box>
  ),
})
