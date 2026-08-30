/* ── Composer strip ──
   The shelf attached to the top of the composer. It is narrower than the
   composer and tucks its bottom edge behind it, so it reads as part of the
   same object rather than as a card floating above one — which is why the
   composer itself no longer needs a border to hold the two together.

   Generic on purpose: it is a stack, not a plan bar. Anything that belongs to
   the *turn* rather than to the message you are typing goes here — the plan
   today, queued prompts or a diff summary tomorrow. Add a child; the strip
   hides itself when every child renders nothing (`empty:hidden`), so a shelf
   with nothing on it costs no pixels. */
import { cn } from "@/lib/utils"

export function ComposerStrip({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-strip"
      className={cn(
        // -mb-4/pb-4: the bottom four units sit behind the composer, which is
        // what makes the seam disappear. Keep the two in step.
        // Width follows the composer: minus whatever the composer actually is
        // (capped on desktop, 100% of the container on mobile) the strip stays
        // 3rem narrower — ~1.5rem inset each side — instead of running flush to
        // the composer's edges when the fixed pixel cap doesn't engage.
        "mx-auto -mb-4 w-full max-w-[calc(min(100%,var(--harness-composer-width))_-_3rem)]",
        "overflow-hidden rounded-t-xl bg-muted/70 pb-4 backdrop-blur-[14px] empty:hidden",
        className
      )}
      {...props}
    />
  )
}

/** One shelf entry. Rows divide themselves so the strip stays layout-only. */
export function ComposerStripItem({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="composer-strip-item"
      className={cn("[&+&]:border-t [&+&]:border-border/40", className)}
      {...props}
    />
  )
}
