/* ── The one diagram renderer ──
   `Mermaid` and `Diagram` in the component library are the same picture with
   two doors: one takes mermaid source, the other takes nodes and edges and is
   compiled to mermaid here. Both land in `MermaidFigure`, so there is exactly
   one place that loads mermaid, one place that themes it and one fallback.

   mermaid is ~1MB, so it is a dynamic import *inside* the already-lazy openui
   chunk: a transcript with a fence but no diagram never pays for it. The theme
   is mermaid's own `neutral`/`dark` rather than the app's `--chart-*` tokens,
   because mermaid does colour maths (khroma) on its theme variables and the
   palettes are `oklch`, which that maths cannot read — a var() there yields
   `NaN` fills, not a themed diagram.

   A diagram that will not parse is drawn as its source, the same bargain the
   fence itself makes: mermaid source is readable, and a red error box for a
   picture the reader did not ask for is worse than the text. */
import * as React from "react"
import { Maximize2Icon, Network } from "lucide-react"
import { Empty } from "@/components/empty"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export type DiagramNode = { id: string; label?: string; shape?: "box" | "round" | "diamond" | "circle" }
export type DiagramEdge = { from: string; to: string; label?: string; dashed?: boolean }

const SHAPE: Record<NonNullable<DiagramNode["shape"]>, [string, string]> = {
  box: ["[", "]"],
  round: ["(", ")"],
  diamond: ["{", "}"],
  circle: ["((", "))"],
}

/* mermaid ids are bare words and labels are quoted strings; both are the
   model's text, so both are sanitised rather than trusted. */
const id = (raw: string) => raw.replace(/[^\w]/g, "_") || "n"
const label = (raw: string) => `"${raw.replace(/["\n]/g, " ")}"`

/** nodes + edges → a `flowchart` program. The declarative door exists because
    mermaid syntax is one more thing for a model to get wrong, and a graph is
    the shape it gets wrong most. */
export function diagramToMermaid(
  nodes: DiagramNode[],
  edges: DiagramEdge[],
  direction: "down" | "right" = "down"
) {
  const lines = [`flowchart ${direction === "right" ? "LR" : "TD"}`]
  for (const n of nodes) {
    const [open, close] = SHAPE[n.shape ?? "box"]
    lines.push(`  ${id(n.id)}${open}${label(n.label ?? n.id)}${close}`)
  }
  for (const e of edges) {
    const arrow = e.dashed ? "-.->" : "-->"
    const text = e.label ? `|${label(e.label)}|` : ""
    lines.push(`  ${id(e.from)} ${arrow}${text} ${id(e.to)}`)
  }
  return lines.join("\n")
}

let seq = 0

/** Below `@panel-sm` (40rem) a left-to-right graph is compiled top-down. */
const NARROW_PX = 640
/* ponytail: a floor, not a fit — below 75% of mermaid's own size the labels
   stop being text, so the frame scrolls sideways instead of shrinking further. */
const MIN_SCALE = 0.75

/** `box` is the frame the diagram sits in — the caller's, so a figure wears the
    same surface as whatever it is drawn beside. */
