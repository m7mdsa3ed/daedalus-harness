import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

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
        <div className="w-1/3 space-y-2 rounded-lg bg-muted/50 p-3">
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

/* `animate-none skeleton-shimmer`: the sidebar's placeholders sweep rather than
   pulse (index.css), and each bar starts a beat after the one above it so the
   list reads as a wave and not as one block blinking. */
const SHIMMER = "animate-none skeleton-shimmer"

function SidebarRows({ rows }: { rows: number }) {
  return (
    <div className="space-y-1 px-2">
      {[...Array(rows).keys()].map((index) => (
        <div key={index} className="flex items-center gap-2 rounded-md px-2 py-1.5">
          <Skeleton className={cn("size-4 shrink-0 rounded-sm", SHIMMER)} style={{ animationDelay: `${index * 120}ms` }} />
          <Skeleton className={cn("h-3 flex-1", SHIMMER)} style={{ animationDelay: `${index * 120}ms` }} />
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
        <Skeleton className={cn("ml-2 h-3 w-16", SHIMMER)} />
      </div>
      <SidebarRows rows={4} />
      <div className="px-2 pb-1 pt-4">
        <Skeleton className={cn("ml-2 h-3 w-20", SHIMMER)} />
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

/** Rows in a settings `Group`, in the shape `Row` draws them: an optional group
    caption, then a bordered card of icon/title/subtitle lines. */
export function GroupRowsSkeleton({
  rows = 4,
  label = false,
  className,
}: {
  rows?: number
  label?: boolean
  className?: string
}) {
  return (
    <section aria-busy="true" className={cn("mb-6 last:mb-0", className)}>
      {label && <Skeleton className="mb-2 ml-1 h-3 w-16" />}
      <div className="divide-y overflow-hidden rounded-2xl bg-card ring-1 ring-foreground/10">
        {[...Array(rows).keys()].map((index) => (
          <div key={index} className="flex items-center gap-3 px-3.5 py-3 sm:px-4">
            <Skeleton className="mt-0.5 size-4 shrink-0 self-start rounded-sm" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3.5 w-40 max-w-full" />
              <Skeleton className="mt-1.5 h-3 w-64 max-w-full" />
            </div>
            <Skeleton className="size-7 shrink-0 rounded-full" />
          </div>
        ))}
      </div>
    </section>
  )
}

/** One notice, in the shape the inbox draws it: glyph disc, title, age, body.
    `detailed` is the page's face, matching `NotificationRow`'s own paddings and
    minimum height so the list does not jump when the real rows land. */
export function NotificationRowsSkeleton({
  rows = 4,
  detailed = false,
  className,
}: {
  rows?: number
  detailed?: boolean
  className?: string
}) {
  return (
    <ul aria-busy="true" className={cn("divide-y", className)}>
      {[...Array(rows).keys()].map((index) => (
        <li
          key={index}
          className={cn("flex items-start gap-3", detailed ? "min-h-[116px] px-4 py-3.5" : "px-3 py-2.5")}
        >
          <Skeleton className={cn("shrink-0 rounded-full", detailed ? "mt-0.5 size-8" : "size-7")} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <Skeleton className="h-3.5 flex-1" />
              <Skeleton className="h-3 w-8 shrink-0" />
            </div>
            <Skeleton className="mt-1.5 h-3 w-3/4" />
            {detailed && <Skeleton className="mt-2.5 h-3 w-24" />}
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The lines of a text surface — a file in a tab — with a gutter for the
    numbers, so the pane is already laid out when the read lands. */
export function CodeLinesSkeleton({ lines = 14, className }: { lines?: number; className?: string }) {
  return (
    <div aria-busy="true" className={cn("space-y-2 p-4", className)}>
      {[...Array(lines).keys()].map((index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-3 w-6 shrink-0 rounded-sm opacity-60" />
          <Skeleton className="h-3" style={{ width: `${35 + ((index * 29) % 55)}%` }} />
        </div>
      ))}
    </div>
  )
}

/** Hunks of a diff before either side has landed: a header and lines whose
    added/removed tints say what a diff is. */
export function DiffRowsSkeleton({ hunks = 3, className }: { hunks?: number; className?: string }) {
  return (
    <div aria-busy="true" className={cn("space-y-4 p-3", className)}>
      {[...Array(hunks).keys()].map((hunk) => (
        <div key={hunk} className="overflow-hidden rounded-lg border">
          <Skeleton className="h-6 w-full rounded-none opacity-70" />
          {[...Array(4).keys()].map((line) => (
            <div key={line} className="flex items-center gap-3 px-3 py-1">
              <Skeleton className="h-3 w-6 shrink-0 rounded-sm opacity-50" />
              <Skeleton
                className={cn(
                  "h-3",
                  line === 1 || line === 2 ? "bg-success/30" : line === 3 ? "bg-destructive/25" : ""
                )}
                style={{ width: `${30 + ((line * 31) % 60)}%` }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

/** Short rows in a panel's list — a log, a stash list, a repository's files.
    `split` is the name-then-path shape a file search draws. */
export function PanelRowsSkeleton({
  rows = 4,
  split = false,
  className,
}: {
  rows?: number
  split?: boolean
  className?: string
}) {
  return (
    <div aria-busy="true" className={cn("space-y-2 p-2", className)}>
      {[...Array(rows).keys()].map((index) => (
        <div key={index} className="flex items-center gap-2 px-1">
          <Skeleton
            className={cn("h-3", split && "w-20 shrink-0")}
            style={split ? undefined : { width: `${45 + ((index * 23) % 45)}%` }}
          />
          {split && <Skeleton className="h-3 flex-1 opacity-60" />}
        </div>
      ))}
    </div>
  )
}

export function SetupCardsSkeleton() {
  return (
    <div aria-busy="true" className="mt-8 grid gap-2 text-left sm:grid-cols-2">
      {[0, 1].map((index) => (
        <div key={index} className="rounded-2xl bg-card p-4 ring-1 ring-foreground/10">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-1.5 h-3 w-3/4" />
        </div>
      ))}
    </div>
  )
}
