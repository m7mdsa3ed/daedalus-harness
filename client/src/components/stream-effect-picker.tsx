/* ── Picking the streaming reveal ──
   The reveal has two halves and they were never both askable: *how fast* a word
   arrives (`streamSpeed`, `lib/stream-pace`) and *what arriving looks like*
   (`streamEffect`, `lib/stream-words`). The pace used to be a constant, and this
   card used to apologise for it in a sentence — "the pacing is the same either
   way". Now it is the row above the tiles, because the two questions are one
   choice and nobody picks a shape for an arrival without an opinion about the
   rate it arrives at.

   Two things follow from putting them together, and they are the whole design:

   • **The samples run off the chosen speed.** Picking Quick speeds every tile
     up, so the speed control previews itself through the same surface the
     effects are previewed on rather than needing a demo of its own.
   • **One clock, not one per tile.** Every sample counts from the same tick, so
     the tiles are comparable — the thing a reader is doing here is looking at
     two of them at once, and nine sentences at nine independent phases is nine
     things moving and nothing to compare. It is also one timer instead of nine
     in a dialog that is often open while a turn streams behind it.

   Calm motion moots the *effect* and not the speed: it is a statement about
   animation, and pacing is not animation. So the tiles freeze and the speed row
   stays live — greying a control that still works would be the lie the note is
   there to avoid.

   The samples are the real CSS — the same `.t-stream-w` spans under the same
   `data-stream` attribute. What they are *not* is the real markdown path: this
   renders words straight, because `lib/stream-words` earns its shape from how
   react-markdown reconciles a tree that is being re-parsed per word, and a
   preview has no tree. The one thing it has to reproduce faithfully is the
   mount/position split (a new key per word, so mount animations mount; `--tail`
   from the same helper, so the edge family ramps), and it takes both from the
   pass's own exports rather than restating them. */
import * as React from "react"

import { STREAM_SPEEDS, sampleStepMs, type StreamSpeed } from "@/lib/stream-pace"
import {
  STREAM_EFFECTS,
  streamWordProps,
  type StreamEffect,
  type StreamFamily,
} from "@/lib/stream-words"
import { cn } from "@/lib/utils"

/** Longer than the ramp, so the edge family is seen *travelling* rather than
 *  just filling: with a sentence shorter than `TAIL_WORDS` every word stays
 *  inside the ramp and the effect looks like a wash that never resolves. */
const SAMPLE = "Each word settles into the answer as the agent writes it out for you."

const WORDS = SAMPLE.split(" ")

/** Which mechanism a tile belongs to, said once above its group. The split is
    real — one family animates each word as it lands, the other keeps a soft
    edge at the end of the text, and the third is neither — and it is the
    difference a reader is actually choosing between. */
const FAMILIES: { id: StreamFamily; label: string }[] = [
  { id: "edge", label: "Travelling edge" },
  { id: "word", label: "Per word" },
  { id: "plain", label: "Nothing added" },
]

/** The beat at full before the sentence starts again. Long enough that the
 *  finished state is legible as a state rather than as a frame between two
 *  runs. */
const HOLD_MS = 1400

/**
 * How many words every sample should have drawn this tick.
 *
 * One clock for the whole card (see the note above). `stepMs` is `null` for
 * `instant`, which has no rate to show — so it shows what it does: the whole
 * sentence at once, held, and again.
 *
 * Restarting when the speed changes is deliberate — switching to Gentle should
 * show Gentle from the beginning rather than from wherever Quick had got to —
 * and `paused` stops the clock outright rather than hiding it, so a frozen card
 * schedules nothing at all.
 */
