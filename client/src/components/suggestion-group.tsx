/* ── One kind's rows under an answer ──
   The model's closing fence for a kind (`lib/suggestions`), drawn in the same
   footer slot Sources and the token figure use: a `LABEL` caption over a group
   of rows, the app's one shape for "here is a named set of things the turn
   produced". Every kind is this one component — what differs is the entry in
   `SUGGEST_KINDS` (mark, caption, shell dress, the words a pick fills), so a
   new kind draws with no component of its own.

   Rows, not a rail of chips: a stacked list shows every suggestion at once,
   reads top to bottom like the rest of the transcript, and costs one line each.
   Prose kinds clamp to two lines (a follow-up is a sentence being offered, and
   half of one with the verb cut off cannot be chosen between); shell kinds
   truncate to one, in monospace on the recessed ground a shell surface wears,
   because a command broken across two lines is harder to read back than one
   cut off.

   A click fills the composer, the way a history recall does: replaced, unsent,
   editable, caret at the end. Nothing is run or sent by the click. */
import { LABEL } from "@/components/tool-parts"
import type { SuggestGroup } from "@/lib/suggestions"
import { Item } from "@/components/ui/item"
import { cn } from "@/lib/utils"

export function SuggestionGroup({
  group,
  onPick,
  className,
}: {
  group: SuggestGroup
  /** Fill the composer with the picked row's words. Replaces, like a history recall. */
  onPick: (text: string) => void
  className?: string
}) {
  const { kind, lines } = group
  if (lines.length === 0) return null
  const Icon = kind.icon

  return (
    <div
      data-slot="suggestion-group"
      data-kind={kind.id}
      className={cn(
        "mt-1 mb-2 flex min-w-0 flex-col gap-1",
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out",
        className
      )}
    >
      <span className={LABEL}>{kind.caption}</span>
      {lines.map((line) => {
        const text = kind.show ? kind.show(line) : line
        return (
          <Item
            key={line}
            variant={kind.mono ? "muted" : "outline"}
            size="xs"
            render={<button type="button" onClick={() => onPick(kind.fill(line))} title={kind.fill(line)} />}
            className={cn(
              "group/suggestion min-w-0 flex-nowrap gap-2 rounded-xl p-2 text-start hover:bg-muted",
              kind.mono ? "items-center" : "items-start"
            )}
          >
            {/* h-5 grid, not a bare icon: it pins the mark to the first line
                box, so a two-line row keeps its mark beside the first line. */}
            <span aria-hidden className="grid size-5 shrink-0 place-items-center">
              <Icon className="size-3.5 text-muted-foreground transition-colors group-hover/suggestion:text-foreground" />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 text-sm leading-5 text-muted-foreground transition-colors group-hover/suggestion:text-foreground",
                kind.mono ? "truncate font-mono" : "line-clamp-2"
              )}
            >
              {text}
            </span>
          </Item>
        )
      })}
    </div>
  )
}
