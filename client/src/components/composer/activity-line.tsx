/* ── The one line a thread says about itself ──
   `workingMessage` reads what the turn is doing off the thread; `PhaseLine`
   draws that sentence (and the six the connection ladder reaches it with);
   `ActivityIndicator` is the turn's own caller. Not a reading in the footer's
   cluster — this one lives in the transcript, where the turn is. */
import * as React from "react"
import { LoaderCircleIcon } from "lucide-react"
import { Logo } from "@/components/ui/logo"
import { CopyButton } from "@/components/ui/copy-button"
import { runningAgents } from "@/components/composer/agents-indicator"
import { CARD, Disclosure } from "@/components/tool-parts"
import { toolHeading } from "@/lib/tools"
import { type ThreadState } from "@/lib/store"
import { describeError } from "@/lib/errors"
import { holdOf } from "@/lib/thread/hold"
import { cn } from "@/lib/utils"

function RetryStatus({ retry }: { retry: NonNullable<ThreadState["retry"]> }) {
  const [detailsOpen, setDetailsOpen] = React.useState(false)
  const errorText = retry.error ? retryErrorText(retry.error) : null
  const cause = retry.error ? retryWhy(retry.error) : null
  const attempts = retry.of ? `${retry.attempt} of ${retry.of} attempts` : `Attempt ${retry.attempt}`

  return (
    <section
      aria-label="Agent retrying"
      aria-live="polite"
      className={cn(CARD, "border-destructive/25 bg-destructive/5 text-xs")}
      role="status"
    >
      <div className="flex min-w-0 items-start gap-2">
        <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin text-destructive" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="font-medium text-foreground">Retrying request</p>
            <span className="rounded-pill bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
              {attempts}
            </span>
          </div>
          {cause && <p className="break-words leading-5 text-muted-foreground">{cause}</p>}
          {errorText && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">
              <Disclosure open={detailsOpen} onToggle={() => setDetailsOpen((open) => !open)}>
                {detailsOpen ? "Hide error details" : "Show error details"}
              </Disclosure>
              <CopyButton text={errorText} size="icon-xs" className="size-6" label="Copy error" />
            </div>
          )}
          {detailsOpen && errorText && (
            <pre className="max-h-40 overflow-auto rounded-md border border-border/50 bg-background/60 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words text-muted-foreground">
              {errorText}
            </pre>
          )}
        </div>
      </div>
    </section>
  )
}

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
function retryWhy(error: unknown): string {
  const info = describeError(error)
  const first = info.detail?.split("\n")[0]?.trim()
  return first || info.title
}

function retryErrorText(error: unknown): string {
  const info = describeError(error)
  return [info.title, info.detail].filter(Boolean).join("\n\n")
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
  if (thread.retry) {
    const of = thread.retry.of ? ` of ${thread.retry.of}` : ""
    const why = thread.retry.error ? retryWhy(thread.retry.error) : ""
    return `Retrying (${thread.retry.attempt}${of})${why ? ` — ${why}` : ""}`
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
        // The step's own heading, so "Read store.tsx" here matches the row above.
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
        return "Thinking"
      case "agent":
        return "Writing"
      case "user":
        /* The turn is open and the agent has not said a word yet — which is a
           real stage of a turn (the model is reading the prompt), and naming it
           is what stops the line reading as "Working" from send to finish. */
        return "Starting the turn"
      default:
        // A notice or an error is not what the turn is doing; keep walking.
        continue
    }
  }
  return "Working"
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
  label,
}: {
  text: string
  /** Nothing is moving — a held turn. Motion here would say the agent is
      working when it is in fact waiting for the reader. */
  still?: boolean
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
        still ? "text-muted-foreground" : "text-primary",
      )}
      role="status"
    >
      {/* size-4 sits on the step row's 1.5rem line box. */}
      <Logo working={!still} className="size-4 shrink-0" />
      {/* ponytail: one flat text node — the shimmer paints a background clipped to
          text, and background-image doesn't inherit, so a nested span goes blank.
          That constraint is also why the swap below is a transition and not an
          animation: `animation` is one shorthand per element and the shimmer
          already owns it here, and the fix cannot be to nest a span. See
          `harness-phase-swap` in index.css.
          leading-6 matches a step row's line box, so the line keeps the
          transcript's vertical rhythm. */}
      <span
        key={text}
        aria-hidden
        className={cn(
          "harness-phase-swap min-w-0 truncate text-xs leading-6",
          !still && "harness-shimmer",
        )}
        title={still ? text : undefined}
      >
        {text}
      </span>
    </div>
  )
}

export function ActivityIndicator({ thread }: { thread: ThreadState }) {
  const message = workingMessage(thread)
  /* A retry owns this slot while waiting out a backoff. Keeping it in the
     transcript's card vocabulary makes the cause readable without duplicating
     it in both a shimmer line and a raw payload. */
  if (thread.retry) return <RetryStatus retry={thread.retry} />

  /* A held turn is stopped. The line stays in the same slot, which is the
     point — the turn is still open and the composer still belongs to it. */
  const held = thread.paused
  return (
    <div className="min-w-0 max-w-full">
      <PhaseLine text={held ? message : `${message}…`} still={held} label={held ? "Turn held" : "Agent working"} />
    </div>
  )
}
