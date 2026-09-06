import { Skeleton } from "@/components/ui/skeleton"

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number
  className?: string
}) {
  return (
    <div aria-hidden className={className}>
      {[...Array(lines).keys()].map((index) => (
        <Skeleton
          key={index}
          className={index === lines - 1 ? "h-3 w-2/5" : "mb-1.5 h-3 w-full last:mb-0"}
        />
      ))}
    </div>
  )
}

export function TranscriptSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4">
      <div className="flex justify-end">
        <div className="w-1/3 space-y-2 rounded-lg bg-muted/40 p-3">
          <SkeletonText lines={2} />
        </div>
      </div>
      {/* Mirrors a real step row: flush left column, no gutter — so the
          transcript doesn't jump when it swaps in. */}
      {[3, 2, 4].map((lines, index) => (
        <div key={index}>
          <div className="min-w-0 space-y-2 pt-0.5">
            <Skeleton className="h-3 w-28" />
            <SkeletonText lines={lines} />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ToolCallSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={className}>
      <Skeleton className="h-3 w-3/5" />
      <Skeleton className="mt-1.5 h-3 w-2/5" />
    </div>
  )
}

function SidebarRows({ rows }: { rows: number }) {
  return (
    <div className="space-y-1 px-2">
      {[...Array(rows).keys()].map((index) => (
        <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <Skeleton className="h-3 flex-1" />
        </div>
      ))}
    </div>
  )
}

export function SidebarGroupsSkeleton() {
  return (
    // Hidden in the icon rail for the same reason the list itself is: a rail
    // of blank placeholder rows says nothing 3rem wide.
    <div aria-busy="true" className="group-data-[collapsible=icon]:hidden">
      <div className="px-2 pb-1 pt-4">
        <Skeleton className="ml-2 h-3 w-16" />
      </div>
      <SidebarRows rows={4} />
      <div className="px-2 pb-1 pt-4">
        <Skeleton className="ml-2 h-3 w-20" />
      </div>
      <SidebarRows rows={3} />
    </div>
  )
}

export function SettingsSectionSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4">
      <div className="space-y-1.5">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3 w-72" />
      </div>
      <div className="rounded-lg border">
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
            <Skeleton className="size-8 shrink-0 rounded-md" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-1.5 h-3 w-48" />
            </div>
            <Skeleton className="size-7 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  )
}

export function PickerSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="divide-y rounded-lg border">
      {[...Array(rows).keys()].map((index) => (
        <div key={index} className="flex items-center gap-3 p-3">
          <Skeleton className="size-4 shrink-0 rounded-sm" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3 w-36" />
            <Skeleton className="mt-1.5 h-3 w-52" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function SetupCardsSkeleton() {
  return (
    <div aria-busy="true" className="mt-8 grid gap-2 text-left sm:grid-cols-2">
      {[0, 1].map((index) => (
        <div key={index} className="rounded-xl border bg-card p-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1.5 h-3 w-3/4" />
        </div>
      ))}
    </div>
  )
}
