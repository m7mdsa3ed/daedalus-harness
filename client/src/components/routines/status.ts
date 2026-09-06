/* ── One vocabulary for what a run did ──
   Five statuses, and the whole point of having five is that four of them are
   not "it went wrong" in the same way. They were being told apart by colour
   alone on the first draft of the runs list, which made `blocked` and `failed`
   the same red and `skipped` and `completed` the same grey — so a routine that
   had quietly refused to fire for a fortnight read exactly like one that had
   run fine for a fortnight.

   So each status carries a *sentence*, not just a tint, and the list prints it.
   The tints follow `WF_TONE` in thread-items.tsx deliberately: a workflow step
   and a routine run are the same kind of thing to a reader, and two tables in
   one app disagreeing about what "failed" looks like is the bug that table
   exists to prevent. */
import type { RoutineRunStatus } from "@/lib/settings"

export interface StatusTone {
  label: string
  /** What this status means, in words, under the row. Written for someone who
      has not read the plan: `blocked` in particular is a state a person can act
      on, and is deliberately not the same thing as a run that was refused a
      tool and carried on to say so — that one is an ordinary completion. */
  meaning: string
  text: string
  chip: string
  dot: string
}

export const RUN_STATUS: Record<RoutineRunStatus, StatusTone> = {
  running: {
    label: "Running",
    meaning: "The run's thread is open and its turn has not settled yet.",
    text: "text-primary",
    chip: "bg-primary/10 text-primary",
    dot: "bg-primary animate-pulse",
  },
  completed: {
    label: "Completed",
    meaning: "The turn ended. Nothing more than that is claimed — see the run's thread for what it actually did.",
    text: "text-muted-foreground",
    chip: "bg-muted text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
  blocked: {
    label: "Blocked",
    meaning:
      "The agent asked for something, nobody answered in time, and the fallback answered for it. The run needs a person.",
    text: "text-amber-600 dark:text-amber-400",
    chip: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  skipped: {
    label: "Skipped",
    meaning:
      "It never started: a fire condition said nothing had changed, the plan was too low, or a previous run was still going. Not an error.",
    text: "text-muted-foreground/70",
    chip: "bg-muted text-muted-foreground/70",
    dot: "bg-muted-foreground/25",
  },
  failed: {
    label: "Failed",
    meaning: "The run started and did not finish — the turn errored, or it ran past a ceiling.",
    text: "text-destructive",
    chip: "bg-destructive/10 text-destructive",
    dot: "bg-destructive",
  },
}

/** A status the client does not know is a status a later server added — read it
    as the least alarming thing it could be rather than crashing the list. */
export const runStatus = (status: string): StatusTone =>
  RUN_STATUS[status as RoutineRunStatus] ?? RUN_STATUS.completed

/** Where a fire came from, for the runs list. `manual` is the one a person
    should be able to spot at a glance — it is the dry run they just started. */
export const SOURCE_LABEL: Record<string, string> = {
  schedule: "Schedule",
  api: "API",
  git: "Git",
  manual: "Run now",
  routine: "Chained",
}
