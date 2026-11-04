/* ── Tabs ──
   Alternatives the reader flips between. The `line` variant, so the strip reads
   as a heading over the panel rather than as a pill of its own — and at this
   density the strip is 32px tall, not a control block. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Tabs as UiTabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FLOW } from "@/lib/openui/kit"

export const Tabs = defineComponent({
  name: "Tabs",
  description: "Switchable panels: each tab has a label and its own children.",
  props: z.object({
    tabs: z.array(z.object({ label: z.string(), children: z.array(z.any()) })),
  }),
  component: ({ props, renderNode }) => (
    <UiTabs defaultValue={0} className="w-full min-w-0 gap-2.5">
      {/* Scrolls sideways rather than wrapping; `scrollbar-none` keeps a
          classic scrollbar from eating the fixed-height strip's content box,
          which clipped every label against it. */}
      <TabsList
        variant="line"
        className="h-8 w-full max-w-full min-w-0 justify-start gap-4 overflow-x-auto border-b border-border/70 scrollbar-none"
      >
        {props.tabs.map((tab, index) => (
          <TabsTrigger key={index} value={index} className="min-w-0 flex-none px-0 text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)]">
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {props.tabs.map((tab, index) => (
        <TabsContent key={index} value={index} className={FLOW}>
          {renderNode(tab.children)}
        </TabsContent>
      ))}
    </UiTabs>
  ),
})
