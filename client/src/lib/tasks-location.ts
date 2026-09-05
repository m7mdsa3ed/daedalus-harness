/* ── Where a board is being read ──
   Which board is open, which task's detail is showing, and how to change
   either. The workspace used to answer all three from the router directly
   (`useParams`, `useSearchParams`, `useNavigate`), which made "the board" and
   "the URL" the same fact — and a board cannot be a dock panel while that is
   true: a panel changing the URL would navigate the page it is drawn on out
   from under itself, taking the dock and every other panel with it.

   So the three questions are an interface, and there are two answers to it: the
   route's (`/board/:boardId?task=`, still the place a board is shared from) and
   a panel's, which keeps them in its own descriptor. The workspace itself no
   longer knows which one it has.

   Pure types and one small hook per host; the hosts live where they belong —
   `components/tasks/index.tsx` for the route, `components/workspace/tasks-panel.tsx`
   for the panel. */

export interface BoardLocation {
  /** The board being read; "" before one has been chosen. */
  boardId: string
  /** The task whose detail is open, or null. */
  taskId: string | null
  /**
   * Open a board, optionally with one of its tasks.
   *
   * `replace` is the "you were not really here" case — a board that no longer
   * exists resolving to the remembered one, or a task opening the board it
   * actually belongs to. It must not leave a step in the history a Back button
   * walks into.
   */
  openBoard: (boardId?: string, taskId?: string, options?: { replace?: boolean }) => void
  /** Open a task's detail, or close it with `null`. */
  openTask: (taskId: string | null) => void
}
