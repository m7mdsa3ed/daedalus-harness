/* ── A run's rail ── the geometry the steps inside a folded run hang off, and
   the "N earlier steps" line that heads a peeking one. Constants and one leaf
   button: nothing here recurses back into the row tree, so it lives apart from
   the mutually recursive cluster in `rows.tsx`, which imports from here. */

/** How much of a running group stays on screen without being expanded. */
export const PEEK = 3

/** The indent nested steps hang off: one for a run, a subagent's transcript
    and a shell run's children alike, so nested steps read as steps and not as
    a second kind of list. One step, `ps-7`, is the parent row's title column
    (the 20px mark slot + the gap-2 to the title), so a child's mark sits under
    its parent's title, and a run inside a run indents once more. Rows keep
    `space-y-0.5` (2px) so neighbouring hover grounds nearly touch, one list.
    `pt`, not `mt`: inside the animated run clip a margin collapses through the
    moment overflow is restored, so the run shrank 2px after every open. */
export const RUN_RAIL_CLASS = "pt-0.5 space-y-0.5 ps-7"

/* The rail is no longer drawn: nested steps keep the indent under the parent
   row's icon column and nothing else. The three names stay, empty, so the row
   tree that places them is unchanged. */
export const RAIL_ELBOW = "relative"

/** The rail continuing past a step to the one under it — not drawn. */
export const RAIL_TAIL = ""

/** A straight length of the rail, for a row in it that is not a step — not drawn. */
export const RAIL_THROUGH = "relative"

/** "N earlier steps" — the top of a peeking rail. The steps' own ground
    (`-mx-1 px-1 py-0.5`, rounded-xl), its text starting at the title column
    (`ps-8` = the 4px bleed + the 28px mark slot and gap). */
export function EarlierSteps({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-1 flex w-[calc(100%+0.5rem)] rounded-xl px-1 py-0.5 ps-8 text-start text-xs leading-6 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {count} earlier {count === 1 ? "step" : "steps"}
    </button>
  )
}
