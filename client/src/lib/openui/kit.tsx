/* ── The OpenUI kit ──
   The shared render helpers every component in this library draws with — the
   type scale, the one framed surface and the chart colours. They live apart from
   `library.tsx` so a component file can import them without importing the
   library (which imports it back). One `SurfaceContext` exists, defined here
   once, so a `StatRow`'s cell and a `Box` read the same instance. */
import { createContext, useContext, type CSSProperties, type ReactNode } from "react"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

export const TITLE = "break-words font-heading text-base leading-snug font-medium text-foreground"
export const BODY = "break-words text-sm leading-relaxed text-foreground"
export const META = "break-words text-xs leading-snug text-muted-foreground"
export const LABEL = "break-words text-xs leading-tight font-medium text-muted-foreground"
export const PAD = "p-3 @panel-sm:p-4"
export const PAD_ROW = "px-3 py-2 @panel-sm:px-4 @panel-sm:py-2.5"
/** Between siblings, everywhere: a stack, a card's body, a tab's panel. */
export const FLOW = "flex w-full min-w-0 flex-col gap-3 @panel-sm:gap-4"

/** The well a frame inside a frame becomes — the settings kit's `INSET`. */
export const INSET = "rounded-xl border bg-muted/50"

export type Surface = "page" | "frame" | "cell"
export const SurfaceContext = createContext<Surface>("page")

/** The one framed thing. What it looks like is where it is, never the caller's
    choice — which is the whole of "styled the same". On the page it is the
    registry `Card` (its spacing and flex column zeroed, so the caller lays out
    its own body); inside a frame it is a well; inside a `StatRow` a bare cell.
    Its children are inside a frame, so anything framed among them draws as a well. */
export function Box({ className, children, style }: { className?: string; children: ReactNode; style?: CSSProperties }) {
  const surface = useContext(SurfaceContext)
  const box = cn("w-full min-w-0 overflow-hidden", className)
  return (
    <SurfaceContext.Provider value="frame">
      {surface === "page" ? (
        <Card className={cn("block gap-0 py-0", box)} style={style}>
          {children}
        </Card>
      ) : (
        <div className={cn(surface === "frame" && INSET, box)} style={style}>
          {children}
        </div>
      )}
    </SurfaceContext.Provider>
  )
}

/** A frame's top band: a name and what qualifies it, over a hairline. */
export function BoxHeader({ title, meta }: { title: ReactNode; meta?: ReactNode }) {
  return (
    <header className="min-w-0 space-y-0.5 border-b px-3 py-3 @panel-sm:px-4">
      <div className={TITLE}>{title}</div>
      {meta && <div className={cn(META, "text-pretty")}>{meta}</div>}
    </header>
  )
}

/** What a chip's tone dot is filled with: the app's status tokens. */
export const TONE_DOT = {
  neutral: "bg-muted-foreground",
  info: "bg-primary",
  success: "bg-success",
  warn: "bg-warning",
  error: "bg-destructive",
} as const

/** Colours are the app's `--chart-*` tokens. */
export const chartColor = (index: number) => `var(--chart-${(index % 5) + 1})`
