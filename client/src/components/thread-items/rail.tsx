/* ── A run's rail ── the geometry the steps inside a folded run hang off, and
   the "N earlier steps" line that heads a peeking one. Constants and one leaf
   button: nothing here recurses back into the row tree, so it lives apart from
   the mutually recursive cluster in `rows.tsx`, which imports from here. The
   *other* rail — the one a subagent's transcript hangs off — is `RAIL_CLASS`
   in `step-row.tsx`, because `workflow-run` needs it too and may not import
   this side. */

/** How much of a running group stays on screen without being expanded. */
export const PEEK = 3

/** The rail nested steps hang off: one for a run and for a subagent's
    transcript alike, so a subagent's steps read as steps and not as a second
    kind of list. `ml-[calc(0.75rem-1px)]` puts the line under the parent
    row's icon column, and a rail inside a rail indents once more. */
/* ── A run's rail ──
   Drawn per step rather than as one border down the box around them: the line
   has to *stop* at the last step's elbow (a tail running on under the last row
   is a branch that goes nowhere), and a border on the container cannot know
   which child is last. So `RUN_RAIL_CLASS` is the same geometry as `RAIL_CLASS`
   with the border taken off, and each step carries its own piece of it.

   Each piece is an elbow: the rail down the step's left, turning into its icon
   column on a curve. `before:h-4` ends the turn at 14px — the middle of the
   row's first line box (`py-0.5` + `leading-6`) — so it meets the leading mark
   however many lines the row grows to, and the `-top-0.5` closes the 2px
   `space-y` gap over it so consecutive elbows read as one line. The left edge
   is `-left-[11px]`, which is where the container's border used to sit, so
   nothing else moved. Every row in a run is a StepRow with that geometry — a
   thought rides the rail exactly as a tool does — where a subagent's rail
   also carries prose, which has no mark to meet.

   The width is 13px and not 11px — two more than the distance to the row's
   content edge — because the mark it turns into is a 14px *box* with the glyph
   inset inside it. Ending the curve at x=0 landed it on the box's edge and left
   a hairline of daylight before the icon actually starts, so the rail read as
   pointing at the step rather than joining it; the extra 2px tuck under the
   glyph's leading edge, where the line is hidden by the mark itself.

   `harness-rail-draw` is the entrance for that geometry: the elbow and the tail
   are the *same wrapper's* `::before` and `::after`, so one class on the step
   animates both, and the tail's absence on the last step is simply a pseudo
   with no `content` and so no box to animate. It is on the classes rather than
   on `.harness-item-in` in the stylesheet because these three constants are the
   only rails in the app — a footer chip in thread-view wears the same entrance
   and has no line to draw. */
export const RUN_RAIL_CLASS = "mt-0.5 ml-[calc(0.75rem-1px)] space-y-0.5 pl-2.5"

export const RAIL_ELBOW =
  "harness-rail-draw relative before:absolute before:-top-0.5 before:-left-[11px] before:h-4 before:w-[13px] before:rounded-bl-[6px] before:border-b before:border-l before:border-border/60"

/** The rail continuing past a step to the one under it — every step but the
    last, which is what makes the run's line end on its own last elbow. */
export const RAIL_TAIL =
  "after:absolute after:top-[0.875rem] after:-bottom-0.5 after:-left-[11px] after:w-px after:bg-border/60"

/** A straight length of the same rail, for a row in it that is not a step (the
    "N earlier steps" line) — it passes the line on without claiming an elbow. */
export const RAIL_THROUGH =
  "harness-rail-draw relative before:absolute before:-top-0.5 before:-bottom-0.5 before:-left-[11px] before:w-px before:bg-border/60"

/** "N earlier steps" — the top of a peeking rail. */
export function EarlierSteps({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-1 block rounded-sm px-1 text-[11px] leading-5 text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      {count} earlier {count === 1 ? "step" : "steps"}
    </button>
  )
}
