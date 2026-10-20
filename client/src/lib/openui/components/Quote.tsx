import { defineComponent } from "@openuidev/react-lang"
import { z } from "zod/v4"
import { cn } from "@/lib/utils"
import { BODY, Box, META, PAD } from "@/lib/openui/kit"

/** A quotation set off from the prose. Plain text only: a link in a quote is a
    way to reach the network, and this lane has none. Both props are tolerated
    empty because the view streams in; a quote with no words draws nothing. */
export const Quote = defineComponent({
  name: "Quote",
  description: "A quoted or cited excerpt in plain text, with an optional attribution line (author, document, section).",
  props: z.object({
    text: z.string(),
    source: z.string().optional(),
  }),
  component: ({ props }) => {
    const text = props.text?.trim()
    if (!text) return null
    const source = props.source?.trim()
    return (
      <Box>
        <figure className={cn("m-0 min-w-0 border-l-2 border-primary whitespace-pre-line", PAD)}>
          <blockquote className={cn(BODY, "m-0 text-pretty italic")}>{text}</blockquote>
          {source && <figcaption className={cn(META, "mt-2")}>{"— "}{source}</figcaption>}
        </figure>
      </Box>
    )
  },
})
