/* ── Timeline ──
   Ordered events with a state each. The rail is the list; the marker says the
   state by shape as well as by colour, and a pending event is drawn muted —
   what has not happened yet is not read at the same weight as what has. */
import { z } from "zod/v4"
import { Check, X } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { META } from "@/lib/openui/kit"
import { RichText } from "@/lib/openui/rich-text"

export const Timeline = defineComponent({
  name: "Timeline",
  description: "Ordered steps or events: a title, optional time and text, and a status.",
  props: z.object({
    items: z.array(
      z.object({
        title: z.string(),
        time: z.string().optional(),
        text: z.string().optional(),
        status: z.enum(["done", "active", "pending", "failed"]).optional(),
      })
    ),
  }),
  component: ({ props }) => (
    <ol className="w-full min-w-0">
      {props.items.map((item, index) => {
        const status = item.status ?? "pending"
        return (
          <li key={index} className="relative flex min-w-0 gap-2.5 pb-5 last:pb-0">
            {index < props.items.length - 1 && (
              <span aria-hidden className="absolute top-6 bottom-1 left-2.5 w-px bg-border" />
            )}
            <span
              className={cn(
                "mt-px flex size-5 shrink-0 items-center justify-center rounded-full",
                status === "done" && "bg-primary text-primary-foreground",
                status === "active" && "bg-primary/10 ring-1 ring-primary ring-inset",
                status === "failed" && "bg-destructive/10 text-destructive ring-1 ring-destructive ring-inset",
                status === "pending" && "bg-background ring-1 ring-border ring-inset"
              )}
            >
              {status === "done" && <Check className="size-2.5" strokeWidth={3} />}
              {status === "failed" && <X className="size-2.5" strokeWidth={3} />}
              {status === "active" && <span className="size-1.5 motion-safe:animate-pulse rounded-full bg-primary" />}
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3">
                <span
                  className={cn(
                    "min-w-0 text-[length:calc(var(--text-sm,0.875rem)+0.0625rem)] leading-snug font-medium break-words",
                    status === "pending" ? "text-muted-foreground" : "text-foreground"
                  )}
                >
                  <RichText text={item.title} />
                </span>
                {item.time && <span className={cn(META, "max-w-full tabular-nums")}>{item.time}</span>}
              </div>
              {item.text && (
                <p className={cn(META, "text-pretty")}>
                  <RichText text={item.text} />
                </p>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  ),
})
