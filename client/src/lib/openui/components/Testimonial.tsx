/* ── Testimonial ──
   What a person said about something, with who they are. Not `Quote` (a
   cited excerpt from a document): this one has a speaker, so it leads with
   initials and draws the words larger. */
import { z } from "zod/v4"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Box, META, PAD } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const Testimonial = defineComponent({
  name: "Testimonial",
  description: "A person's words about something: the text, who said it and an optional role.",
  props: z.object({ text: z.string(), name: z.string(), role: z.string().optional() }),
  component: ({ props }) => {
    if (!props.text?.trim()) return null
    const initials = (props.name ?? "").split(/\s+/).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("")
    return (
      <Box>
        <figure className={cn(PAD, "space-y-3")}>
          <blockquote className="font-heading text-[1.0625rem] leading-[1.45] tracking-[-0.01em] text-pretty break-words text-foreground @panel-sm:text-[1.1875rem]">
            <RichText text={props.text} />
          </blockquote>
          <figcaption className="flex min-w-0 items-center gap-2.5">
            <Avatar className="size-8"><AvatarFallback className="text-[0.75rem]">{initials}</AvatarFallback></Avatar>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-[length:var(--text-sm,0.875rem)] font-medium text-foreground">{props.name}</p>
              {props.role && <p className={cn(META, "truncate")}>{props.role}</p>}
            </div>
          </figcaption>
        </figure>
      </Box>
    )
  },
})
