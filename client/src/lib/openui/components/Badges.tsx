/* ── Badges ──
   Short tags. The tones are `ToneChip`'s, so a tag and a status are one chip
   with different words — a neutral tag is the muted case of the same thing.

   `avatars` is the same list drawn as overlapped initials instead of chips: who
   is involved at a glance, with a `+N` for those past `max`. That was
   `AvatarGroup` — this component's `items` plus a `caption`, a second way of
   drawing a row of short names rather than a second component. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { initials, META, ToneChip, TONES } from "@/lib/openui/kit"

export const Badges = defineComponent({
  name: "Badges",
  description:
    "A row of short tags, each with an optional tone. With `avatars` the same items draw as overlapped initials instead, with a +N past `max` and an optional `caption` — a row of people rather than of statuses.",
  props: z.object({
    items: z.array(
      z.object({
        text: z.string(),
        tone: z.enum(TONES).optional(),
      })
    ),
    /** Draw the items as people's initials rather than as chips. */
    avatars: z.boolean().optional(),
    /** With `avatars`: how many to show before the `+N`. */
    max: z.number().optional(),
    caption: z.string().optional(),
  }),
  component: ({ props }) => {
    const items = (props.items ?? []).filter((item) => item?.text)
    if (!props.avatars) {
      return (
        <div className="flex w-full min-w-0 flex-wrap gap-1.5">
          {items.map((item, index) => (
            <ToneChip key={index} text={item.text} tone={item.tone} />
          ))}
        </div>
      )
    }
    const max = Math.max(1, Math.round(props.max ?? 5))
    const shown = items.slice(0, max)
    const rest = items.length - shown.length
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div role="img" aria-label={items.map((item) => item.text).join(", ")} className="flex items-center">
          {shown.map((item, index) => (
            <Avatar key={index} title={item.text} className={cn("size-7 ring-2 ring-background", index > 0 && "-ms-2")}>
              <AvatarFallback className="text-[0.6875rem]">{initials(item.text)}</AvatarFallback>
            </Avatar>
          ))}
          {rest > 0 && (
            <span className="-ms-2 flex size-7 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-medium text-muted-foreground tabular-nums ring-2 ring-background">
              +{rest}
            </span>
          )}
        </div>
        {props.caption && <span className={cn(META, "min-w-0")}>{props.caption}</span>}
      </div>
    )
  },
})
