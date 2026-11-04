/* ── PricingTiers ──
   Plans side by side: name, price, what it includes. One column on a phone,
   as many as fit beyond. The `highlight` tier is ringed and wears a chip, so
   the recommendation is said in a word as well as by the frame. */
import { z } from "zod/v4"
import { Check } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, FIG, META, PAD, TITLE, ToneChip } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const PricingTiers = defineComponent({
  name: "PricingTiers",
  description: "Plans side by side: each a name, a price, an optional period and blurb, a list of features and an optional highlight flag.",
  props: z.object({
    tiers: z.array(
      z.object({
        name: z.string(),
        price: z.string(),
        period: z.string().optional(),
        text: z.string().optional(),
        features: z.array(z.string()).optional(),
        highlight: z.boolean().optional(),
      })
    ),
  }),
  component: ({ props }) => (
    <div className="grid w-full min-w-0 grid-cols-1 items-stretch gap-3 @panel-sm:grid-cols-[repeat(auto-fit,minmax(13rem,1fr))]">
      {(props.tiers ?? []).filter((tier) => tier?.name).map((tier, index) => (
        <Box key={index} className={cn("h-full", tier.highlight && "ring-2 ring-primary")}>
          <div className={cn(PAD, "flex h-full flex-col gap-3")}>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <p className={TITLE}>{tier.name}</p>
              {tier.highlight && <ToneChip text="Recommended" tone="info" />}
            </div>
            <p className={cn(FIG, "break-words")}>
              {tier.price}
              {tier.period && <span className="ms-1 text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] font-normal tracking-normal text-muted-foreground">{tier.period}</span>}
            </p>
            {tier.text && <p className={cn(META, "text-pretty")}><RichText text={tier.text} /></p>}
            <ul className="min-w-0 space-y-2 border-t border-rule pt-3">
              {(tier.features ?? []).filter(Boolean).map((feature, i) => (
                <li key={i} className="flex min-w-0 gap-2">
                  <Check aria-hidden className="mt-[0.3em] size-3.5 shrink-0 text-success" strokeWidth={3} />
                  <span className={cn(BODY, "min-w-0")}><RichText text={feature} /></span>
                </li>
              ))}
            </ul>
          </div>
        </Box>
      ))}
    </div>
  ),
})
