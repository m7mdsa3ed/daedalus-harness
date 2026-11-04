/* ── AvatarGroup ──
   Who is involved at a glance: overlapped initials with a +N for the rest.
   `People` is the list with roles; this is the compact one for a header line. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { META } from "@/lib/openui/kit"

export const AvatarGroup = defineComponent({
  name: "AvatarGroup",
  description: "Overlapped initials avatars for a list of names, with a +N for those past `max` (default 5) and an optional caption.",
  props: z.object({ names: z.array(z.string()), max: z.number().optional(), caption: z.string().optional() }),
  component: ({ props }) => {
    const names = (props.names ?? []).filter((name) => name?.trim())
    const max = Math.max(1, Math.round(props.max ?? 5))
    const shown = names.slice(0, max)
    const rest = names.length - shown.length
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <div role="img" aria-label={names.join(", ")} className="flex items-center">
          {shown.map((name, index) => (
            <Avatar key={index} title={name} className={cn("size-8 ring-2 ring-background", index > 0 && "-ms-2")}>
              <AvatarFallback className="text-[0.6875rem]">
                {name.split(/\s+/).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("")}
              </AvatarFallback>
            </Avatar>
          ))}
          {rest > 0 && (
            <span className="-ms-2 flex size-8 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-medium text-muted-foreground tabular-nums ring-2 ring-background">+{rest}</span>
          )}
        </div>
        {props.caption && <span className={cn(META, "min-w-0")}>{props.caption}</span>}
      </div>
    )
  },
})
