/* ── List ──
   Short lines. Numbered items wear a counter chip, bullets a dot centred on
   the first line — both in the same 20px column, so a list is aligned whichever
   it is, and the counter is a muted figure rather than a filled tile: at this
   density a stack of grey squares was heavier than the words beside them. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const List = defineComponent({
  name: "List",
  description: "Short lines, numbered or bulleted.",
  props: z.object({
    items: z.array(z.string()),
    numbered: z.boolean().optional(),
  }),
  component: ({ props }) => {
    const Tag = props.numbered ? "ol" : "ul"
    return (
      <Tag className="w-full min-w-0 space-y-1">
        {props.items.map((item, index) => (
          <li key={index} className="flex min-w-0 gap-2">
            <span className="flex h-[1.55em] w-4 shrink-0 items-center justify-center">
              {props.numbered ? (
                <span className="text-[0.6875rem] leading-none font-medium tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
              ) : (
                <span className="size-1 rounded-full bg-muted-foreground/60" />
              )}
            </span>
            <span className={cn(BODY, "min-w-0 flex-1")}>
              <RichText text={item} />
            </span>
          </li>
        ))}
      </Tag>
    )
  },
})
