import { CheckCircle2Icon, CircleDashedIcon, LoaderCircleIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export interface ChecklistItem {
  content: string
  status: "completed" | "in_progress" | "pending"
  priority?: "high" | "medium" | "low"
}

export function TodoChecklist({ items, className }: { items: ChecklistItem[]; className?: string }) {
  return (
    <ul className={cn("space-y-1", className)}>
      {items.map((item, index) => (
        <li
          key={`${item.content}-${index}`}
          className={cn(
            "flex min-w-0 items-start gap-2 rounded-md border px-2 py-1.5 text-xs",
            item.status === "in_progress"
              ? "border-primary/25 bg-primary/5"
              : "border-border/40 bg-background/40"
          )}
        >
          <span className="grid size-5 shrink-0 place-items-center">
            {item.status === "completed" ? (
              <CheckCircle2Icon aria-hidden className="size-3.5 text-primary" />
            ) : item.status === "in_progress" ? (
              <LoaderCircleIcon aria-hidden className="size-3.5 animate-spin text-primary" />
            ) : (
              <CircleDashedIcon aria-hidden className="size-3.5 text-muted-foreground/60" />
            )}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 break-words leading-5",
              item.status === "completed"
                ? "text-muted-foreground line-through opacity-70"
                : item.status === "in_progress"
                  ? "text-foreground"
                  : "text-muted-foreground"
            )}
          >
            {item.content}
            {item.priority === "high" && item.status !== "completed" && (
              <span className="ml-1.5 rounded-pill bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium tracking-wide uppercase text-primary">
                high
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
