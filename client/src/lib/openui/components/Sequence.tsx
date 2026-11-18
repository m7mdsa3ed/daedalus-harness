/* ── Sequence ──
   A sequence diagram drawn in plain CSS grid, not SVG and not the interactive
   flowchart: actors are columns, messages are rows, and a row's arrow is a grid
   item spanning from one actor's lifeline to the other's. The grid has two
   tracks per actor, so an actor's centre is the line between its two tracks —
   that is what lets an arrow start and stop on a lifeline without measuring
   anything, and what lets the whole thing reflow with the panel.

   A diagram cannot squeeze below a readable column, so under `@panel-sm` the
   scroller inside the frame is what gives (each actor keeps a floor of width)
   rather than the labels. The view streams in: `actors` arrive before any
   message, and a message that names an actor not (yet) listed is skipped, not
   drawn wrong. */
import { z } from "zod/v4"
import { RotateCw } from "lucide-react"
import { defineComponent } from "@openuidev/react-lang"
import { cn } from "@/lib/utils"
import { BODY, Box, META, PAD } from "@/lib/openui/kit"

/** Two tracks per actor: actor `i`'s lifeline is grid line `2i + 2`. */
const mid = (i: number) => 2 * i + 2

function Arrow({ dashed, leftward }: { dashed: boolean; leftward: boolean }) {
  const head = cn(
    "size-0 shrink-0 border-y-4 border-y-transparent text-muted-foreground",
    leftward ? "border-r-[7px] border-r-current" : "border-l-[7px] border-l-current"
  )
  return (
    <div aria-hidden className={cn("flex items-center", leftward && "flex-row-reverse")}>
      <span className={cn("flex-1 border-t border-muted-foreground", dashed && "border-dashed")} />
      <span className={head} />
    </div>
  )
}

export const Sequence = defineComponent({
  name: "Sequence",
  description:
    "A sequence diagram: actors as columns and messages as arrows top to bottom, each a call, a dashed reply or a note over an actor.",
  props: z.object({
    actors: z.array(z.string()),
    messages: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        text: z.string(),
        kind: z.enum(["call", "reply", "note"]).optional(),
      })
    ),
  }),
  component: ({ props }) => {
    const actors = props.actors ?? []
    const n = actors.length
    if (n === 0) return null
    const index = (name: string | undefined) => {
      const key = (name ?? "").trim().toLowerCase()
      return actors.findIndex((a) => a.trim().toLowerCase() === key)
    }
    const columns = { gridTemplateColumns: `repeat(${2 * n}, minmax(0, 1fr))` }

    const rows = (props.messages ?? []).flatMap((m, i) => {
      const a = index(m?.from)
      if (a < 0) return []
      const kind = m.kind ?? "call"
      // A note with no known target sits over its sender alone.
      const b = index(m.to) < 0 && kind === "note" ? a : index(m.to)
      if (b < 0) return []
      const text = m.text ?? ""
      const who = a === b ? actors[a] : `${actors[a]} to ${actors[b]}`

      if (kind === "note" || a === b) {
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        return [
          <li key={i} className="grid" style={columns}>
            {/* A note over one actor hugs its words, centred on the lifeline;
                over several it reaches from the first to the last. */}
            <div className="flex min-w-0 justify-center px-1" style={{ gridColumn: `${2 * lo + 1} / ${2 * hi + 3}` }}>
              <div
                className={cn(
                  META,
                  "flex min-w-0 items-start justify-center gap-1.5 rounded-md bg-muted px-2 py-1 text-center text-foreground",
                  lo === hi ? "w-fit max-w-full" : "w-full"
                )}
              >
                {kind !== "note" && <RotateCw aria-hidden className="mt-[0.3em] size-3 shrink-0 text-muted-foreground" />}
                <span className="sr-only">{kind === "note" ? `Note over ${who}: ` : `${who} to itself: `}</span>
                <span className="min-w-0">{text}</span>
              </div>
            </div>
          </li>,
        ]
      }

      return [
        <li key={i} className="grid" style={columns}>
          <div className="flex min-w-0 flex-col gap-0.5" style={{ gridColumn: `${mid(Math.min(a, b))} / ${mid(Math.max(a, b))}` }}>
            <span className={cn(kind === "reply" ? META : BODY, "px-1 text-center")}>
              <span className="sr-only">{kind === "reply" ? `${who}, reply: ` : `${who}: `}</span>
              {text}
            </span>
            <Arrow dashed={kind === "reply"} leftward={b < a} />
          </div>
        </li>,
      ]
    })

    return (
      <Box>
        <div className="overflow-x-auto">
          <div
            className={cn("min-w-[calc(var(--n)*5.25rem)] @panel-sm:min-w-[calc(var(--n)*8rem)]", PAD)}
            style={{ "--n": n } as React.CSSProperties}
          >
            <div aria-label="Actors" className="grid pb-1" style={columns}>
              {actors.map((actor, i) => (
                <div key={i} className="flex min-w-0 justify-center" style={{ gridColumn: `${2 * i + 1} / span 2` }}>
                  <span className="min-w-0 rounded-md bg-muted px-1.5 py-0.5 text-center text-xs leading-snug font-medium text-foreground [overflow-wrap:anywhere]">
                    {actor}
                  </span>
                </div>
              ))}
            </div>
            <div className="relative">
              <div aria-hidden className="pointer-events-none absolute inset-0 grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
                {actors.map((_, i) => (
                  <span key={i} className="mx-auto h-full w-px border-l border-dashed border-border" />
                ))}
              </div>
              <ol className="relative flex flex-col gap-3 py-2">{rows}</ol>
            </div>
          </div>
        </div>
      </Box>
    )
  },
})
