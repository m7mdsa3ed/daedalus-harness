/* ── What the user typed ── the prose of a user bubble, drawn with the
   composer's chips: a quote, a long paste and an `@` mention sit in the line
   as they did in the box (`user-chips.tsx`). A leaf: it draws no rows and
   recurses into nothing, so it lives apart from the mutually recursive cluster
   in `rows.tsx`, which imports it for the `user` case. The composer's queue
   draws it too, through the `thread-items` barrel. */
import * as React from "react"
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react"

import { Prose } from "@/components/prose"
import { UserPastes, UserTasks, collapsePastes } from "@/components/thread-items/user-chips"
import { useFollowRelease } from "@/components/thread-view/dormant"
import { splitTaskContext } from "@/lib/task-mentions"
import { cn } from "cn"

export function UserMessageText({ text }: { text: string }) {
  const { collapsed, tasks } = React.useMemo(() => {
    const split = splitTaskContext(text)
    return { collapsed: collapsePastes(split.text), tasks: split.tasks }
  }, [text])
  return (
    <UserTasks tasks={tasks}>
      <UserPastes pastes={collapsed.pastes}>
        <Prose text={collapsed.text} mentions />
      </UserPastes>
    </UserTasks>
  )
}

/* ── A long prompt folds ── A pasted brief can be hundreds of lines, and at that
   length the prompt buries the answer under it and the next one out of sight.
   So the bubble stops growing at `FOLD` and offers the rest on a click, the way
   a subagent's brief does (`tool-views/subagent.tsx`, `BriefSection`).

   A fold, not a scroll box. The bubble lives inside the transcript's own
   scroller, and a nested one captures the wheel and the touch drag over exactly
   the region a reader is most likely to swipe — the long message they want to
   scroll past. Folding keeps one scrollbar in the transcript.

   Measured, never guessed from the text: chips, attachments and images decide
   the height too, and a fold that guessed would clip a short message with no
   way to open it. Watched with a `ResizeObserver` because a pasted image lands
   after mount and grows the body under a fold already decided. */
const FOLD = "max-h-72"

export function UserMessageFold({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const release = useFollowRelease()
  const body = React.useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = React.useState(false)
  React.useLayoutEffect(() => {
    const el = body.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el.firstElementChild ?? el)
    return () => observer.disconnect()
  }, [open])

  return (
    <>
      <div
        ref={body}
        className={cn(
          !open && FOLD,
          // The bubble's own content is `overflow-hidden` already; the fold reads
          // it as a clip and the fade says there is more under the edge.
          "overflow-hidden",
          !open && overflows && "[mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
        )}
      >
        <div>{children}</div>
      </div>
      {(overflows || open) && (
        <button
          type="button"
          onClick={() => {
            // The rest of a prompt arrives above the tail, so opening it says
            // the reader has left the bottom — else the pin hands the new
            // lines to the end of the transcript and they never see them.
            if (!open) release?.()
            setOpen((value) => !value)
          }}
          aria-expanded={open}
          className="mt-1 flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? <ChevronUpIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </>
  )
}
