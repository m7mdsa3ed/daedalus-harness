/* ── Picking the streaming reveal ──
   The one view option that is not a switch, so it is not a row with a Switch on
   the end: the choice is between shapes, and a shape cannot be read off its
   name. Four tiles, each running the effect it names on a loop, so the control
   is the thing it controls.

   The samples are the real CSS — the same `.t-stream-w` spans under the same
   `data-stream` attribute — driven by a timer instead of by a turn. What they
   are *not* is the real markdown path: this renders words straight, because
   `lib/stream-words` earns its shape from how react-markdown reconciles a tree
   that is being re-parsed per word, and a preview has no tree. The one thing it
   has to reproduce faithfully is the mount/position split (a new key per word,
   so mount animations mount; `--tail` from the same helper, so the sweep ramps),
   and it takes both from the pass's own exports rather than restating them. */
import * as React from "react"

import { cn } from "@/lib/utils"
import {
  STREAM_EFFECTS,
  streamWordProps,
  type StreamEffect,
  type StreamFamily,
} from "@/lib/stream-words"

/** Longer than the ramp, so the edge family is seen *travelling* rather than
 *  just filling: with a sentence shorter than `TAIL_WORDS` every word stays
 *  inside the ramp and the effect looks like a wash that never resolves. */
const SAMPLE = "Each word settles into the answer as the agent writes it out for you."

/** Which mechanism a tile belongs to, said once above its group. The split is
    real — one family animates each word as it lands, the other keeps a soft
    edge at the end of the text — and it is the difference a reader is actually
    choosing between. */
const FAMILIES: { id: StreamFamily; label: string }[] = [
  { id: "edge", label: "Travelling edge" },
  { id: "word", label: "Per word" },
]

/** A word every `STEP`, then a beat at full before it starts again. Slower than
 *  a real turn on purpose: the tile is being *read*, not kept up with. */
const STEP_MS = 130
const HOLD_MS = 1400

function StreamSample({ effect }: { effect: StreamEffect }) {
  const words = React.useMemo(() => SAMPLE.split(" "), [])
  const [shown, setShown] = React.useState(0)

  React.useEffect(() => {
    let timer = 0
    const tick = () => {
      setShown((prev) => {
        const next = prev >= words.length ? 0 : prev + 1
        timer = window.setTimeout(tick, next === words.length ? HOLD_MS : STEP_MS)
        return next
      })
    }
    timer = window.setTimeout(tick, STEP_MS)
    return () => window.clearTimeout(timer)
    // Restarting on the effect is deliberate: switching tiles should show the
    // new one from the beginning rather than mid-sentence.
  }, [words, effect])

  return (
    <p
      // The sample is decoration for the tile's label — read as a sentence it
      // says nothing about the choice, and it changes every 130ms.
      aria-hidden
      data-stream={effect === "none" ? undefined : effect}
      /* Fixed height and clipped: the sample is three lines at its longest and
         the tiles must not resize as each one fills and restarts. */
      className="h-[42px] overflow-hidden text-[10px] leading-[14px] text-muted-foreground"
    >
      {words.slice(0, shown).map((word, index) => (
        <React.Fragment key={index}>
          <span className="t-stream-w" {...streamWordProps(effect, shown - 1 - index)}>
            {word}
          </span>{" "}
        </React.Fragment>
      ))}
    </p>
  )
}

function EffectTile({
  effect,
  selected,
  frozen,
  onSelect,
}: {
  effect: (typeof STREAM_EFFECTS)[number]
  selected: boolean
  frozen: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={frozen}
      title={effect.description}
      onClick={onSelect}
      className={cn(
        "flex flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors",
        selected ? "border-primary/50 bg-primary/[0.06]" : "border-border/60 hover:bg-muted/40",
        frozen && "pointer-events-none"
      )}
    >
      <span
        className={cn(
          "text-[11px] font-medium",
          selected ? "text-primary" : "text-muted-foreground"
        )}
      >
        {effect.label}
      </span>
      {/* Frozen rather than unmounted: the tile keeps its height, so the card
          does not resize when calm motion is flipped. */}
      {frozen ? <p aria-hidden className="h-[42px]" /> : <StreamSample effect={effect.id} />}
    </button>
  )
}

export function StreamEffectPicker({
  value,
  onChange,
  moot,
}: {
  value: StreamEffect
  onChange: (effect: StreamEffect) => void
  /** Another option has already settled this one — the tiles say so and stop
      playing, rather than previewing motion that will not happen. */
  moot?: string
}) {
  const active = STREAM_EFFECTS.find((effect) => effect.id === value)

  return (
    <div className={cn("flex flex-col gap-2 px-3 py-2.5", moot && "opacity-55")}>
      <div className="flex flex-col gap-0.5">
        <span className="text-xs leading-5 font-medium">Streaming reveal</span>
        <span className="text-[11px] leading-4 text-balance text-muted-foreground">
          {moot ??
            "How a live answer resolves as it is written. The pacing is the same either way — this is only what arriving looks like."}
        </span>
      </div>
      <div role="radiogroup" aria-label="Streaming reveal" className="flex flex-col gap-2">
        {FAMILIES.map((family) => (
          <div key={family.id} className="flex flex-col gap-1">
            <span className="px-0.5 text-[10px] tracking-wide text-muted-foreground/50 uppercase">
              {family.label}
            </span>
            <div className="grid grid-cols-2 gap-1.5">
              {STREAM_EFFECTS.filter((effect) => effect.family === family.id).map((effect) => (
                <EffectTile
                  key={effect.id}
                  effect={effect}
                  selected={effect.id === value}
                  frozen={moot !== undefined}
                  onSelect={() => onChange(effect.id)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {active && !moot && (
        <p className="px-0.5 text-[11px] leading-4 text-balance text-muted-foreground/80">
          {active.description}
        </p>
      )}
    </div>
  )
}
