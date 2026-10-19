/* ── The OpenUI kit ──
   The shared render helpers every component in this library draws with — the
   type scale, the one framed surface and the chart colours. They live apart from
   `library.tsx` so a component file can import them without importing the
   library (which imports it back). One `SurfaceContext` exists, defined here
   once, so a `StatRow`'s cell and a `Box` read the same instance. */
import { createContext, useContext, type CSSProperties, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export const TITLE = "break-words text-[13.5px] leading-snug font-semibold tracking-tight text-foreground"
export const BODY = "break-words text-[13px] leading-relaxed text-foreground/90"
export const META = "break-words text-xs leading-snug text-muted-foreground"
export const LABEL = "break-words text-[10.5px] leading-tight font-medium tracking-[0.06em] uppercase text-muted-foreground"
export const PAD = "px-3 py-2.5 @panel-sm:px-3.5 @panel-sm:py-3"
export const PAD_ROW = "px-3 py-2 @panel-sm:px-3.5"
/** Between siblings, everywhere: a stack, a card's body, a tab's panel. */
export const FLOW = "flex w-full min-w-0 flex-col gap-2.5 @panel-sm:gap-3"
export const HAIRLINE = "border-border/60"

export const FRAME = "rounded-xl border border-border/70 bg-card shadow-xs"
export const INSET = "rounded-lg border border-border/40 bg-muted/40"

export type Surface = "page" | "frame" | "cell"
export const SurfaceContext = createContext<Surface>("page")

/** The one framed thing. What it looks like is where it is, never the caller's
    choice — which is the whole of "styled the same". Its children are inside a
    frame, so anything framed among them draws as a well. */
export function Box({ className, children, style }: { className?: string; children: ReactNode; style?: CSSProperties }) {
  const surface = useContext(SurfaceContext)
  return (
    <SurfaceContext.Provider value="frame">
      <div
        className={cn(
          "w-full min-w-0 overflow-hidden",
          surface === "page" ? FRAME : surface === "frame" ? INSET : "bg-card",
          className
        )}
        style={style}
      >
        {children}
      </div>
    </SurfaceContext.Provider>
  )
}

/** A frame's top band: a name and what qualifies it, over a hairline. */
export function BoxHeader({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <header className={cn("min-w-0 space-y-0.5 border-b", HAIRLINE, PAD_ROW, "py-2.5")}>
      <div className={TITLE}>{title}</div>
      {meta && <div className={cn(META, "text-pretty")}>{meta}</div>}
    </header>
  )
}

/** The one chip: a Badges item and a card tag are the same thing. */
export const CHIP = "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-card px-2 py-0.5 text-xs font-medium text-foreground/90 shadow-xs"

export const TONE_DOT = {
  neutral: "bg-muted-foreground/50",
  info: "bg-chart-2",
  success: "bg-primary",
  warn: "bg-chart-3",
  error: "bg-destructive",
} as const

/** Colours are the app's `--chart-*` tokens. */
export const chartColor = (index: number) => `var(--chart-${(index % 5) + 1})`
