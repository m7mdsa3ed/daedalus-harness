import type * as React from "react"
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * An entrance's place in the batch that mounts with it (`.harness-item-in` and
 * `.harness-rail-draw`, index.css). Beside `cn` because it is the same kind of
 * thing — the other half of a class the stylesheet owns — and because the two
 * callers are the transcript's two halves.
 *
 * It is a *position*, not a duration: the stylesheet decides what a step of it
 * is worth and where it stops counting, so tuning the cascade never means
 * finding the call sites. The cast is the whole reason this exists as a
 * function — `CSSProperties` has no index signature for custom properties, and
 * eight inline `as` casts is eight places to get the property name wrong.
 */
export function stagger(index: number): React.CSSProperties {
  return { "--item-i": Math.max(0, index) } as React.CSSProperties
}
