/* ── The Daedalus mark ──
   A labyrinth read as two broken rings around a centre: the maze Daedalus
   built, and — closer to home — a frame finding its way in and back out. The
   two gaps sit on opposite sides so the mark reads as a route, not a target.

   Drawn in strokes on a 64 grid, in currentColor, so it inherits the palette
   (the sidebar renders it in `text-primary`) instead of pinning one brand teal
   that fights every custom theme. Keep the geometry in sync with
   public/logo.svg (favicon/PWA) and the boot splash in index.html — the splash
   draws these same three paths in order. */
import { cn } from "@/lib/utils"

/** `working` traces the rings on a loop; `idle` retraces them once every few
    seconds — `.harness-logo-working` / `.harness-logo-idle` in index.css.
    pathLength normalises the two rings so one dash rule drives both. */
export function Logo({
  className,
  working = false,
  idle = false,
  title,
  ...props
}: React.ComponentProps<"svg"> & { working?: boolean; idle?: boolean; title?: string }) {
  const pathLength = working || idle ? 1 : undefined
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decoration by default; a working mark is a live status and says so.
      aria-hidden={title ? undefined : true}
      role={title ? "status" : undefined}
      className={cn(
        "size-7",
        working ? "harness-logo-working" : idle && "harness-logo-idle",
        className
      )}
      {...props}
    >
      {/* <title> is both the tooltip and the accessible name. */}
      {title && <title>{title}</title>}
      {/* Outer ring, open at the top — the way in. */}
      <path data-logo="ring" pathLength={pathLength} d="M38 8H46A10 10 0 0 1 56 18V46A10 10 0 0 1 46 56H18A10 10 0 0 1 8 46V18A10 10 0 0 1 18 8H26" />
      {/* Inner ring, open at the bottom — the turn. */}
      <path data-logo="ring ring-inner" pathLength={pathLength} d="M28 45H25A6 6 0 0 1 19 39V25A6 6 0 0 1 25 19H39A6 6 0 0 1 45 25V39A6 6 0 0 1 39 45H36" />
      {/* The centre it leads to. */}
      <path data-logo="core" pathLength={pathLength} d="M32 31V33" />
    </svg>
  )
}
