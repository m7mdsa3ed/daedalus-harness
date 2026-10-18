/* ── The one line a thread says about itself ──
   `workingMessage` reads what the turn is doing off the thread; `PhaseLine`
   draws that sentence (and the six the connection ladder reaches it with);
   `ThreadStatus` is the turn's caller. Not a reading in the footer's
   cluster — this one lives in the transcript, where the turn is. */
import { Logo } from "@/components/ui/logo"
import { ShimmerWave } from "@/components/ui/shimmer-wave"
import { runningAgents } from "@/components/composer/agents-indicator"
import { toolHeading, toolKindOf } from "@/lib/tools"
import { type ThreadState } from "@/lib/store"
import { describeError } from "@/lib/errors"
import { holdOf } from "@/lib/thread/hold"
import { cn } from "@/lib/utils"

/**
 * What the working line says, read off the thread: the one thing the turn is
 * doing right now, so the line is a status and not a mood. In order of what
 * the reader most needs to know — a question waiting on them, workers out,
 * then whatever the *newest* thing in the transcript is.
 *
 * That last part is a single walk backwards, and it has to be: an in-flight
 * step used to be searched for across the whole transcript before prose and
 * thinking were even looked at, so a step a runtime never settles — a tool
 * call left `in_progress` forever, which is ordinary — pinned the line to its
 * heading for the rest of the turn while the agent wrote a page underneath it.
 * The line said "Read store.tsx" for two minutes. So the first item from the
 * end that means anything wins, and a *settled* step is the one thing that
 * means nothing (it is over) and is stepped past to whatever ran before it —
 * which is what keeps a parallel batch of calls reading as the call still out.
 */
/**
 * The one sentence a retry line can spend on the failure. `describeError`
 * splits a failure into a headline and the rest, and for a provider failure
 * the headline is the generic RPC label ("The agent hit an internal error")
 * while the actual cause — the sentence the hold would later quote — is the
 * first line of `detail`. A bare title is the fallback for failures with
 * nothing more specific to say.
 */
export function retryWhy(error: unknown): string {
  const info = describeError(error)
  const first = info.detail?.split("\n")[0]?.trim()
  return first || info.title
}

/** The first retry is a blip (2s, usually invisible): it is said only once a
    second one is needed, so a request that recovers on its own draws nothing. */
export function shownRetry(thread: ThreadState): NonNullable<ThreadState["retry"]> | null {
  return thread.retry && thread.retry.attempt >= 2 ? thread.retry : null
}

const TOOL_PHASE: Partial<Record<ReturnType<typeof toolKindOf>, string>> = {
  read: "Reading through the code",
  search: "Searching the project",
  edit: "Making changes",
  delete: "Removing files",
  move: "Moving files around",
  execute: "Running a command",
  fetch: "Looking something up online",
  think: "Thinking it through",
  switch_mode: "Switching modes",
}