export function MermaidFigure({
  code: wideCode,
  narrowCode,
  caption,
  box = "rounded-md border border-border/50 bg-muted/30",
}: {
  code: string
  /** What to draw when the figure's own width is under `NARROW_PX` — the
      panel's width, never the window's. */
  narrowCode?: string
  caption?: string
  box?: string
}) {
  const figureRef = React.useRef<HTMLElement>(null)
  /* null until measured, so a phone never renders the wide program first. */
  const [narrow, setNarrow] = React.useState<boolean | null>(null)
  const [expanded, setExpanded] = React.useState(false)
  React.useLayoutEffect(() => {
    const el = figureRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < NARROW_PX))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const code = narrowCode && narrow === null ? null : narrow && narrowCode ? narrowCode : wideCode
  const dark = React.useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange)
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
      return () => observer.disconnect()
    },
    () => document.documentElement.classList.contains("dark"),
    () => false
  )
  const [svg, setSvg] = React.useState<string | null>(null)
  /* the diagram's natural width, read off its viewBox */
  const [natural, setNatural] = React.useState(0)
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
    if (code === null) return
    let live = true
    setFailed(false)
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default
        mermaid.initialize({
          startOnLoad: false,
          suppressErrorRendering: true,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
          fontFamily: "inherit",
        })
        const { svg } = await mermaid.render(`openui-diagram-${seq++}`, code)
        if (!live) return
        setSvg(svg)
        setNatural(Number(svg.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+)/)?.[1]) || 0)
      } catch {
        /* Unparseable, or mermaid itself failed to load: the source is the
           answer. */
        if (live) setFailed(true)
      }
    })()
    return () => {
      live = false
    }
  }, [code, dark])

  if (failed) {
    return (
      <pre className="overflow-auto rounded-md border border-border/50 bg-muted/40 px-2.5 py-2 font-mono text-[11.5px] break-words whitespace-pre-wrap text-foreground/90">
        {code}
      </pre>
    )
  }
  return (
    <figure ref={figureRef} className="min-w-0 space-y-1">
      {svg ? (
        /* mermaid's own output, rendered with `securityLevel: "strict"` (it
           sanitises the SVG and strips scripts and click handlers). The width
           is the panel's, never the diagram's. */
        <div
          className={cn(
            "[&_svg]:h-auto [&_svg]:max-w-full [&_svg]:min-w-(--diagram-min) overflow-x-auto overscroll-x-contain px-2 py-2",
            /* a tap on a narrow panel is the way in; a drag still scrolls */
            narrow && "cursor-zoom-in",
            box
          )}
          style={{ "--diagram-min": `${Math.round(natural * MIN_SCALE)}px` } as React.CSSProperties}
          onClick={narrow ? () => setExpanded(true) : undefined}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <Empty size="sm">Drawing diagram…</Empty>
      )}
      {(caption || svg) && (
        <figcaption className="flex items-start gap-2 text-[11px] text-pretty text-muted-foreground">
          <span className="min-w-0 flex-1">{caption}</span>
          {svg && (
            <Dialog open={expanded} onOpenChange={setExpanded}>
              <DialogTrigger
                render={
                  <button
                    type="button"
                    className="flex shrink-0 items-center gap-1 text-muted-foreground/80 transition-colors hover:text-foreground"
                  />
                }
              >
                <Maximize2Icon aria-hidden className="size-3" />
                Full screen
              </DialogTrigger>
              {/* The plan's full-screen frame (`tool-parts.tsx`): nearly the
                  whole window, the same svg at its natural size, scrolling
                  both ways rather than shrinking. */}
              <DialogContent className="flex h-[calc(100svh-2rem)] w-[min(64rem,calc(100vw-1rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[calc(100vw-2rem)]">
                <div className="flex shrink-0 items-center gap-2.5 border-b border-border/40 py-3 pr-12 pl-4">
                  <span
                    aria-hidden
                    className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground/70"
                  >
                    <Network className="size-4" />
                  </span>
                  <DialogTitle className="min-w-0 flex-1 truncate text-sm leading-4 font-medium">
                    {caption || "Diagram"}
                  </DialogTitle>
                </div>
                <div
                  className="flex min-h-0 flex-1 overflow-auto overscroll-contain p-4 [&_svg]:m-auto [&_svg]:shrink-0 [&_svg]:h-auto [&_svg]:w-(--diagram-w) [&_svg]:max-w-none!"
                  style={{ "--diagram-w": `${Math.round(natural)}px` } as React.CSSProperties}
                  dangerouslySetInnerHTML={{ __html: svg }}
                />
              </DialogContent>
            </Dialog>
          )}
        </figcaption>
      )}
    </figure>
  )
}
