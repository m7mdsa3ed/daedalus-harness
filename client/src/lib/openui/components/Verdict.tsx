/* ── Verdict ──
   The answer, up front. A drawn answer used to open with a `Section` (a title and
   a grey sentence) or a `Callout` (an aside), neither of which says "this is
   the conclusion". A verdict is a headline carrying a tone, the sentence that backs
   it, and a few short facts — the thing a reader needs if they read nothing else.

   The tone is a stripe on the frame's start edge and the headline is set a step
   above `TITLE`, because this is the one thing in a view that is allowed to be
   the largest words on it. The headline says the same thing in words, so colour
   is never the only carrier. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { CircleAlert, CircleCheck, Info, OctagonX, Circle } from "lucide-react"
import { BODY, Box, META, PAD, TONES } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

const VERDICT = {
  neutral: { Icon: Circle, ink: "text-muted-foreground", wash: "bg-muted/40" },
  info: { Icon: Info, ink: "text-primary", wash: "bg-primary/6" },
  success: { Icon: CircleCheck, ink: "text-success", wash: "bg-success/8" },
  warn: { Icon: CircleAlert, ink: "text-warning", wash: "bg-warning/8" },
  error: { Icon: OctagonX, ink: "text-destructive", wash: "bg-destructive/8" },
} as const

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
    const v = VERDICT[props.tone ?? "info"]
    const facts = (props.facts ?? []).filter((fact) => fact?.trim())
    return (
      <Box>
        <div role="group" aria-label={headline} className={cn("flex min-w-0 gap-3", PAD, v.wash)}>
          <v.Icon aria-hidden className={cn("mt-0.5 size-5 shrink-0", v.ink)} strokeWidth={2} />
          <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-heading text-[1.1875rem] leading-[1.2] font-semibold tracking-[-0.02em] text-balance break-words text-foreground @panel-sm:text-[1.375rem]">
            <RichText text={headline} />
          </p>
          {props.text && (
            <p className={cn(BODY, "text-pretty text-muted-foreground")}>
              <RichText text={props.text} />
            </p>
          )}
          {facts.length > 0 && (
            <ul className={cn(META, "flex min-w-0 flex-wrap gap-x-4 gap-y-1 pt-1")}>
              {facts.map((fact, index) => (
                <li key={index} className="min-w-0">
                  <RichText text={fact} />
                </li>
              ))}
            </ul>
          )}
          </div>
        </div>
      </Box>
    )
  },
})
