/* ── EmptyState ──
   An absence, drawn as one: the app's dashed box, never an alert. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { Empty } from "@/components/empty"

export const EmptyState = defineComponent({
  name: "EmptyState",
  description: "A box saying there is nothing to show.",
  props: z.object({
    text: z.string(),
  }),
  component: ({ props }) => (
    <Empty className="w-full min-w-0 [&_p]:break-words" size="sm">
      {props.text}
    </Empty>
  ),
})
