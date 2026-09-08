/* ── Suggested follow-ups ──
   The model's closing `suggest-prompts` fence (`lib/suggestions`), drawn in the
   same footer slot Sources and the token figure use — and drawn the way its
   neighbour there is: a `LABEL` caption over a group of rows, which is the
   app's one shape for "here is a named set of things the turn produced".
   `SourcesStrip` two slots up says "Sources" the same way, so the two stop
   being two languages under one answer.

   Rows, not a rail of chips. A horizontal strip hid its own contents behind a
   gesture and needed a fade, a chevron and a drag handler to admit it; a
   stacked list shows every suggestion at once, reads top to bottom like the
   rest of the transcript, and costs one line each.

   Two lines, not one. Truncating held the block to exactly one line per
   suggestion, which is the wrong thing to hold: a follow-up is a *sentence you
   are being offered*, and half of one with the verb cut off is not something a
   reader can choose between at a glance — the whole of it lived on `title`,
   which is a hover, which a touch device does not have. `line-clamp-2` keeps
   the ceiling (a block of three suggestions can never be more than six lines)
   while making the common case, which fits, whole.

   Every colour here is a token: `accent`/`accent-foreground` is the app's
   interactive tint (the same one every menu row, chip and step uses on hover),
   `border` is the hairline, `muted-foreground` the resting text. Nothing is
   an opacity-mixed one-off, so a theme that repaints those tokens repaints
   this with them.

   A click fills the composer with the prompt, the way a history recall does:
   replaced, unsent, editable, caret at the end. */
import { ArrowUpRightIcon } from "lucide-react"

import { LABEL } from "@/components/tool-parts"
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
        /* No left padding. These are the width of the transcript column, like
           every other row under an answer — a 4px inset put the list a hair
           right of the message it belongs to, which reads as a misalignment
           rather than as a group. (`TokenSummary` beside it pulls the other
           way, `-ml-1`, because it is a chip whose own padding has to be
           cancelled for its text to sit on the column's edge. These buttons are
           the box, not the text in it, so the box is what lines up.) */
        "mt-1 mb-2 flex min-w-0 flex-col gap-1",
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out",
        className
      )}
    >
      <span className={cn(LABEL, "mb-0.5")}>Next</span>
      {suggestions.map((prompt) => (
        <button
          key={prompt}
          type="button"
          onClick={() => onPick(prompt)}
          title={`Ask: ${prompt}`}
          className={cn(
            // The chip's own frame (`SourceChip` in tool-parts), stretched to
            // the width: same radius, same hairline, same hover promotion, so a
            // thing you can click under an answer looks the same whether it is
            // a page the agent read or a question it is offering.
            "group/suggestion flex w-full min-w-0 items-start gap-2 rounded-md",
            "border border-border/60 bg-transparent px-2 py-1 text-start",
            "transition-colors hover:border-border hover:bg-accent hover:text-accent-foreground",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          )}
        >
          {/* size-6 grid, not a bare icon: it pins the mark to the first line
              box, so a two-line suggestion keeps its arrow beside the first
              line rather than floating to the middle of both — the same trick
              `StepMeta` uses to stop a column of steps wobbling. */}
          <span aria-hidden className="grid h-5 shrink-0 place-items-center">
            <ArrowUpRightIcon className="size-3.5 text-muted-foreground/60 transition-colors group-hover/suggestion:text-current" />
          </span>
          <span className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground line-clamp-2 transition-colors group-hover/suggestion:text-current">
            {prompt}
          </span>
        </button>
      ))}
    </div>
  )
}
