import { CheckIcon, CircleDotIcon, CircleIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Item } from "@/components/ui/item"
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
        <Item
          key={`${item.content}-${index}`}
          render={<li />}
          variant={item.status === "in_progress" ? "muted" : "outline"}
          size="xs"
          className="min-w-0 flex-nowrap items-start gap-2 py-1.5 text-start"
        >
          <span aria-hidden className="grid h-5 w-4 shrink-0 place-items-center">
            {item.status === "completed" ? (
              <CheckIcon className="size-3.5 text-primary" />
            ) : item.status === "in_progress" ? (
              <CircleDotIcon className="size-3.5 text-primary" />
            ) : (
              <CircleIcon className="size-3 text-muted-foreground" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <span
              className={cn(
                "block break-words text-sm leading-5",
                item.status === "completed"
                  ? "text-muted-foreground line-through"
                  : item.status === "in_progress"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground"
              )}
            >
              {item.content}
            </span>
            {item.note && <p className="break-words text-xs leading-snug text-muted-foreground">{item.note}</p>}
          </div>
          {item.priority === "high" && item.status !== "completed" && (
            <Badge variant="destructive">high</Badge>
          )}
        </Item>
      ))}
    </ul>
  )
}
