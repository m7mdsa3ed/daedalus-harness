/* ── People ──
   Initials avatars, never a fetched picture (see `Image` for why), in a grid of
   equal cells so the names line up in columns. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { META } from "@/lib/openui/kit"

export const People = defineComponent({
  name: "People",
  description: "A list of people with a name and optional role, drawn as initials avatars.",
  props: z.object({
    items: z.array(z.object({ name: z.string(), role: z.string().optional() })),
  }),
  component: ({ props }) => (
    <div className="grid w-full min-w-0 grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-x-4 gap-y-2.5">
      {props.items.map((person, index) => (
        <div key={index} className="flex min-w-0 items-center gap-2">
          <Avatar className="size-7">
            <AvatarFallback className="text-[0.6875rem]">
              {person.name
                .split(/\s+/)
                .slice(0, 2)
                .map((word) => word[0]?.toUpperCase() ?? "")
                .join("")}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-[length:calc(var(--text-sm,0.875rem)-0.0625rem)] font-medium text-foreground">{person.name}</p>
            {person.role && <p className={cn(META, "truncate")}>{person.role}</p>}
          </div>
        </div>
      ))}
    </div>
  ),
})
