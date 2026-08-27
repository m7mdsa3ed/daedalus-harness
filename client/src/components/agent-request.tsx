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

   It carries NO BORDER. The accent wash is what makes it findable: an outline
   plus a fill is two ways of saying the same thing, and the outline is the one
   that makes a card look pasted onto the transcript instead of part of it.
   Inside, the payload well and the action bar separate themselves the same way
   — by surface and by a hairline, never by boxing themselves. */
import { cn } from "@/lib/utils"

export function AgentRequestCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-live="polite"
      role="group"
      data-slot="agent-request"
      className={cn(
        // px-4/py-3.5 is the card's whole gutter — bands inside it add no
        // horizontal padding of their own, so every edge lines up.
        "my-3 overflow-hidden rounded-xl bg-primary/[0.06] px-4 py-3.5 text-xs",
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
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Icon aria-hidden className="size-3.5 shrink-0 text-primary" />
        <p className="harness-shimmer min-w-0 flex-1 truncate text-[10px] font-semibold tracking-[0.08em] text-primary uppercase">
          {label}
        </p>
        {aside}
      </div>
      {/* The subject gets its own line at the app's title tier — it is the
          sentence the whole card exists to put in front of you. */}
      {children && <div className="text-sm leading-snug font-medium break-words">{children}</div>}
    </div>
  )
}

/** The middle band: the evidence, the choices, the details disclosure. */
export function AgentRequestBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("mt-3 space-y-2.5", className)} {...props} />
}

/**
 * A payload's own surface inside the tint — a diff, a blob of arguments, a
 * preview. It steps DOWN to the page background rather than up to a bordered
 * box: against a tinted card, a recess reads as "this is the material" where an
 * outline would read as a second card.
 */
export function AgentRequestWell({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("overflow-hidden rounded-lg bg-background/60 p-2.5", className)}
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
        "-mx-4 mt-3.5 flex flex-wrap items-center gap-2 border-t border-primary/15 px-4 pt-3",
        className
      )}
      {...props}
    />
  )
}

/** One size for every button on these cards. Squared off and full height, not
    the transcript's little pills: these are the decisions that unblock the
    agent, and on a roomy card a pill reads as an afterthought. */
export const REQUEST_BUTTON = "h-8 gap-1.5 rounded-lg px-3 text-[11px]"