function useSampleClock(stepMs: number | null, paused: boolean): number {
  const [shown, setShown] = React.useState(0)

  React.useEffect(() => {
    if (paused) return
    let timer = 0
    const tick = () => {
      setShown((prev) => {
        const done = prev >= WORDS.length
        const next = done ? 0 : stepMs === null ? WORDS.length : prev + 1
        timer = window.setTimeout(tick, next === WORDS.length ? HOLD_MS : (stepMs ?? HOLD_MS))
        return next
      })
    }
    timer = window.setTimeout(tick, stepMs ?? HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [stepMs, paused])

  return shown
}

function StreamSample({ effect, shown }: { effect: StreamEffect; shown: number }) {
  return (
    <p
      // The sample is decoration for the tile's label — read as a sentence it
      // says nothing about the choice, and it changes several times a second.
      aria-hidden
      data-stream={effect === "none" ? undefined : effect}
      /* Fixed height and clipped: the sample is three lines at its longest and
         the tiles must not resize as each one fills and restarts. */
      className="h-[42px] overflow-hidden text-[10px] leading-[14px] text-muted-foreground"
    >
      {WORDS.slice(0, shown).map((word, index) => (
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
  shown,
  onSelect,
}: {
  effect: (typeof STREAM_EFFECTS)[number]
  selected: boolean
  frozen: boolean
  shown: number
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
      {frozen ? <p aria-hidden className="h-[42px]" /> : <StreamSample effect={effect.id} shown={shown} />}
    </button>
  )
}

/** The pace, as four segments above the shapes. A segmented control rather than
 *  tiles of its own: these are four points on one axis, and the preview of each
 *  is the card underneath already running at it. */
function SpeedRow({
  value,
  onChange,
}: {
  value: StreamSpeed
  onChange: (speed: StreamSpeed) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Reveal speed"
      className="flex gap-0.5 rounded-lg bg-muted/50 p-0.5"
    >
      {STREAM_SPEEDS.map((speed) => {
        const selected = speed.id === value
        return (
          <button
            key={speed.id}
            type="button"
            role="radio"
            aria-checked={selected}
            title={speed.description}
            onClick={() => onChange(speed.id)}
            className={cn(
              "flex-1 rounded-[7px] px-2 py-1 text-[11px] font-medium transition-colors",
              selected
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {speed.label}
          </button>
        )
      })}
    </div>
  )
}

export function StreamEffectPicker({
  effect: value,
  onEffectChange,
  speed,
  onSpeedChange,
  moot,
}: {
  effect: StreamEffect
  onEffectChange: (effect: StreamEffect) => void
  speed: StreamSpeed
  onSpeedChange: (speed: StreamSpeed) => void
  /** Another option has already settled the *effect* — the tiles say so and stop
      playing, rather than previewing motion that will not happen. The speed is
      untouched by it and stays live. */
  moot?: string
}) {
  const active = STREAM_EFFECTS.find((entry) => entry.id === value)
  const activeSpeed = STREAM_SPEEDS.find((entry) => entry.id === speed)
  const shown = useSampleClock(sampleStepMs(speed), moot !== undefined)

  return (
    <div className="flex flex-col gap-2.5 px-3 py-2.5">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs leading-5 font-medium">Streaming reveal</span>
        <span className="text-[11px] leading-4 text-balance text-muted-foreground">
          How fast a live answer is written out, and what each word's arrival looks like.
        </span>
      </div>

      <SpeedRow value={speed} onChange={onSpeedChange} />
      {activeSpeed && (
        <p className="px-0.5 text-[11px] leading-4 text-balance text-muted-foreground/80">
          {activeSpeed.description}
        </p>
      )}

      <div className={cn("flex flex-col gap-2", moot && "opacity-55")}>
        <div role="radiogroup" aria-label="Streaming reveal" className="flex flex-col gap-2">
          {FAMILIES.map((family) => (
            <div key={family.id} className="flex flex-col gap-1">
              <span className="px-0.5 text-[10px] tracking-wide text-muted-foreground/50 uppercase">
                {family.label}
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {STREAM_EFFECTS.filter((entry) => entry.family === family.id).map((entry) => (
                  <EffectTile
                    key={entry.id}
                    effect={entry}
                    selected={entry.id === value}
                    frozen={moot !== undefined}
                    shown={shown}
                    onSelect={() => onEffectChange(entry.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <p className="px-0.5 text-[11px] leading-4 text-balance text-muted-foreground/80">
          {moot ?? active?.description}
        </p>
      </div>
    </div>
  )
}
