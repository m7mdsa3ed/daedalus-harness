/* The landing page while the catalogs load. A skeleton is a promise about the
   next frame, so it has to be shaped like the page — which is the empty
   thread's own welcome and composer, centred, with the launcher strip under
   them. It has been shaped like a hero and then like a console card that no
   longer exist; this one is a mark, two lines, a box and the strip, in the
   place they are about to appear. */
import { Skeleton } from "@/components/ui/skeleton"

export function LandingSkeleton() {
  return (
    <div
      aria-busy="true"
      className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] pt-[var(--app-header-h)]"
    >
      <span aria-hidden />
      <div className="mx-auto flex w-full max-w-[var(--harness-composer-width)] flex-col items-center px-4">
        {/* The greeting: the mark, its heading and its one line. */}
        <Skeleton className="mb-2 size-9 rounded-lg" />
        <Skeleton className="h-6 w-52" />
        <Skeleton className="mt-2 h-3.5 w-64" />
        {/* The shelf's footer, tucked behind the card, and the card. */}
        <Skeleton className="mt-7 h-8 w-[calc(100%-1.5rem)] rounded-t-xl" />
        <Skeleton className="h-[8.5rem] w-full rounded-2xl" />
        {/* The launcher's two rows. */}
        <Skeleton className="mt-6 h-[5.25rem] w-full rounded-xl" />
      </div>
      <span aria-hidden />
    </div>
  )
}
