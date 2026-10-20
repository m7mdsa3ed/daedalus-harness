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
    <div className="space-y-1">
      {[...Array(rows).keys()].map((index) => (
        // The stock row: h-9 px-3 gap-2, a size-4 mark.
        <div key={index} className="flex h-9 items-center gap-2 px-3">
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
      {/* The stock group: p-2, an h-8 px-3 label over the rows. */}
      <div className="p-2">
        <div className="flex h-8 items-center px-3">
          <Skeleton className={cn("h-3 w-16", SHIMMER)} />
        </div>
        <SidebarRows rows={4} />
      </div>
      <div className="p-2">
        <div className="flex h-8 items-center px-3">
          <Skeleton className={cn("h-3 w-20", SHIMMER)} />
        </div>
        <SidebarRows rows={3} />
      </div>
    </div>
  )
}

/** A settings section before its page has loaded: the header's shape (mark,
    title, description, rule) over a card of rows, so the frame is already laid
    out when the page lands. */
export function SettingsSectionSkeleton() {
  return (
    <div aria-busy="true">
      <div className="mb-8 flex items-start gap-4 border-b pb-6">
        <Skeleton className="hidden size-10 shrink-0 rounded-lg @panel-sm:block" />
        <div className="min-w-0 flex-1">
          <Skeleton className="h-8 w-48 max-w-full" />
          <Skeleton className="mt-2 h-4 w-2/3" />
        </div>
      </div>
      <GroupRowsSkeleton label />
    </div>
  )
}

/** The rows of a `Picker` — the same inset list, checkbox and two lines. */
export function PickerSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    /* `INSET` from settings/primitives, spelled here: importing it would cycle. */
    <div aria-busy="true" className="divide-y rounded-xl border bg-muted/50">
      {[...Array(rows).keys()].map((index) => (
        <div key={index} className="flex items-start gap-3 px-3 py-2">
          <Skeleton className="mt-0.5 size-4 shrink-0 rounded-sm" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3.5 w-36 max-w-full" />
            <Skeleton className="mt-1.5 h-3 w-52 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

/** A `Group` before its rows have landed, in `Row`'s shape: an optional
    heading, then the kit's card of icon/title/subtitle lines. Spaced like a
    `Section`, so it stands in a page's flow of blocks where the real one will. */
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
    <section aria-busy="true" className={cn("mt-8 first:mt-0", className)}>
      {label && <Skeleton className="mb-3 ml-1 h-5 w-32" />}
      <div className="divide-y overflow-hidden rounded-2xl bg-card px-3 ring-1 ring-foreground/10 @panel-sm:px-4">
        {[...Array(rows).keys()].map((index) => (
          <div key={index} className="flex min-h-12 items-center gap-3 py-3">
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
          className="flex min-h-12 items-start gap-3 p-3 @panel-sm:p-4"
        >
          <Skeleton className="mt-0.5 size-8 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <Skeleton className="h-3.5 flex-1" />
              <Skeleton className="h-3 w-8 shrink-0" />
            </div>
            <Skeleton className="mt-1 h-3 w-3/4" />
            {detailed && <Skeleton className="mt-2 h-3 w-24" />}
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
