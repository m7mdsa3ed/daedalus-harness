import { CheckCircle2Icon, CircleDotIcon, CircleIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export interface ChecklistItem {
  content: string
  status: "completed" | "in_progress" | "pending"
  priority?: "high" | "medium" | "low"
}

export function TodoChecklist({ items, className }: { items: ChecklistItem[]; className?: string }) {
  return (
    <ul className={cn("space-y-0.5", className)}>
      {items.map((item, index) => (
        <li
          key={`${item.content}-${index}`}
          className={cn(
            "group flex min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-xs transition-colors",
            item.status === "in_progress" && "bg-primary/5"
          )}
        >
          <span
            className={cn(
              "mt-0.5 grid size-4 shrink-0 place-items-center",
              item.status === "in_progress" ? "text-primary" : "text-muted-foreground/60"
            )}
          >
            {item.status === "completed" ? (
              <CheckCircle2Icon aria-hidden className="size-3.5 text-primary" />
            ) : item.status === "in_progress" ? (
              <CircleDotIcon aria-hidden className="size-3.5" />
            ) : (
              <CircleIcon aria-hidden className="size-3" />
            )}
          </span>
          <span
            className={cn(
              "min-w-0 flex-1 break-words leading-5",
              item.status === "completed"
                ? "text-muted-foreground line-through decoration-muted-foreground/40"
                : item.status === "in_progress"
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
            )}
          >
            {item.content}
            {item.priority === "high" && item.status !== "completed" && (
              <span className="ml-1.5 inline-flex rounded-sm bg-destructive/10 px-1.5 py-0.5 align-middle text-[9px] font-semibold tracking-wide uppercase text-destructive">
                high
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}
