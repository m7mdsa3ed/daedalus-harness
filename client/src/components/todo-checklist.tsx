import { CheckIcon, CircleDotIcon, CircleIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export interface ChecklistItem {
  content: string
  status: "completed" | "in_progress" | "pending"
  priority?: "high" | "medium" | "low"
  note?: string
}

export function TodoChecklist({ items, className }: { items: ChecklistItem[]; className?: string }) {
  return (
    <ul className={cn("flex min-w-0 flex-col gap-1", className)}>
      {items.map((item, index) => (
        <li
          key={`${item.content}-${index}`}
          className={cn(
            "flex min-w-0 items-start gap-2 rounded-md border border-border/60 px-2 py-1.5 text-start transition-colors",
            item.status === "in_progress" && "border-primary/30 bg-primary/[0.04]"
          )}
        >
          <span aria-hidden className="grid h-5 w-4 shrink-0 place-items-center">
            {item.status === "completed" ? (
              <CheckIcon className="size-3.5 text-primary" />
            ) : item.status === "in_progress" ? (
              <CircleDotIcon className="size-3.5 text-primary" />
            ) : (
              <CircleIcon className="size-3 text-muted-foreground/60" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <span
              className={cn(
                "block break-words text-xs leading-5",
                item.status === "completed"
                  ? "text-muted-foreground line-through decoration-muted-foreground/40"
                  : item.status === "in_progress"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground"
              )}
            >
              {item.content}
            </span>
            {item.note && <p className="break-words text-[11px] leading-snug text-muted-foreground">{item.note}</p>}
          </div>
          {item.priority === "high" && item.status !== "completed" && (
            <span className="shrink-0 rounded-sm bg-destructive/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase text-destructive">
              high
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
