/* The step statuses the transcript cannot say.

   A workflow step reaches the transcript as a subagent row, and a subagent is
   running, completed, failed or cancelled. The engine's journal knows four
   more — a step backing off before another attempt (`retrying`), a step parked
   on a person (`awaiting_approval`), on a clock (`sleeping`) or on an outside
   signal (`waiting_signal`) — and they reach the client only through the run's
   REST view (`useWorkflowRun`). They are *overlaid* on the transcript's step
   list, never substituted for it: the transcript stays the source of the rows,
   this is one more word on the ones the journal has an opinion about.

   Lives under `workflow/` and imports nothing from `workflow-run.tsx`, which
   imports it. */
import type {
  WorkflowGateView,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowStepStatus,
  WorkflowStepView,
} from "@/lib/queries/workflows"

export type ExtraStepState = "retrying" | "awaiting_approval" | "sleeping" | "waiting_signal"

const EXTRA: readonly WorkflowStepStatus[] = ["retrying", "awaiting_approval", "sleeping", "waiting_signal"]

export const isExtraState = (status: string): status is ExtraStepState =>
  (EXTRA as readonly string[]).includes(status)

/** The word each state is drawn with — a pill, a tooltip, a screen reader. */
export const EXTRA_LABEL: Record<ExtraStepState, string> = {
  retrying: "Retrying",
  awaiting_approval: "Awaiting approval",
  sleeping: "Sleeping",
  waiting_signal: "Waiting for signal",
}

/** The pill's classes, in the same vocabulary as the run badge: a tint over a
    10% ground. A person is wanted (warning), a retry is a recoverable fault
    (warning), a clock or a signal is simply not yet (primary). */
export const EXTRA_BADGE: Record<ExtraStepState, string> = {
  retrying: "bg-warning/10 text-warning",
  awaiting_approval: "bg-warning/10 text-warning",
  sleeping: "bg-primary/10 text-primary",
  waiting_signal: "bg-primary/10 text-primary",
}

/** Which one speaks for the run when several steps are in different ones: the
    one that needs a person first. */
const URGENCY: ExtraStepState[] = ["awaiting_approval", "retrying", "waiting_signal", "sleeping"]

export function headlineState(steps: readonly { status: string }[]): ExtraStepState | null {
  for (const state of URGENCY) if (steps.some((step) => step.status === state)) return state
  return null
}

/** The REST step that belongs to a transcript step: by the child thread's id
    when both know it (a retry spawns a new child, so this can miss), else by
    the definition's name, when that is unambiguous among the steps in an
    extra state. */
export function restStepFor(
  run: WorkflowRunView | undefined,
  sessionId: string | null | undefined,
  name: string
): WorkflowStepView | undefined {
  if (!run) return undefined
  if (sessionId) {
    const own = run.steps.find((step) => step.sessionId === sessionId)
    if (own) return own
  }
  if (!name) return undefined
  const named = run.steps.filter((step) => step.name === name)
  if (named.length === 1) return named[0]
  const extra = named.filter((step) => isExtraState(step.status))
  return extra.length === 1 ? extra[0] : undefined
}

/** The run's own state as a badge, when the REST view says something the
    transcript cannot: a run sleeping between steps looks finished in the
    transcript, a run stopped by a budget looks failed. */
export const RUN_BADGE: Partial<Record<WorkflowRunStatus, readonly [string, string]>> = {
  cancelled: ["Cancelled", "bg-muted text-muted-foreground"],
  budget_exceeded: ["Budget hit", "bg-destructive/10 text-destructive"],
}

export const waitingGates = (gates: readonly WorkflowGateView[]) =>
  gates.filter((gate) => gate.status === "waiting")

/** `HH:MM`, or with the date when it is not today. */
export function clockLabel(at: number): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`
}

/** `1:05`, `12:30:07` — a countdown. Null once it has run out. */
export function remainingLabel(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, "0")
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
