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
import { Empty } from "@/components/empty"

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

export function MermaidFigure({ code, caption }: { code: string; caption?: string }) {
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
  const [failed, setFailed] = React.useState(false)

  React.useEffect(() => {
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
        if (live) setSvg(svg)
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
    <figure className="min-w-0 space-y-1">
      {svg ? (
        /* mermaid's own output, rendered with `securityLevel: "strict"` (it
           sanitises the SVG and strips scripts and click handlers). The width
           is the panel's, never the diagram's. */
        <div
          className="[&_svg]:h-auto [&_svg]:max-w-full overflow-x-auto rounded-md border border-border/50 bg-muted/30 px-2 py-2"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <Empty size="sm">Drawing diagram…</Empty>
      )}
      {caption && <figcaption className="text-[11px] text-pretty text-muted-foreground">{caption}</figcaption>}
    </figure>
  )
}
