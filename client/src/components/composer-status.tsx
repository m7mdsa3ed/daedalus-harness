/* ── Composer status ──
   The readings of the thread, and the line it says about itself. The code
   lives in `components/composer/`, one file per reading, because they are
   four answers of the same *kind* and not one component:

   — `composer/indicator.tsx`         the shared 24px-trigger-over-a-popover
                                      shape (`StripIndicator`) and the `Ring`
                                      two of the readings print a number in;
   — `composer/config-indicator.tsx`  a settings change in flight or staged;
   — `composer/context-indicator.tsx` the context ring, the turn's numbers and
                                      the plan behind them;
   — `composer/todo-indicator.tsx`    how far the agent's checklist has got;
   — `composer/agents-indicator.tsx`  the subagents out working, and
                                      `runningAgents`, the reading the working
                                      line shares;
   — `composer/changes-indicator.tsx` what the last writing turn did to the
                                      worktree;
   — `composer/repo-indicator.tsx`    which branch the work lands on, and the
                                      writes a repository takes from here;
   — `composer/activity-line.tsx`     `workingMessage` and `PhaseLine`.

   This file is the barrel those importers still resolve through. The
   connection is not among them: it was a reading on the shelf's floor, which
   made the shelf's own ground wear its tone, and it is a `Notice` at the foot
   of the transcript now (`components/thread-view/thread-status.tsx`). */
export { StripIndicator } from "@/components/composer/indicator"
export { ConfigIndicator } from "@/components/composer/config-indicator"
export { ContextIndicator } from "@/components/composer/context-indicator"
export { TodoIndicator } from "@/components/composer/todo-indicator"
export { AgentsIndicator, runningAgents } from "@/components/composer/agents-indicator"
export { ChangesIndicator } from "@/components/composer/changes-indicator"
export { RepoIndicator } from "@/components/composer/repo-indicator"
export { PhaseLine, workingMessage } from "@/components/composer/activity-line"
