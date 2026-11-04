/* ── Glossary ──
   Terms and their definitions. Unlike `KeyValue` (a fact and its figure) the
   definition is prose, so the term sits over it rather than beside it. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, PAD_ROW } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const Glossary = defineComponent({
  name: "Glossary",
  description: "Terms and their prose definitions, the term over its definition.",
  props: z.object({ items: z.array(z.object({ term: z.string(), definition: z.string() })) }),
  component: ({ props }) => (
    <Box>
      <dl className="w-full divide-y divide-border/70">
        {(props.items ?? []).filter((item) => item?.term).map((item, index) => (
          <div key={index} className={cn("min-w-0 space-y-0.5", PAD_ROW)}>
            <dt className="text-[length:var(--text-sm,0.875rem)] font-semibold break-words text-foreground"><RichText text={item.term} /></dt>
            <dd className={cn(BODY, "text-pretty text-muted-foreground")}><RichText text={item.definition} /></dd>
          </div>
        ))}
      </dl>
    </Box>
  ),
})
