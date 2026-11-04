/* ── How a group of calls is bracketed ──
   A parallel batch is one set of calls, and this module is the one answer for
   how a set is drawn, so `ToolRun` reads a treatment rather than spelling
   `border-… divide-…` inline.

   The treatment is a **ledger**: a hairline above and below the group and one
   between every call, no tint. The calls stay on the run's rail — the same
   trunk, elbow and `ps-7` indent a plain run's steps have — because a batch is
   still steps of the run, told apart by its rules and its counting line, not
   by a different placement. Six treatments (a wash, a card, columns, a
   bracket, tiles and this one) were a reading preference once; the five
   others and the picker are gone, and this is the only one.

   ── One column ──
   The frame sits **flush on the transcript's column** — the same edge a step
   row's hover ground, a todo card, the thinking panel and the gap rule are on.
   It does not bleed: `-mx-2` with `px-2` held the *content* on the column but
   put the *frame* 8px outside every other turn part, which read as a box that
   does not line up. The paint room in the clips that can hold a group
   (`-mx-2 px-2` in `thread-view.tsx`, `rows.tsx`, `thread-cards.tsx`) is still
   there and costs nothing. */
import { cn } from "@/lib/utils"

export interface GroupTreatment {
  /** The box holding the header and the calls — the frame *and* their ground,
   *  because the calls sit inside it. */
  frame: string
  /** The element the calls are laid into: the run's rail, with a hairline
   *  between every call. */
  list: string
}

/* A live batch takes the accent's colour on the same weight, because it is the
   one thing on screen still happening — the bargain the running badge makes,
   not a heavier box. The resting weight is the app's own border tone.
   `px-1`, not `px-2`, and the number is not free: the header and every call
   row inside the frame carry StepRow's `-mx-1 px-1`, which holds their content
   on the column while their hover ground bleeds 4px out. The frame supplies
   exactly that 4px, so the content lands on the column and the hover ground
   meets the frame's own edge. */
export function groupTreatment(live: boolean): GroupTreatment {
  return {
    frame: cn("border-y border-foreground/10 px-1 py-1", live && "border-primary/30"),
    list: "divide-y divide-foreground/10",
  }
}
