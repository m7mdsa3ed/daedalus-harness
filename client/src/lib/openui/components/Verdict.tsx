/* ── Verdict ──
   The answer, up front. A drawn answer used to open with a `Section` (a title and
   a grey sentence) or a `Callout` (an aside), neither of which says "this is the
   conclusion". A verdict is a headline carrying a tone, the sentence that backs
   it, and a few short facts — the thing a reader needs if they read nothing else.
   The tone is a stripe on the frame's start edge, and the headline says the same
   thing in words, so colour is never the only carrier. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, META, PAD, TITLE, TONES, TONE_DOT } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const Verdict = defineComponent({
  name: "Verdict",
  description: "The answer up front: a headline with a tone, an optional sentence under it and a few short facts.",
  props: z.object({
    headline: z.string(),
    tone: z.enum(TONES).optional(),
    text: z.string().optional(),
    facts: z.array(z.string()).optional(),
  }),
  component: ({ props }) => {
    const headline = props.headline?.trim()
    if (!headline) return null
    const facts = (props.facts ?? []).filter((fact) => fact?.trim())
    return (
      <Box>
        <div role="group" aria-label={headline} className={cn("relative min-w-0 space-y-2", PAD, "ps-4 @panel-sm:ps-5")}>
          <span aria-hidden className={cn("absolute inset-y-0 start-0 w-1", TONE_DOT[props.tone ?? "info"])} />
          <p className={cn(TITLE, "text-pretty")}>
            <RichText text={headline} />
          </p>
          {props.text && (
            <p className={cn(BODY, "text-pretty")}>
              <RichText text={props.text} />
            </p>
          )}
          {facts.length > 0 && (
            <ul className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 pt-0.5">
              {facts.map((fact, index) => (
                <li key={index} className={cn(META, "min-w-0")}>
                  <RichText text={fact} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Box>
    )
  },
})
