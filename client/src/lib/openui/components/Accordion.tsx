/* ── Accordion ──
   An FAQ-shaped fold: one frame, a hairline between questions. The frame is the
   `Box`'s, so the registry accordion's own border goes. One item is a single
   optional fold (what `Details` was); `open` starts an item unfolded. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Accordion as UiAccordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { cn } from "@/lib/utils"
import { Box, FLOW, PAD_ROW } from "@/lib/openui/kit"

export const Accordion = defineComponent({
  name: "Accordion",
  description: "Collapsible items, each a title over its own children, closed unless `open`. One item is a single optional fold; several are an FAQ.",
  props: z.object({
    items: z.array(z.object({ title: z.string(), children: z.array(z.any()), open: z.boolean().optional() })),
  }),
  component: ({ props, renderNode }) => (
    <Box>
      <UiAccordion
        defaultValue={props.items.flatMap((item, index) => (item.open ? [index] : []))}
        className="w-full min-w-0 rounded-none border-0"
      >
        {props.items.map((item, index) => (
          <AccordionItem key={index} value={index} className="data-open:bg-transparent">
            <AccordionTrigger
              className={cn(
                PAD_ROW,
                "min-w-0 items-center gap-3 text-sm font-medium text-foreground hover:no-underline pointer-coarse:min-h-11",
                /* The registry trigger has no focus ring of its own; a fold opened
                   from the keyboard has to show where the keyboard is. */
                "rounded-md focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              )}
            >
              <span className="min-w-0 break-words">{item.title}</span>
            </AccordionTrigger>
            {/* The registry panel pads `px-4` itself; the inner box needs only
                the foot, or the content is inset twice. */}
            <AccordionContent className="pt-0 pb-3">
              <div className={FLOW}>{renderNode(item.children)}</div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </UiAccordion>
    </Box>
  ),
})
