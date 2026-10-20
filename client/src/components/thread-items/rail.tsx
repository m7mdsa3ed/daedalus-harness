import * as React from "react"

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
    its parent's title — under the first disc of a run header's stack, which
    is where the rail comes down from (index.css "A run's rail"). Rows keep
    `space-y-0.5` (2px) so neighbouring hover grounds nearly touch.
    `pt`, not `mt`: inside the animated run clip a margin collapses through the
    moment overflow is restored, so the run shrank 2px after every open. */
export const RUN_RAIL_CLASS = "run-rail pt-0.5 space-y-0.5 ps-7"

/* The rail itself is CSS (`.run-rail` in index.css): one trunk under the
   parent's mark and an elbow into each child's, drawn per row so the line
   stretches with a row that opens and folds away with the run's clip. Every
   piece draws downward as its row arrives (`harness-rail-draw`). */
export const RAIL_ELBOW = "run-rail-step harness-rail-draw"

/** The trunk continuing past a step to the one under it — every step but the
    last, so the line stops on the last mark. */
export const RAIL_TAIL = "run-rail-tail"

/** Rows that draw a mark in the rail's column — a step's icon, a group's
    chevron. Anything else (a thought's card, prose, a message, a notice) is
    `RAIL_PLAIN`: the line stops at its top edge and starts again at its bottom
    edge, rather than aiming at a mark that is not there and running on behind
    the block — through a see-through card, or the text itself. */
const MARKED = new Set([
  "tool", "plan", "compaction", "autonomy", "shell", "voice", "subagent",
  "run", "tool-group", "shell-run", "work-fold", "subagent-group", "workflow-group", "subagent-batch",
])
export const RAIL_PLAIN = "run-rail-plain"
export function railPlain(kind: string): string | false {
  return !MARKED.has(kind) && RAIL_PLAIN
}

/** A straight length of the trunk, for a row on the rail that is not a step
    (the "N earlier steps" line). */
export const RAIL_THROUGH = "run-rail-through harness-rail-draw"

/** Each row's slot in the rail's drawing sequence (index.css "Drawing it"), as
    the `--rail-i` style for its wrapper. Rows already drawn hold slot 0; rows
    new in this render follow in order one slot after them (after the "N
    earlier" line too, when there is one), so a step joining the rail draws
    after the tail above it and a rail opening draws top to bottom. `mounted`
    false forgets what was drawn, so a rail that closes and reopens redraws. */
export function useRailSlots(ids: string[], mounted: boolean, leading = false) {
  const drawn = React.useRef(new Set<string>())
  const before = drawn.current
  const fresh = ids.filter((id) => !before.has(id))
  const offset = leading || fresh.length < ids.length ? 1 : 0
  React.useEffect(() => {
    drawn.current = mounted ? new Set(ids) : new Set()
  })
  return (id: string): React.CSSProperties => {
    const at = fresh.indexOf(id)
    return { "--rail-i": at < 0 ? 0 : at + offset } as React.CSSProperties
  }
}

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