export function workingMessage(thread: ThreadState): string {
  /* Before everything else: a held turn is not doing any of it. Read off the
     hold rather than the transcript, whose newest item is whatever the turn
     managed before it stopped. What it says is the hold's own (`holdOf`): a
     turn held on a failure is named as a state — the provider's sentence,
     which is what tells the reader which model to reach for — never as the
     failure an `ErrorRow` would draw. */
  if (thread.paused) return holdOf(thread).message
  /* Above everything but the hold, and for the same reason: a turn waiting out
     a backoff is not doing whatever the transcript's newest item says it is.
     This is the silence that used to read as work — seconds of shimmer under
     the name of a tool call that had already failed — and it is worth naming
     while there is still a chance it fixes itself. Named with the failure, not
     just the count: "Retrying (1 of 2)" alone leaves the reader waiting to find
     out what for. */
  const retry = shownRetry(thread)
  if (retry) {
    const of = retry.of ? ` of ${retry.of}` : ""
    const why = retry.error ? retryWhy(retry.error) : ""
    return `Retrying (${retry.attempt}${of})${why ? ` — ${why}` : ""}`
  }
  if (thread.permissions.length > 0) return "Waiting for your approval"
  if (thread.elicitations.length > 0) return "Waiting for your answer"
  const agents = runningAgents(thread)
  if (agents.length > 0) return `${agents.length} ${agents.length === 1 ? "agent" : "agents"} running`
  const items = thread.items
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    /* A subagent's own work is announced by the line above, not by this one. */
    if (item.parentId) continue
    switch (item.kind) {
      case "tool": {
        if (item.status !== "in_progress" && item.status !== "pending") continue
        /* The phase, not the step: the step's own heading ("Read store.tsx") is
           already the row above this line, and saying it twice made the line a
           label that never changed meaning. ACP `kind` only; an `other` call
           has no phase to name, so it keeps its heading. */
        const phase = TOOL_PHASE[toolKindOf(item)]
        if (phase) return phase
        const heading = toolHeading(item)
        if (heading.file) return `${heading.title} ${heading.file}`
        if (heading.detail && !heading.prose) return `${heading.title} ${heading.detail}`
        return heading.title
      }
      case "compaction":
        if (item.status !== "in_progress") continue
        return "Compacting the context"
      case "plan":
        return "Working through the plan"
      case "thought":
        return "Thinking it through"
      case "agent":
        return "Writing a reply"
      case "user":
        /* The turn is open and the agent has not said a word yet — which is a
           real stage of a turn (the model is reading the prompt), and naming it
           is what stops the line reading as "Working" from send to finish. */
        return "Reading your message"
      case "error":
        /* A retry the agent is reporting: the line says it while nothing newer
           has arrived — and only then. A step that lands after it, or settles
           after it, is the turn moving again, and the walk must not step back
           past that to find it. */
        if (item.transient && items.slice(i + 1).every((later) => later.parentId)) return item.title
        continue
      default:
        // A notice or an error is not what the turn is doing; keep walking.
        continue
    }
  }
  return "Working on it"
}

/**
 * The one line a thread says about itself while something is happening.
 *
 * Seven sentences reach it and they used to reach it through two components
 * with the same body: six from `startingLine` — spawning, restarting, reading,
 * loading, connecting, reconnecting — and one from `workingMessage`, the turn
 * itself. Duplicated, the two drifted (only one carried `max-w-full`, only one
 * had a `title`), and worse, every step of one uninterrupted wait was a cut,
 * because the only thing the reader has to follow from stage to stage is a
 * sentence being *replaced* in a line that never moves.
 *
 * The mark is deliberately outside the swap. It glints for as long as the
 * thread is busy — the same sweep the sidebar's makes every few seconds, run
 * continuously — and re-keying it on each sentence would restart that glint
 * four times on the way from "Spawning the agent…" to "Working…".
 */
export function PhaseLine({
  text,
  still = false,
  tone = "normal",
  label,
}: {
  text: string
  /** Nothing is moving — a held turn or a stopped connection. */
  still?: boolean
  /** A connection failure uses the same transcript line with destructive color. */
  tone?: "normal" | "error"
  label: string
}) {
  return (
    <div
      aria-label={label}
      // flex, not inline-flex: an inline-flex box is sized by its content, so
      // the `truncate` below had nothing to truncate against and a long tool
      // heading (a whole bash command, a long path) ran off the transcript.
      className={cn(
        "flex min-w-0 max-w-full items-center gap-2",
        tone === "error" ? "text-destructive" : still ? "text-muted-foreground" : "text-primary",
      )}
      role="status"
    >
      {/* size-4 sits on the step row's 1.5rem line box. */}
      <Logo working={!still && tone === "normal"} className="size-4 shrink-0" />
      {/* The wave animates each letter, never this span, so the swap below keeps
          this span's transition to itself (`harness-phase-swap` in index.css — written
          when the sweep owned `animation` here and a nested span went blank).
          leading-6 matches a step row's line box, so the line keeps the
          transcript's vertical rhythm. */}
      <span
        key={text}
        aria-hidden
        className="harness-phase-swap min-w-0 truncate text-xs leading-6"
        title={still ? text : undefined}
      >
        {still ? text : <ShimmerWave text={text} />}
      </span>
    </div>
  )
}
