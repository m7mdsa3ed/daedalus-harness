/* ── Flowchart ──
   A graph written as what it is — nodes and edges — rather than as mermaid
   source: mermaid's syntax is one more thing to get wrong. The figure opens
   into a reader, twice: the one in the panel is a fresh sketch, so an
   arrangement made there is gone on close, the same as a reload. */
import { z } from "zod/v4"
import { Maximize2 } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { Button as UiButton } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { VIEWER } from "@/components/ui/responsive-dialog"
import { Box, META, PAD } from "@/lib/openui/kit"
import { InteractiveFlowchart } from "@/lib/openui/interactive-flowchart"
import { FLOW_ICONS, iconNames } from "@/lib/openui/icons"
import { TONES } from "@/lib/openui/kit"
import { useCoarsePointer } from "@/hooks/use-device"

const graphProps = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      shape: z.enum(["box", "round", "diamond", "circle"]).optional(),
      icon: z.enum(iconNames(FLOW_ICONS)).optional(),
      text: z.string().optional(),
      items: z.array(z.string()).optional(),
      tone: z.enum(TONES).optional(),
    })
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      label: z.string().optional(),
      dashed: z.boolean().optional(),
      tone: z.enum(TONES).optional(),
    })
  ),
  direction: z.enum(["down", "right"]).optional(),
  caption: z.string().optional(),
})

function GraphFigure({ props }: { props: z.infer<typeof graphProps> }) {
  const coarse = useCoarsePointer()
  /* No key on the content: the chart rebuilds itself as a streamed program
     grows, where a remount per chunk flashed the whole canvas. */
  /* A generated node's `tone` is a tint, the chart's `accent`; the chart's own
     `tone` is a run step's state and is never the model's to set. */
  const chart = {
    nodes: props.nodes.map(({ tone, ...node }) => ({ ...node, accent: tone })),
    edges: props.edges,
    direction: props.direction ?? "down",
  } as const
  return (
    <Box
      className={cn("col-span-full w-full self-stretch space-y-1.5", PAD)}
      style={{ gridColumn: "1 / -1", width: "100%", minWidth: 0 }}
    >
      <Dialog>
        <div className="relative rounded-md">
          <InteractiveFlowchart {...chart} />
          <DialogTrigger
            render={<UiButton type="button" variant="outline" size="icon-sm" title="Full screen" className="absolute top-2 right-2 z-10 bg-background" />}
          >
            <Maximize2 aria-hidden />
            <span className="sr-only">Full screen</span>
          </DialogTrigger>
        </div>
        <DialogContent className={VIEWER}>
          <DialogTitle className="sr-only">{props.caption ?? "Flowchart"}</DialogTitle>
          <InteractiveFlowchart {...chart} fill />
        </DialogContent>
      </Dialog>
      {props.caption && <p className={cn(META, "text-pretty px-1")}>{props.caption}</p>}
      <p className={cn(META, "text-pretty px-1")}>
        {coarse
          ? "Open full screen to move, connect or delete nodes."
          : "Drag nodes to move them, or from a node's dot to connect. Delete removes the selection; the reset button restores the layout."}
      </p>
    </Box>
  )
}

export const Flowchart = defineComponent({
  name: "Flowchart",
  description:
    "A flowchart from nodes and edges: each node has an id and a label, each edge joins two ids. A node with an icon, text, items or tone is drawn as a card: a glyph tile, a bold label, a muted sentence and a checklist, tinted by its tone; an edge's tone colours its label as a pill.",
  props: graphProps,
  component: GraphFigure,
})
