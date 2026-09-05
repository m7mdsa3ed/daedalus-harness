import * as React from "react"

import { cn } from "@/lib/utils"

/* A progressive (gradient) backdrop blur for one edge of a scroll container.

   The stepped stack: five `backdrop-filter` layers whose blur doubles each
   step (1 -> 16px), each masked to a feathered band — the strongest pinned to
   the edge, the weakest reaching furthest in. Where the bands overlap the
   radii compound, so focus ramps continuously toward the edge instead of one
   flat blur merely being faded. Under them, a surface tint ramps from 70% at
   the edge to nothing by 70% of the strip — the header's legibility comes
   from the tint near the edge and from the blur alone below it. Over a flat
   surface the mix is invisible at any strength (surface over surface is
   surface).

   Masks read alpha, not colour: black/transparent, never the tint colour.
   Pure CSS: no observer, no library. Place it absolutely against the scroll
   container's root (which must be a positioning context and must sit *over*
   the scrolled content), size it with `className`, and toggle `visible` from
   the container's own "more above / below" state.

   The gradients are inline styles on purpose: they are computed from the
   side and there is nothing to name. */

type Side = "top" | "bottom"

/* Edge-first: the largest radius is masked to the narrowest band at the
   edge; each smaller radius reaches further in. Stops are percentages of
   the strip's height, feathered where neighbouring bands meet. */
const LAYERS = [
  { blur: 16, edge: 30, feather: 45 },
  { blur: 8, edge: 50, feather: 65 },
  { blur: 4, edge: 70, feather: 82 },
  { blur: 2, edge: 85, feather: 94 },
  { blur: 1, edge: 92, feather: 100 },
] as const

export function ProgressiveBlur({
  side = "top",
  visible = true,
  className,
  style,
  ...props
}: React.ComponentProps<"div"> & { side?: Side; visible?: boolean }) {
  const inward = side === "top" ? "to bottom" : "to top"
  return (
    <div
      aria-hidden
      data-slot="progressive-blur"
      data-side={side}
      data-visible={visible ? "true" : "false"}
      className={cn(
        "pointer-events-none transition-opacity duration-300 data-[visible=false]:opacity-0",
        className
      )}
      style={style}
      {...props}
    >
      {LAYERS.map(({ blur, edge, feather }) => {
        const mask = `linear-gradient(${inward}, black ${edge}%, transparent ${feather}%)`
        return (
          <div
            key={blur}
            className="absolute inset-0"
            style={{
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              maskImage: mask,
              WebkitMaskImage: mask,
            }}
          />
        )
      })}
      <div
        className="absolute inset-0"
        style={{
          background: `linear-gradient(${inward}, color-mix(in oklab, var(--surface) 70%, transparent), transparent 70%)`,
        }}
      />
    </div>
  )
}
