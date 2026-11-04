/* ── Badges ──
   Short tags. The tones are `ToneChip`'s, so a tag and a status are one chip
   with different words — a neutral tag is the muted case of the same thing. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { ToneChip } from "@/lib/openui/kit"

export const Badges = defineComponent({
  name: "Badges",
  description: "A row of short tags, each with an optional tone.",
  props: z.object({
    items: z.array(
      z.object({
        text: z.string(),
        tone: z.enum(["neutral", "info", "success", "warn", "error"]).optional(),
      })
    ),
  }),
  component: ({ props }) => (
    <div className="flex w-full min-w-0 flex-wrap gap-1">
      {props.items.map((item, index) => (
        <ToneChip key={index} text={item.text} tone={item.tone} />
      ))}
    </div>
  ),
})
