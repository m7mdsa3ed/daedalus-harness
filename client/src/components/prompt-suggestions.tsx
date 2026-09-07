/* ── Suggested follow-ups ──
   The model's closing `suggest-prompts` fence (`lib/suggestions`), drawn in the
   same footer slot Sources and the token figure use — and drawn the way the
   steps above it are: a hairline rail down the gutter with one row hanging off
   it per suggestion (`RAIL_CLASS`, `step-row`), a leading mark, caption weight,
   the row's own hover tint.

   Rows, not a rail of chips. A horizontal strip hid its own contents behind a
   gesture and needed a fade, a chevron and a drag handler to admit it; a
   stacked list shows every suggestion at once, reads top to bottom like the
   rest of the transcript, and costs one line each. A prompt too long for the
   width truncates on its row with the whole of it on the row's title — the
   height is the number of suggestions, never the length of one sentence.

   A click fills the composer with the prompt, the way a history recall does:
   replaced, unsent, editable, caret at the end. */
import { CornerDownLeftIcon } from "lucide-react"

import { RAIL_CLASS } from "./step-row"
import { cn } from "@/lib/utils"

export function PromptSuggestions({
  suggestions,
  onPick,
  className,
}: {
  suggestions: readonly string[]
  /** Fill the composer with the picked prompt. Replaces, like a history recall. */
  onPick: (prompt: string) => void
  className?: string
}) {
  if (suggestions.length === 0) return null

  return (
    <div
      data-slot="prompt-suggestions"
      className={cn(
        RAIL_CLASS,
        "mb-1.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out",
        className
      )}
    >
      {suggestions.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onPick(prompt)}
          title={`Ask: ${prompt}`}
          className={cn(
            // The step row's own geometry: the hover tint bleeds 6px each side
            // and cancels on both, so the text edge lines up with the steps.
            "group/suggestion -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2",
            "rounded-md px-1.5 py-0.5 text-start transition-colors duration-150 hover:bg-muted/40"
          )}
        >
          <CornerDownLeftIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover/suggestion:text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground transition-colors group-hover/suggestion:text-foreground">
            {prompt}
          </span>
        </button>
      ))}
    </div>
  )
}
