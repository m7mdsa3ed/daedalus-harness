import type * as React from "react"

import { cn } from "@/lib/utils"

/* A working label whose letters lift and brighten in a wave — morphin's
   text-shimmer-wave, as CSS. One animation per letter, delayed by its share of
   the text, so a crest crosses a label of any length once per cycle. Kept for
   the transcript's working lines; `.harness-shimmer` stays everywhere else,
   because twenty waving labels on one screen is noise, not status.

   The letters are aria-hidden and the text is said once, whole — a reader
   spelling "W, o, r, k" is what per-letter spans otherwise cost. */
export function ShimmerWave({ text, className }: { text: string; className?: string }) {
  const letters = Array.from(text)
  return (
    <span className={cn("harness-wave", className)}>
      <span className="sr-only">{text}</span>
      {letters.map((letter, i) => (
        <span key={i} aria-hidden style={{ "--i": i, "--n": letters.length } as React.CSSProperties}>
          {letter}
        </span>
      ))}
    </span>
  )
}
