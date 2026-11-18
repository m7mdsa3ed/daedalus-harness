/* ── Tabs ──
   Alternatives the reader flips between, in the app's own line strip: a
   hairline under the row and one underline under the active label — the shape
   the thread inspector and a task's comments draw (`TabsList variant="line"`).
   It is a heading over the panel and not a pill band of its own, which is why
   it carries no fill.

   It is framed like a `Card`: one `Box`, the strip as its header row (the
   hairline a `BoxHeader` draws, at the card's side inset) and each panel the
   card's body. Bare, a tab's content floated under an underline while every
   other block in the answer was a tile — and what is framed inside it is a
   well, as in a Card.

   The trigger is the app's own size and weight rather than a smaller ad-hoc
   step: a tab in a drawn answer and a tab in the inspector are the same
   control, so they can never disagree about how big a tab is. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { Box, FLOW, WELL_PAD } from "@/lib/openui/kit"

export const Tabs = defineComponent({
  name: "Tabs",
  description: "Switchable panels: each tab has a label and its own children.",
  props: z.object({
    tabs: z.array(z.object({ label: z.string(), children: z.array(z.any()) })),
  }),
  component: ({ props, renderNode }) => (
    <Box>
      <UiTabs defaultValue={0} className="w-full min-w-0 gap-0">
        {/* Scrolls sideways rather than wrapping; `scrollbar-none` keeps a
          classic scrollbar from eating the fixed-height strip's content box,
          which clipped every label against it. */}
        <TabsList
          variant="line"
          className="h-10 w-full max-w-full min-w-0 justify-start gap-6 overflow-x-auto border-b border-rule px-3 scrollbar-none @panel-sm:px-4"
        >
          {props.tabs.map((tab, index) => (
            <TabsTrigger key={index} value={index} className="min-w-0 flex-none px-0 text-sm font-medium pointer-coarse:h-10">
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {props.tabs.map((tab, index) => (
          <TabsContent key={index} value={index} className={cn(FLOW, WELL_PAD)}>
            {renderNode(tab.children)}
          </TabsContent>
        ))}
      </UiTabs>
    </Box>
  ),
})
