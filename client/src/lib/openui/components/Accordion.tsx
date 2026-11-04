/* ── Accordion ──
   An FAQ-shaped fold: one frame, a hairline between questions. The frame is the
   `Box`'s, so the registry accordion's own border goes. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Accordion as UiAccordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Box, FLOW } from "@/lib/openui/kit"

export const Accordion = defineComponent({
  name: "Accordion",
  description: "A list of collapsible items, each a title over its own children. Good for FAQs.",
  props: z.object({
    items: z.array(z.object({ title: z.string(), children: z.array(z.any()) })),
  }),
  component: ({ props, renderNode }) => (
    <Box>
      <UiAccordion className="w-full min-w-0 rounded-none border-0">
        {props.items.map((item, index) => (
          <AccordionItem key={index} value={index}>
            <AccordionTrigger className="min-w-0 px-2.5 py-2 text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] @panel-sm:px-3">
              <span className="min-w-0 break-words">{item.title}</span>
            </AccordionTrigger>
            <AccordionContent className="px-2.5 @panel-sm:px-3">
              <div className={FLOW}>{renderNode(item.children)}</div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </UiAccordion>
    </Box>
  ),
})
