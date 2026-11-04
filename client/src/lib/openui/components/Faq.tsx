/* ── Faq ──
   Questions and plain answers. `Accordion` folds arbitrary children; this is
   the flat shape a model writes most often, so the answer is one string and
   the first question starts open. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Accordion as UiAccordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { BODY, Box } from "@/lib/openui/kit"
import { cn } from "@/lib/utils"
import { RichText } from "@/lib/openui/rich-text"

export const Faq = defineComponent({
  name: "Faq",
  description: "Questions with plain-text answers, each folded under its question.",
  props: z.object({ items: z.array(z.object({ question: z.string(), answer: z.string() })) }),
  component: ({ props }) => (
    <Box>
      <UiAccordion defaultValue={[0]} className="w-full min-w-0 rounded-none border-0">
        {(props.items ?? []).filter((item) => item?.question).map((item, index) => (
          <AccordionItem key={index} value={index}>
            <AccordionTrigger className="min-w-0 px-3.5 py-3 text-[length:calc(var(--text-sm,0.875rem)+0.0625rem)] font-medium @panel-sm:px-4">
              <span className="min-w-0 break-words">{item.question}</span>
            </AccordionTrigger>
            <AccordionContent className="px-3.5 @panel-sm:px-4">
              <p className={cn(BODY, "text-pretty text-muted-foreground")}><RichText text={item.answer ?? ""} /></p>
            </AccordionContent>
          </AccordionItem>
        ))}
      </UiAccordion>
    </Box>
  ),
})
