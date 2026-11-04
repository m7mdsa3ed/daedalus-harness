/* ── FeatureGrid ──
   Peer items with a name and a sentence each: features, options, principles.
   Tiles reflow on the panel's width (one column on a phone, as many as fit
   beyond). A `tag` is the tile's eyebrow, above the title rather than beside
   it: beside it, a long tag took the title's width and broke a three-word name
   across two lines, and the chip's border was one frame too many inside a tile. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, LABEL, PAD, TITLE, TONE_DOT, TONES } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

/** The tag's words in its tone. With no tone it stays info, the accent it
    had before tones existed; neutral is muted text. */
const TAG_TEXT = {
  neutral: "text-muted-foreground",
  info: "text-primary",
  success: "text-success",
  warn: "text-warning",
  error: "text-destructive",
} as const

export const FeatureGrid = defineComponent({
  name: "FeatureGrid",
  description: "Peer items as tiles: each a title, a sentence and an optional tag. Reflows from one column to as many as fit.",
  props: z.object({
    items: z.array(z.object({ title: z.string(), text: z.string().optional(), tag: z.string().optional() })),
  }),
  component: ({ props }) => (
    <div className="grid w-full min-w-0 grid-cols-1 gap-3 @panel-sm:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
      {(props.items ?? []).filter((item) => item?.title).map((item, index) => (
        <Box key={index} className={cn(PAD, "flex flex-col gap-2")}>
          {item.tag && (
            <span className={cn(LABEL, "flex min-w-0 items-center gap-1.5 normal-case tracking-[0.02em]")}>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary/70" />
              <span className="min-w-0 truncate">{item.tag}</span>
            </span>
          )}
          <p className={cn(TITLE, "text-balance")}><RichText text={item.title} /></p>
          {item.text && <p className={cn(BODY, "text-pretty text-muted-foreground")}><RichText text={item.text} /></p>}
        </Box>
      ))}
    </div>
  ),
})
