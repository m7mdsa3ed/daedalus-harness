/* The landing page while the catalogs are still loading: the hero's shape and
   a row of feature cards, all skeletons — a page that is going to look like
   the page, not a paragraph that shrinks into one. */
import { Skeleton } from "@/components/ui/skeleton"

export function LandingSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 pt-[calc(var(--app-header-h)+2.5rem)] pb-16 sm:px-8 sm:pt-[calc(var(--app-header-h)+4rem)]">
      <div aria-busy="true" className="w-full max-w-3xl text-center">
        <Skeleton className="mx-auto size-11 rounded-full" />
        <Skeleton className="mx-auto mt-6 h-10 w-3/4 sm:h-14" />
        <Skeleton className="mx-auto mt-4 h-10 w-1/2" />
        <Skeleton className="mx-auto mt-6 h-4 w-2/3" />
        <div className="mx-auto mt-10 grid max-w-xl grid-cols-2 gap-6 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="mx-auto h-14 w-20" />
          ))}
        </div>
        <div className="mt-16 flex flex-col items-center">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="mt-2 h-3 w-72" />
          <div className="mt-6 grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-32 w-full rounded-2xl" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}