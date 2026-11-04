/* ── Section ──
   A heading and a line under it. Plain characters rather than the app's
   markdown renderer: that lives in `tool-parts.tsx`, which is what this library
   is reached *from*, and importing `Prose` here would close that cycle. The
   heading is one step below `TITLE` — a section is a division inside a view, not
   the view's subject, and at this density the two cannot be the same size. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const Section = defineComponent({
  name: "Section",
  description: "A heading with an optional line of explanatory text.",
  props: z.object({
    title: z.string(),
    text: z.string().optional(),
  }),
  component: ({ props }) => (
    <div className="w-full min-w-0 space-y-1 pt-1.5">
      <h3 className="font-heading text-[1.0625rem] leading-snug font-semibold tracking-[-0.015em] break-words text-balance text-foreground @panel-sm:text-[1.1875rem]">
        <RichText text={props.title} />
      </h3>
      {props.text && (
        <p className={cn(BODY, "text-pretty text-muted-foreground")}>
          <RichText text={props.text} />
        </p>
      )}
    </div>
  ),
})
