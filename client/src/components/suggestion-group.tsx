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
   truncate to one, in the monospace every shell surface in the transcript
   wears, because a command broken across two lines is harder to read back than
   one cut off.

   **The rows are one card, not a stack of them** (`CARD_OF_ROWS`): a bordered
   pill per line said "four separate things" four times and, with four kinds
   enabled, put thirteen rings around a footer that is an offer rather than a
   form. One card with hairline divides is the shape every other list in the
   app wears, and it is the same object at one row as at four. The mark moved
   from each row to the caption for the same reason — four identical glyphs
   down a column are decoration; one beside the name says which family this is,
   and the row itself is left to the words. Hover then reads as a row of a
   menu: the ground comes up across the card's full width (which a pill could
   not do without a second ring inside the first), and the text comes forward
   with it. A pick fills the composer, the way a history recall does: replaced,
   unsent, editable, caret at the end. Nothing is run or sent by the click. */
import { LABEL } from "@/components/tool-parts"
import type { SuggestGroup } from "@/lib/suggestions"
import { dominantTextDir } from "@/lib/text-direction"
import { cn } from "@/lib/utils"

/** The card's own ground: the registry card's ring over `bg-card`, the same
    object `Group` draws in settings and the task board's lists draw. No
    `shadow` — this sits on a transcript that already scrolls under a shadowed
    composer, and a second elevation behind it read as two planes. */
const CARD_OF_ROWS = "min-w-0 divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10"

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
        "mt-1 mb-2 flex min-w-0 flex-col gap-1.5",
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out",
        className
      )}
    >
      <span className={cn(LABEL, "flex items-center gap-1.5")}>
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
        {kind.caption}
      </span>
      <div className={CARD_OF_ROWS}>
        {lines.map((line) => {
          const text = kind.show ? kind.show(line) : line
          return (
            <button
              key={line}
              type="button"
              onClick={() => onPick(kind.fill(line))}
              title={kind.fill(line)}
              className={cn(
                "group/suggestion flex w-full min-w-0 cursor-pointer gap-2 px-3 py-2 text-start outline-none transition-colors",
                "hover:bg-muted focus-visible:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset",
                /* A finger gets the 36px row; a mouse gets the compact one. The
                   same bargain every touch target in the app makes. */
                "pointer-coarse:py-3",
                kind.mono ? "items-center" : "items-start"
              )}
            >
              <span
                dir={dominantTextDir(text)}
                className={cn(
                  "min-w-0 flex-1 text-muted-foreground transition-colors group-hover/suggestion:text-foreground group-focus-visible/suggestion:text-foreground",
                  kind.mono ? "truncate font-mono text-xs leading-5" : "line-clamp-2 text-sm leading-5"
                )}
              >
                {text}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
