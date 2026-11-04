/* ── Kanban ──
   Work grouped by state: columns of cards. Columns sit side by side only where
   the panel has room for them; on a phone they stack, each with its count. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, INSET, LABEL, META } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const Kanban = defineComponent({
  name: "Kanban",
  description: "Work grouped by state: columns, each with a title and cards (title, optional note).",
  props: z.object({
    columns: z.array(
      z.object({
        title: z.string(),
        cards: z.array(z.object({ title: z.string(), note: z.string().optional() })),
      })
    ),
  }),
  component: ({ props }) => (
    <div className="grid w-full min-w-0 grid-cols-1 gap-3 @panel-sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
      {(props.columns ?? []).filter((column) => column?.title).map((column, index) => {
        const cards = (column.cards ?? []).filter((card) => card?.title)
        return (
          <Box key={index} className="p-2">
            <div className="flex items-center justify-between gap-2 px-1.5 pb-2">
              <p className={LABEL}>{column.title}</p>
              <span className={cn(META, "tabular-nums")}>{cards.length}</span>
            </div>
            <ul className="min-w-0 space-y-2">
              {cards.map((card, i) => (
                <li key={i} className={cn(INSET, "bg-background min-w-0 space-y-0.5 px-2.5 py-2")}>
                  <p className="text-[length:var(--text-sm,0.875rem)] leading-snug font-medium break-words text-foreground"><RichText text={card.title} /></p>
                  {card.note && <p className={cn(META, "text-pretty")}><RichText text={card.note} /></p>}
                </li>
              ))}
            </ul>
          </Box>
        )
      })}
    </div>
  ),
})
