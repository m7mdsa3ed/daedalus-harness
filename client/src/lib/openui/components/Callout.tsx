/* ── Callout ──
   An aside, and the answer-up-front. Both are a `Box` in their tone — the same
   frame, inset and tint (`TONE_TINT`) as a toned `Card` — with the glyph in a
   gutter and the words hanging beside it, so nothing in the library draws a
   frame of its own. A start stripe on a half-rounded box read as a pasted-on
   banner, and a `lead` with no frame floated loose in the prose.

   `lead` is the conclusion: the same tile, the headline a step larger — the
   largest words in the view, and the only thing allowed to be. */
import { z } from "zod/v4"
import { CircleCheck, CircleX, Info, TriangleAlert, type LucideIcon } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, PAD, TITLE, TONE_TEXT, TONE_TINT, TONES } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const GLYPH: Record<(typeof TONES)[number], LucideIcon> = {
  neutral: Info,
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  error: CircleX,
}

export const Callout = defineComponent({
  name: "Callout",
  description:
    "An aside in a tone (neutral, info, success, warn, error) with an optional title. With `lead` it is the answer up front: the title as a headline over the text, for a conclusion a reader should hit first.",
  props: z.object({
    text: z.string(),
    tone: z.enum(TONES).optional(),
    title: z.string().optional(),
    /** The conclusion rather than an aside: a headline over the text. */
    lead: z.boolean().optional(),
  }),
  component: ({ props }) => {
    const text = props.text?.trim()
    const title = props.title?.trim()
    if (!text && !title) return null
    const tone = props.tone ?? "neutral"
    const Glyph = GLYPH[tone]
    const lead = !!props.lead
    return (
      <Box className={TONE_TINT[tone]}>
        <div role={lead ? "group" : "note"} aria-label={title} className={cn(PAD, "flex min-w-0 items-start gap-2.5 @panel-sm:gap-3")}>
          <Glyph aria-hidden className={cn("mt-[0.2em] size-4 shrink-0", lead && "@panel-sm:mt-[0.3em]", TONE_TEXT[tone])} strokeWidth={2.25} />
          <div className="min-w-0 flex-1 space-y-1">
            {title && (
              <p className={cn(TITLE, "text-balance", lead && "text-base tracking-[-0.015em] @panel-sm:text-lg")}>
                <RichText text={title} />
              </p>
            )}
            {text && (
              <p className={cn(BODY, "text-pretty", title && "text-muted-foreground")}>
                <RichText text={text} />
              </p>
            )}
          </div>
        </div>
      </Box>
    )
  },
})
