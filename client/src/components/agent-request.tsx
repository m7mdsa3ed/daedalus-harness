/* ── The agent is blocked on you ──
   Two things stop a turn dead and wait for a human: a permission request
   (`tool-approval.tsx`) and a question (`elicitation-form.tsx`). They are the
   same event as far as the transcript is concerned — everything below this card
   is waiting on the thing inside it — so they are built from one shell here
   rather than each inventing its own.

   The layout is a ROOMY STACK, read top to bottom: who is asking, what is being
   asked, the evidence for it in its own well, then the answers on a bar of
   their own. Each band does one job and gets the room to do it. This card is
   the only place in the transcript where the app asks the user for something
   rather than telling them something, and cramming that into a dense row —
   which earlier passes did — makes the one thing you must read look like one
   more thing you may skim.

   It is the stock `Card`. Inside, the payload well and the action bar separate
   themselves by surface and by a hairline, never by boxing themselves. */
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export function AgentRequestCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Card
      aria-live="polite"
      role="group"
      data-slot="agent-request"
      className={cn(
        // p-4 is the card's whole gutter — bands inside it add no
        // horizontal padding of their own, so every edge lines up.
        "my-2 gap-0 p-4",
        "animate-in duration-200 fade-in slide-in-from-bottom-1",
        className
      )}
      {...props}
    />
  )
}

/**
 * Who is asking, and what they are asking about.
 *
 * `label` shimmers: this is the one thing on screen that is waiting, and the
 * shimmer is what the working line and a live plan step already use to say
 * "now". `aside` is the transcript's right-hand column — the tool kind, the
 * step dots — at caption weight so it never competes with the question.
 */
export function AgentRequestHeader({
  icon: Icon,
  label,
  aside,
  children,
}: {
  icon: React.ElementType
  label: string
  aside?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Icon aria-hidden className="size-3 shrink-0 text-primary" />
        <p className="harness-shimmer min-w-0 flex-1 truncate text-xs leading-5 font-medium text-primary">
          {label}
        </p>
        {aside}
      </div>
      {/* The subject gets its own line at the app's title tier — it is the
          sentence the whole card exists to put in front of you. */}
      {children && <div className="font-heading text-base leading-snug font-medium break-words">{children}</div>}
    </div>
  )
}

/** The middle band: the evidence, the choices, the details disclosure. */
export function AgentRequestBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-3 space-y-3", className)} {...props} />
}

/**
 * A payload's own surface inside the card — a diff, a blob of arguments, a
 * preview: the muted well, never a bordered box, which would read as a second
 * card.
 */
export function AgentRequestWell({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("overflow-hidden rounded-lg bg-muted p-3", className)}
      {...props}
    />
  )
}

/**
 * The answers, on a band of their own at the foot of the card.
 *
 * Full-bleed hairline above it: the actions are a different kind of thing from
 * everything above, and after a diff of unknown length the eye needs a floor to
 * land on. `-mx-4 px-4` undoes the card's gutter so the rule spans the whole
 * width — a rule that stops short of the edges looks like a mistake.
 *
 * Callers place their own `ms-auto`: what goes left and what goes right is a
 * decision about the specific answer (deny away from allow, dismiss away from
 * submit), not about bars.
 */
export function AgentRequestActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "-mx-4 mt-4 flex flex-wrap items-center gap-2 border-t px-4 pt-4",
        className
      )}
      {...props}
    />
  )
}

/** One size for every button on these cards: the stock `sm` button. Callers
    here pass `size="sm"`; this spells the same geometry for a button that
    cannot take the prop. */
export const REQUEST_BUTTON = "h-8 gap-1 px-3"
