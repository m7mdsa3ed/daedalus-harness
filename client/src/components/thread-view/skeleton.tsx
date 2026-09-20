/* ── The stand-in while a thread is being read ── drawn only for a thread that
   is *opening and has nothing yet*, and taken away by the first item that
   lands.

   A skeleton used to live in the transcript unconditionally and was removed
   for a good reason: it claimed a shape for content nobody had seen yet, and on
   a thread that turned out to be empty it was a lie twice over. Both halves of
   that are gated here instead of argued away — it is never drawn for a draft
   (which has no transcript to load), and it never outlives the first real row,
   so the only thread it can lie about is one whose journal comes back empty.
   The wait at the foot (`StartingLine`) still owns the *words*; this owns the
   fact that the pane is not blank while they are said. */
import { Skeleton } from "@/components/ui/skeleton"

/** Three plausible rows: a short user line, a paragraph, a tool-ish block. The
    widths are fixed rather than random — a skeleton that reshuffles on every
    render is motion about nothing. */
export function ThreadSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-6 py-2 opacity-60">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-2/5" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/5" />
      </div>
      <Skeleton className="h-16 w-full" />
    </div>
  )
}
